import os
import json
import asyncio
import uuid
import logging

import httpx
from openai import AsyncOpenAI
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from sse_starlette.sse import EventSourceResponse

from prompts import DECOMPOSITION_SYSTEM_PROMPT, SYNTHESIS_SYSTEM_PROMPT, NUM_AGENTS

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("grasstoucher")

# ── Config ────────────────────────────────────────────────────────────────────
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

TINYFISH_API_KEY = os.getenv("TINYFISH_API_KEY", "")
TINYFISH_SSE_URL = "https://agent.tinyfish.ai/v1/automation/run-sse"
OPENAI_MODEL = "gpt-5.4"

openai_client = AsyncOpenAI()  # reads OPENAI_API_KEY from env automatically

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory run storage ─────────────────────────────────────────────────────
# Each agent stores a history of all events so late-connecting subscribers
# can replay them, plus a list of live subscriber queues for real-time fan-out.

runs: dict[str, dict] = {}


class RunRequest(BaseModel):
    prompt: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/runs")
async def create_run(body: RunRequest):
    """
    1. Use OpenAI to decompose the user's prompt into 4 {url, goal} pairs.
    2. Store the run with 4 agent queues.
    3. Spawn 4 background tasks that stream from TinyFish → queue.
    """
    logger.info("Creating run — decomposing prompt via OpenAI…")
    tasks = await _decompose_prompt(body.prompt)
    logger.info("Decomposition complete: %s", json.dumps(tasks, indent=2))

    run_id = uuid.uuid4().hex[:8]
    agents = []
    for i, task in enumerate(tasks):
        agents.append({
            "id": i,
            "url": task["url"],
            "goal": task["goal"],
            "subscribers": [],
            "history": [],
            "done": False,
            "result": None,
            "task": None,  # asyncio.Task ref stored after creation
        })

    runs[run_id] = {
        "prompt": body.prompt,
        "agents": agents,
        "synthesis": None,
        "synthesis_started": False,
    }

    # Spawn all agent streams in parallel and store their task refs so we can
    # cancel them later if the user triggers forced synthesis.
    for i, task in enumerate(tasks):
        t = asyncio.create_task(
            _stream_agent(run_id, i, task["url"], task["goal"])
        )
        agents[i]["task"] = t

    logger.info("Run %s created — 4 agents spawned", run_id)

    return {
        "run_id": run_id,
        "agents": [{"url": a["url"], "goal": a["goal"]} for a in agents],
    }


@app.get("/runs/{run_id}/agents/{agent_id}/stream")
async def agent_stream(run_id: str, agent_id: int):
    """SSE endpoint that fans out TinyFish events for one agent to the browser."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    if agent_id < 0 or agent_id >= len(runs[run_id]["agents"]):
        raise HTTPException(status_code=404, detail="Agent not found")

    agent = runs[run_id]["agents"][agent_id]

    # Create a dedicated queue for this subscriber
    queue: asyncio.Queue = asyncio.Queue()

    # Replay all historical events so the subscriber catches up on anything
    # that was broadcast before they connected (fixes the race condition where
    # the frontend opens EventSource after _stream_agent already started).
    for past_event in agent["history"]:
        await queue.put(past_event)

    if agent["done"]:
        await queue.put({"type": "DONE"})

    agent["subscribers"].append(queue)

    logger.info("Subscriber connected: run=%s agent=%d (replayed %d events)",
                run_id, agent_id, len(agent["history"]))

    async def event_generator():
        try:
            while True:
                event = await queue.get()
                if event.get("type") == "DONE":
                    yield {"data": json.dumps(event)}
                    break
                yield {"data": json.dumps(event)}
        finally:
            if queue in agent["subscribers"]:
                agent["subscribers"].remove(queue)

    return EventSourceResponse(event_generator())


@app.get("/runs/{run_id}/synthesis")
async def get_synthesis(run_id: str):
    """Polling endpoint for the synthesis result."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    synthesis = runs[run_id]["synthesis"]
    if synthesis is None:
        return {"status": "pending"}
    return {"status": "complete", "result": synthesis}


@app.post("/runs/{run_id}/synthesise")
async def force_synthesise(run_id: str):
    """Trigger synthesis immediately with whatever agent results are available.
    Safe to call multiple times — a second call is a no-op if synthesis has
    already started or completed."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = runs[run_id]

    # Idempotency guard: don't re-run if already in progress or done.
    # We use a dedicated flag so concurrent requests can't race past this check.
    if run.get("synthesis_started"):
        return {"status": "already_started"}

    run["synthesis_started"] = True
    logger.info("Force-synthesise requested for run %s", run_id)

    # Cancel any agents still streaming from TinyFish to free up their
    # browser slots. asyncio.Task.cancel() raises CancelledError inside the
    # coroutine; the finally block in _stream_agent handles cleanup.
    for agent in run["agents"]:
        if not agent["done"] and agent["task"] is not None:
            agent["task"].cancel()
            logger.info("Cancelled agent %d (still running)", agent["id"])

    asyncio.create_task(_run_synthesis(run_id))
    return {"status": "started"}


# ── Internal helpers ──────────────────────────────────────────────────────────

async def _decompose_prompt(prompt: str) -> list[dict]:
    """Call OpenAI to split a user prompt into 4 {url, goal} pairs."""
    response = await openai_client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[
            {"role": "system", "content": DECOMPOSITION_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        temperature=0.3,
    )

    raw = response.choices[0].message.content.strip()

    # Strip markdown code fences if the model wraps the JSON
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1]
        raw = raw.rsplit("```", 1)[0]

    tasks = json.loads(raw)

    if not isinstance(tasks, list) or len(tasks) != NUM_AGENTS:
        raise HTTPException(
            status_code=500,
            detail=f"Decomposition returned {len(tasks) if isinstance(tasks, list) else 'non-list'} tasks instead of {NUM_AGENTS}",
        )

    return tasks


async def _broadcast(agent: dict, event: dict):
    """Push an event to the history and to every live subscriber queue."""
    # Persist in history so late-joiners can replay
    agent["history"].append(event)
    for q in agent["subscribers"]:
        await q.put(event)


async def _stream_agent(run_id: str, agent_idx: int, url: str, goal: str):
    """
    Connect to TinyFish SSE, parse events, and fan them out to subscribers.
    When this agent finishes, check if all 4 are done and trigger synthesis.
    """
    agent = runs[run_id]["agents"][agent_idx]
    logger.info("Agent %d starting: url=%s", agent_idx, url)

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(300.0, connect=30.0)
        ) as client:
            async with client.stream(
                "POST",
                TINYFISH_SSE_URL,
                headers={
                    "X-API-Key": TINYFISH_API_KEY,
                    "Content-Type": "application/json",
                },
                json={"url": url, "goal": goal},
            ) as resp:
                logger.info("Agent %d connected to TinyFish (status %d)", agent_idx, resp.status_code)
                if resp.status_code != 200:
                    body = await resp.aread()
                    logger.error("Agent %d TinyFish error: %s", agent_idx, body.decode())
                    await _broadcast(agent, {
                        "type": "ERROR",
                        "message": f"TinyFish returned {resp.status_code}: {body.decode()[:500]}",
                    })
                    return

                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("data: "):
                        payload = line[6:]
                        try:
                            event = json.loads(payload)
                            event_type = event.get("type", "UNKNOWN")
                            logger.info("Agent %d event: %s", agent_idx, event_type)

                            if event_type == "STREAMING_URL":
                                logger.info("Agent %d streaming URL: %s", agent_idx, event.get("streaming_url"))

                            await _broadcast(agent, event)

                            if event_type == "COMPLETE":
                                agent["result"] = event.get("result")
                        except json.JSONDecodeError:
                            logger.warning("Agent %d bad JSON: %s", agent_idx, payload[:200])
    except asyncio.CancelledError:
        # Raised intentionally by force_synthesise — not an error.
        logger.info("Agent %d cancelled (force-synthesise)", agent_idx)
    except Exception as exc:
        logger.exception("Agent %d failed: %s", agent_idx, exc)
        await _broadcast(agent, {
            "type": "ERROR",
            "message": str(exc),
        })
    finally:
        agent["done"] = True
        await _broadcast(agent, {"type": "DONE"})
        logger.info("Agent %d finished", agent_idx)

    # If all agents are done and synthesis hasn't been started yet, trigger it.
    # The synthesis_started flag prevents a double-run when force_synthesise
    # was already called mid-flight by the user.
    run = runs[run_id]
    all_done = all(a["done"] for a in run["agents"])
    if all_done and not run.get("synthesis_started"):
        run["synthesis_started"] = True
        logger.info("All agents done for run %s — starting synthesis", run_id)
        asyncio.create_task(_run_synthesis(run_id))


async def _run_synthesis(run_id: str):
    """Collect all 4 agent results and ask OpenAI to synthesize them."""
    run = runs[run_id]
    agent_results = []
    for i, agent in enumerate(run["agents"]):
        agent_results.append({
            "agent": i + 1,
            "url": agent["url"],
            "goal": agent["goal"],
            "result": agent["result"],
        })

    user_content = (
        f"Original prompt:\n{run['prompt']}\n\n"
        f"Agent results:\n{json.dumps(agent_results, indent=2, default=str)}"
    )

    try:
        logger.info("Run %s: calling OpenAI for synthesis…", run_id)
        response = await openai_client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": SYNTHESIS_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0.4,
        )
        synthesis = response.choices[0].message.content
        logger.info("Run %s: synthesis complete", run_id)
    except Exception as exc:
        logger.exception("Run %s: synthesis failed", run_id)
        synthesis = f"Synthesis failed: {exc}"

    run["synthesis"] = synthesis

    # Notify all still-connected subscribers on every agent channel
    synthesis_event = {"type": "SYNTHESIS_COMPLETE", "result": synthesis}
    for agent in run["agents"]:
        await _broadcast(agent, synthesis_event)
