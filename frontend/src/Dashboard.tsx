import { useEffect, useRef, useState, useCallback } from "react";
import { YCIcon, type AgentConfig } from "./App";
import "./Dashboard.css";

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentEvent {
  type: string;
  purpose?: string;
  message?: string;
  [key: string]: unknown;
}

interface AgentState {
  id: number;
  url: string;
  goal: string;
  status: "pending" | "running" | "complete" | "error";
  streamingUrl: string | null;
  events: AgentEvent[];
  result: unknown | null;
}

// Structured LLM analysis returned by POST /api/analyse-idea
interface LLMMetric {
  score?: number;
  verdict?: string;
  risk?: string;
  annual_revenue_1pct?: string;
  proposed_model?: string;
  reasoning: string;
}

interface LLMAnalysis {
  desperation_score: LLMMetric;
  ghost_town_check: LLMMetric;
  buildability: LLMMetric;
  kill_factor: LLMMetric;
  the_prize_tam: LLMMetric;
  sustainability: LLMMetric;
}

// Final output: one build spec per top idea, produced by the final synthesis LLM.
export interface BuildSpec {
  title: string;
  whatToBuild: string;
  expectedUser: string;
  additionalContext: string;
}

function isBuildSpec(value: unknown): value is BuildSpec {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.title === "string"
    && typeof candidate.whatToBuild === "string"
    && typeof candidate.expectedUser === "string"
    && typeof candidate.additionalContext === "string";
}

function extractBuildSpecs(payload: unknown): BuildSpec[] {
  if (Array.isArray(payload)) {
    return payload.filter(isBuildSpec);
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = payload as Record<string, unknown>;
  const candidates = [
    data.buildSpecs,
    data.build_specs,
    data.specs,
    data.buildSpec,
    data.build_spec,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isBuildSpec);
    }
    if (isBuildSpec(candidate)) {
      return [candidate];
    }
  }

  return [];
}

interface PermissionRequest {
  id: string;
  message: string;
}

type PrototypeStatus = "starting" | "running" | "awaiting_approval" | "completed" | "failed";

interface PrototypeSession {
  sessionId: string;
  title: string;
  status: PrototypeStatus;
  summary: string;
  previewUrl: string;
  pendingPermission: PermissionRequest | null;
}

interface DashboardProps {
  runId: string;
  agents: AgentConfig[];
  prompt: string;
  phase: "discovery" | "iteration";
  onBack: () => void;
  onIterate?: (ideas: IdeaData[]) => void;
  // When in iteration phase, the original ideas are passed back so the sidebar
  // can show compact idea cards instead of raw agent goals.
  iterationIdeas?: IdeaData[];
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard({ runId, agents, prompt, phase, onBack, onIterate, iterationIdeas }: DashboardProps) {
  const [agentStates, setAgentStates] = useState<AgentState[]>(() =>
    agents.map((a, i) => ({
      id: i, url: a.url, goal: a.goal,
      status: "pending", streamingUrl: null, events: [], result: null,
    }))
  );
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [synthesis, setSynthesis] = useState<string | null>(null);
  // "agents" = main view; "synthesis" = full-screen synthesis panel; "buildSpecs" = final output
  const [view, setView] = useState<"agents" | "synthesis" | "buildSpecs">("agents");
  // "focus" = sidebar + single agent detail; "grid" = all agents in a grid
  const [layout, setLayout] = useState<"focus" | "grid">("focus");

  // Final build specs — top 4 ideas distilled into actionable specs.
  const [buildSpecs, setBuildSpecs] = useState<BuildSpec[] | null>(null);
  const [prototypeSessions, setPrototypeSessions] = useState<PrototypeSession[]>([]);
  const [prototypePanelOpen, setPrototypePanelOpen] = useState(false);
  const [prototypeStarting, setPrototypeStarting] = useState(false);

  // Per-agent LLM analysis results (iteration phase only).
  // Keyed by agent id. Each entry is null (pending), "loading", or the parsed analysis object.
  const [llmReports, setLlmReports] = useState<Record<number, LLMAnalysis | "loading" | null>>({});

  const [splitPct, setSplitPct] = useState(65);
  const rightPanelRef = useRef<HTMLElement>(null);
  const dragging = useRef(false);
  const streamEndRef = useRef<HTMLDivElement>(null);
  const prototypeStreamsRef = useRef<Record<string, EventSource>>({});
  const prototypeRefreshTimersRef = useRef<Record<string, number>>({});
  const prototypeStartedRef = useRef(false);

  // ── SSE connections ───────────────────────────────────────────────────────
  useEffect(() => {
    const sources: EventSource[] = [];

    for (let i = 0; i < agents.length; i++) {
      const agentIdx = i;
      const es = new EventSource(`/api/runs/${runId}/agents/${agentIdx}/stream`);

      es.onopen = () => console.log(`[agent ${agentIdx}] opened`);

      es.onmessage = (msg) => {
        try {
          const event: AgentEvent = JSON.parse(msg.data);
          console.log(`[agent ${agentIdx}] event:`, event.type, event);

          if (event.type === "DONE") {
            // Mark non-complete agents as "error" so allDone checks resolve.
            // This covers agents cancelled by "Skip remaining" or force-synthesis,
            // where the backend sends DONE without a preceding COMPLETE event.
            setAgentStates((prev) => {
              const next = [...prev];
              if (next[agentIdx] && next[agentIdx].status !== "complete") {
                next[agentIdx] = { ...next[agentIdx], status: "error" };
              }
              return next;
            });
            es.close();
            return;
          }

          if (event.type === "SYNTHESIS_COMPLETE") {
            setSynthesis(event.result as string);
            return;
          }

          setAgentStates((prev) => {
            const next = [...prev];
            const agent = { ...next[agentIdx] };
            switch (event.type) {
              case "STARTED":    agent.status = "running"; break;
              case "STREAMING_URL": agent.streamingUrl = (event as { streaming_url?: string }).streaming_url ?? null; break;
              case "PROGRESS":   agent.events = [...agent.events, event]; break;
              case "COMPLETE":   agent.result = event.result ?? event; agent.status = "complete"; break;
              case "ERROR":      agent.status = "error"; agent.events = [...agent.events, event]; break;
            }
            next[agentIdx] = agent;
            return next;
          });
        } catch (err) {
          console.error(`[agent ${agentIdx}] parse error:`, err);
        }
      };

      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          setAgentStates((prev) => {
            const next = [...prev];
            if (next[agentIdx].status !== "complete")
              next[agentIdx] = { ...next[agentIdx], status: "error" };
            return next;
          });
        }
      };

      sources.push(es);
    }
    return () => sources.forEach((s) => s.close());
  }, [runId]);

  // Auto-scroll stream panel
  const selected = agentStates[selectedAgent];
  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [selected.events.length, selected.result, synthesis]);

  const stripAnsi = useCallback((input: string): string => {
    return input.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
  }, []);

  const summarizeOutputChunk = useCallback((text: string): string | null => {
    const lines = stripAnsi(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line || /^(\d+\/\d+|token|at\s+\S)/i.test(line)) continue;
      if (/permission|approve|deny/i.test(line)) return "Waiting for approval to continue.";
      if (/write|edit|create|update|patch/i.test(line)) return "Generating and refining prototype files.";
      if (/build|compile|test|npm|pnpm|yarn|run/i.test(line)) return "Running project commands and checks.";
      if (/done|completed|finished/i.test(line)) return "Finalizing generated prototype output.";
      return line.length > 140 ? `${line.slice(0, 137)}...` : line;
    }
    return null;
  }, [stripAnsi]);

  // Auto-navigate to synthesis view once every agent is done (discovery only).
  // Iteration phase has no auto-synthesis — agents complete and results stay visible.
  useEffect(() => {
    if (phase === "iteration") return;
    const allDone = agentStates.every(
      (a) => a.status === "complete" || a.status === "error"
    );
    if (allDone && agentStates.length > 0) {
      setView("synthesis");
    }
  }, [agentStates, phase]);

  // Poll for synthesis result when on the synthesis view without a result.
  // The SYNTHESIS_COMPLETE SSE event is broadcast AFTER all agents' DONE events,
  // which means all EventSources are already closed by the time it arrives.
  // Polling the dedicated endpoint is the reliable fallback.
  useEffect(() => {
    if (view !== "synthesis" || synthesis !== null) return;

    let stopped = false;
    const interval = setInterval(async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/runs/${runId}/synthesis`);
        if (res.status === 404) {
          // Run no longer exists (backend restarted) — stop polling
          stopped = true;
          clearInterval(interval);
          return;
        }
        const data = await res.json();
        if (data.status === "complete") {
          setSynthesis(data.result);
        }
      } catch {
        // Network error — keep polling
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [view, synthesis, runId]);

  // Auto-trigger LLM analysis when an iteration agent completes.
  // Each completed agent's TinyFish result is sent to POST /api/analyse-idea,
  // producing the Brutal VC Partner verdict alongside the raw research.
  useEffect(() => {
    if (phase !== "iteration") return;

    for (const agent of agentStates) {
      // Only fire once per agent: when it first reaches "complete" with a result,
      // and we haven't already started an analysis for it.
      if (agent.status !== "complete" || !agent.result) continue;
      if (llmReports[agent.id] !== undefined) continue;

      // Mark as loading so we don't re-trigger
      setLlmReports((prev) => ({ ...prev, [agent.id]: "loading" }));

      // Extract the idea name from the agent's goal (after "startup idea: ")
      const ideaMatch = agent.goal.match(/startup idea:\s*(.+?),\s*find/i);
      const idea = ideaMatch ? ideaMatch[1] : `Agent ${agent.id + 1}`;

      fetch("/api/analyse-idea", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idea,
          tinyfish_report: typeof agent.result === "string"
            ? agent.result
            : JSON.stringify(agent.result, null, 2),
        }),
      })
        .then((res) => res.json())
        .then((data) => {
          setLlmReports((prev) => ({ ...prev, [agent.id]: data.analysis }));
      })
        .catch((err) => {
          console.error(`LLM analysis failed for agent ${agent.id}:`, err);
          setLlmReports((prev) => ({ ...prev, [agent.id]: null }));
        });
    }
  }, [agentStates, phase, llmReports]);

  const closePrototypeStream = useCallback((sessionId: string) => {
    const stream = prototypeStreamsRef.current[sessionId];
    if (stream) {
      stream.close();
      delete prototypeStreamsRef.current[sessionId];
    }
    const timer = prototypeRefreshTimersRef.current[sessionId];
    if (timer) {
      window.clearInterval(timer);
      delete prototypeRefreshTimersRef.current[sessionId];
    }
  }, []);

  const updatePrototypeSession = useCallback((sessionId: string, patch: Partial<PrototypeSession>) => {
    setPrototypeSessions((prev) =>
      prev.map((session) => (session.sessionId === sessionId ? { ...session, ...patch } : session))
    );
  }, []);

  const startPrototypeStream = useCallback((sessionId: string) => {
    closePrototypeStream(sessionId);
    const es = new EventSource(`/api/webbuilder/sessions/${sessionId}/stream`);
    prototypeStreamsRef.current[sessionId] = es;

    es.addEventListener("session", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        status: string;
        pendingPermission: PermissionRequest | null;
        previewUrl: string | null;
      };
      const mappedStatus: PrototypeStatus =
        payload.status === "completed" ? "completed"
          : payload.status === "failed" ? "failed"
            : payload.pendingPermission ? "awaiting_approval"
              : "running";
      updatePrototypeSession(sessionId, {
        status: mappedStatus,
        pendingPermission: payload.pendingPermission,
        previewUrl: payload.previewUrl ?? `/api/webbuilder/sessions/${sessionId}/preview/index.html`,
      });
    });

    es.addEventListener("output", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { text: string };
      const summary = summarizeOutputChunk(payload.text);
      if (summary) updatePrototypeSession(sessionId, { summary });
    });

    es.addEventListener("permission_request", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as PermissionRequest;
      updatePrototypeSession(sessionId, {
        pendingPermission: payload,
        status: "awaiting_approval",
        summary: "Waiting for approval to continue.",
      });
    });

    es.addEventListener("permission_result", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { decision: string };
      updatePrototypeSession(sessionId, {
        pendingPermission: null,
        status: "running",
        summary: `Permission ${payload.decision.toUpperCase()} sent.`,
      });
    });

    es.addEventListener("session_error", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { message: string };
      updatePrototypeSession(sessionId, {
        status: "failed",
        summary: `Error: ${payload.message}`,
      });
      closePrototypeStream(sessionId);
    });

    es.addEventListener("done", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        status: "completed" | "failed";
        previewUrl: string | null;
      };
      updatePrototypeSession(sessionId, {
        status: payload.status === "completed" ? "completed" : "failed",
        pendingPermission: null,
        previewUrl: payload.previewUrl ?? `/api/webbuilder/sessions/${sessionId}/preview/index.html`,
        summary: payload.status === "completed"
          ? "Prototype is ready in preview."
          : "Prototype generation failed.",
      });
      closePrototypeStream(sessionId);
    });

    es.onerror = () => {
      updatePrototypeSession(sessionId, {
        status: "failed",
        summary: "Stream connection interrupted.",
      });
      closePrototypeStream(sessionId);
    };

    prototypeRefreshTimersRef.current[sessionId] = window.setInterval(() => {
      updatePrototypeSession(sessionId, {
        previewUrl: `/api/webbuilder/sessions/${sessionId}/preview/index.html?t=${Date.now()}`,
      });
    }, 3000);
  }, [closePrototypeStream, summarizeOutputChunk, updatePrototypeSession]);

  const respondPrototypePermission = useCallback(async (sessionId: string, decision: "approve" | "deny") => {
    try {
      const res = await fetch(`/api/webbuilder/sessions/${sessionId}/permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ detail: "Failed to send decision." }));
        updatePrototypeSession(sessionId, { summary: `Permission error: ${payload.detail ?? payload.error ?? "Failed."}` });
      }
    } catch (err) {
      updatePrototypeSession(sessionId, { summary: `Network error: ${(err as Error).message}` });
    }
  }, [updatePrototypeSession]);

  const startPrototypeGeneration = useCallback(async (specs: BuildSpec[]) => {
    if (!specs.length || prototypeStartedRef.current) return;
    prototypeStartedRef.current = true;
    setPrototypeStarting(true);
    setPrototypePanelOpen(true);

    try {
      const res = await fetch("/api/webbuilder/sessions/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: specs }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ detail: "Failed to start WebBuilder sessions." }));
        throw new Error(payload.detail ?? payload.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as { sessions: Array<{ sessionId: string; title: string }> };
      const initial = data.sessions.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        status: "starting" as PrototypeStatus,
        summary: "Session starting up.",
        previewUrl: `/api/webbuilder/sessions/${s.sessionId}/preview/index.html?t=${Date.now()}`,
        pendingPermission: null,
      }));
      setPrototypeSessions(initial);
      for (const session of data.sessions) {
        startPrototypeStream(session.sessionId);
      }
    } catch (err) {
      console.error("Failed to start prototype generation:", err);
      setPrototypeSessions([{
        sessionId: "error",
        title: "Prototype generation failed",
        status: "failed",
        summary: (err as Error).message,
        previewUrl: "",
        pendingPermission: null,
      }]);
    } finally {
      setPrototypeStarting(false);
    }
  }, [startPrototypeStream]);

  useEffect(() => {
    return () => {
      for (const id of Object.keys(prototypeStreamsRef.current)) closePrototypeStream(id);
    };
  }, [closePrototypeStream]);

  useEffect(() => {
    prototypeStartedRef.current = false;
    setPrototypeSessions([]);
    setPrototypePanelOpen(false);
    setPrototypeStarting(false);
    for (const id of Object.keys(prototypeStreamsRef.current)) closePrototypeStream(id);
  }, [runId, closePrototypeStream]);

  // ── Drag-to-resize ────────────────────────────────────────────────────────
  const onDividerPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !rightPanelRef.current) return;
    const rect = rightPanelRef.current.getBoundingClientRect();
    const pct = Math.min(85, Math.max(15, ((e.clientY - rect.top) / rect.height) * 100));
    setSplitPct(pct);
  }, []);

  const onPointerUp = useCallback(() => { dragging.current = false; }, []);

  // Auto-trigger iteration once synthesis produces ideas (discovery phase only).
  // This removes the manual "Research these ideas" step — the pipeline is fully
  // automated from prompt → discovery agents → synthesis → iteration agents.
  const synthesisTriggered = useRef(false);
  useEffect(() => {
    if (phase !== "discovery" || !synthesis || !onIterate || synthesisTriggered.current) return;

    try {
      const parsed = JSON.parse(synthesis);
      if (Array.isArray(parsed) && parsed.length > 0) {
        synthesisTriggered.current = true;
        // Brief pause so the user sees "Synthesised" before the transition
        setTimeout(() => onIterate(parsed as IdeaData[]), 1500);
      }
    } catch { /* parse error — will show in synthesis view below */ }
  }, [synthesis, phase, onIterate]);

  // Auto-trigger final synthesis once ALL iteration LLM analyses have completed.
  // Collects each idea's TinyFish report + VC analysis and sends to POST /api/final-synthesis
  // to produce the top 4 build specs.
  const finalSynthTriggered = useRef(false);
  useEffect(() => {
    if (phase !== "iteration" || !iterationIdeas || finalSynthTriggered.current) return;

    // Check that every agent is done AND every LLM analysis has resolved
    const allAgentsDone = agentStates.length > 0 && agentStates.every(
      (a) => a.status === "complete" || a.status === "error"
    );
    if (!allAgentsDone) return;

    // Every completed agent should have a finished LLM report (not "loading", not undefined)
    const allLlmDone = agentStates.every((a) => {
      if (a.status !== "complete" || !a.result) return true; // errored/no-result agents are skipped
      const report = llmReports[a.id];
      return report !== undefined && report !== "loading";
    });
    if (!allLlmDone) return;

    finalSynthTriggered.current = true;

    // Build the payload: one entry per idea that has both a TinyFish result and an LLM analysis
    const ideas = iterationIdeas
      .map((idea, i) => {
        const agent = agentStates[i];
        const report = llmReports[i];
        if (!agent?.result || !report || report === "loading") return null;
        return {
          title: idea.title,
          what_to_build: idea.what_to_build,
          tinyfish_report: typeof agent.result === "string"
            ? agent.result
            : JSON.stringify(agent.result, null, 2),
          vc_analysis: report as unknown as Record<string, unknown>,
        };
      })
      .filter(Boolean);

    fetch("/api/final-synthesis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ideas }),
    })
      .then(async (res) => {
        const data = await res.json();
        console.log("[final-synthesis] raw response:", data);
        if (!res.ok) {
          throw new Error(data.detail ?? `Final synthesis failed: ${res.status}`);
        }
        return data;
      })
      .then((data) => {
        const specs = extractBuildSpecs(data);
        console.log("[final-synthesis] extracted build specs:", specs);
        if (specs.length === 0) {
          throw new Error(`Final synthesis returned no build specs: ${JSON.stringify(data).slice(0, 500)}`);
        }
        setBuildSpecs(specs);
        setView("buildSpecs");
      })
      .catch((err) => {
        console.error("Final synthesis failed:", err);
        alert("Final synthesis returned no usable build specs. Check the backend response.");
      });
  }, [phase, agentStates, llmReports, iterationIdeas]);

  useEffect(() => {
    if (!buildSpecs || buildSpecs.length === 0 || prototypeStartedRef.current) return;
    void startPrototypeGeneration(buildSpecs);
  }, [buildSpecs, startPrototypeGeneration]);

  // ── Build Specs view — final output: top 4 concrete build specs ────────────
  if (view === "buildSpecs") {
    return (
      <div className="dashboard">
        <header className="dashboard-header">
          <button className="back-btn" onClick={() => setView("agents")} aria-label="Back to agents"><ArrowLeftIcon /></button>
          <div className="wordmark compact"><YCIcon /><span style={{ color: 'var(--orange-primary)', fontWeight: 'bold' }}>GoTouchGrass</span></div>
          <p className="header-prompt synthesis-header-label">
            {buildSpecs ? "Build Specs — Top 4" : "Generating build specs…"}
          </p>
        </header>
        <div className={`synthesis-full-panel buildspecs-shell ${prototypePanelOpen ? "builder-open" : "builder-collapsed"}`}>
          {buildSpecs ? (
            <>
              <div className="buildspecs-main">
                <BuildSpecsView specs={buildSpecs} />
              </div>
              <aside className={`prototype-side-panel ${prototypePanelOpen ? "open" : "closed"}`}>
                <button
                  className="prototype-side-toggle"
                  onClick={() => setPrototypePanelOpen((v) => !v)}
                  aria-expanded={prototypePanelOpen}
                >
                  {prototypePanelOpen ? "Hide Prototype Builder" : "Show Prototype Builder"}
                </button>
                {prototypePanelOpen && (
                  <PrototypePanel
                    sessions={prototypeSessions}
                    isStarting={prototypeStarting}
                    onPermission={respondPrototypePermission}
                  />
                )}
              </aside>
            </>
          ) : (
            <SynthesisLoading label="Distilling top 4 build specs…" sub="Ranking ideas by market evidence and buildability" />
          )}
        </div>
      </div>
    );
  }

  // ── Synthesis view — shown while waiting for synthesis or on parse error ───
  if (view === "synthesis") {
    return (
      <div className="dashboard">
        <header className="dashboard-header">
          <button className="back-btn" onClick={() => setView("agents")} aria-label="Back"><ArrowLeftIcon /></button>
          <div className="wordmark compact"><YCIcon /><span style={{ color: 'var(--orange-primary)', fontWeight: 'bold' }}>GoTouchGrass</span></div>
          <p className="header-prompt synthesis-header-label">
            {synthesis ? "Synthesised — launching research…" : "Synthesising…"}
          </p>
        </header>
        <div className="synthesis-full-panel">
          {synthesis ? (
            <SynthesisView text={synthesis} phase={phase} />
          ) : (
            <SynthesisLoading />
          )}
        </div>
      </div>
    );
  }

  const showCompletedState = selected.status === "complete" && selected.streamingUrl;
  const completedCount = agentStates.filter((a) => a.status === "complete" || a.status === "error").length;
  const allDone = agentStates.length > 0 && agentStates.every((a) => a.status === "complete" || a.status === "error");
  const canForceSynth = completedCount > 0;

  async function handleForceSynth() {
    setView("synthesis");
    await fetch(`/api/runs/${runId}/synthesise`, { method: "POST" });
  }

  // Cancel remaining TinyFish agents without triggering synthesis — iteration phase only
  async function handleCancelRemaining() {
    await fetch(`/api/runs/${runId}/cancel-remaining`, { method: "POST" });
  }

  return (
    <div className="dashboard">
      {/* ── Header ── */}
      <header className="dashboard-header">
        <button className="back-btn" onClick={onBack} aria-label="Back"><ArrowLeftIcon /></button>
        <div className="wordmark compact"><YCIcon /><span style={{ color: 'var(--orange-primary)', fontWeight: 'bold' }}>GoTouchGrass</span></div>
        <p className="header-prompt" title={phase === "iteration" ? "Market Research" : prompt}>
          {phase === "iteration"
            ? "Market Research"
            : prompt.length > 100 ? prompt.slice(0, 100) + "…" : prompt}
        </p>
        {/* ── Layout toggle ── */}
        <div className="layout-toggle">
          <button
            className={`layout-btn ${layout === "focus" ? "active" : ""}`}
            onClick={() => setLayout("focus")}
            title="Focus view"
            aria-label="Focus view"
          >
            <FocusIcon />
          </button>
          <button
            className={`layout-btn ${layout === "grid" ? "active" : ""}`}
            onClick={() => setLayout("grid")}
            title="Grid view"
            aria-label="Grid view"
          >
            <GridIcon />
          </button>
        </div>

        {/* Phase-aware action button:
            Discovery → "Synthesise now" (cancels agents + triggers LLM synthesis)
            Iteration → "Skip remaining" (cancels agents only, keeps completed results) */}
        {phase === "discovery" ? (
          <button
            className={`synthesise-btn ${canForceSynth ? "ready" : ""}`}
            disabled={!canForceSynth}
            onClick={handleForceSynth}
            title={canForceSynth ? `Synthesise with ${completedCount}/${agentStates.length} agents` : "Waiting for at least one agent to complete"}
          >
            Synthesise now ({completedCount}/{agentStates.length})
          </button>
        ) : !allDone && (
          <button
            className={`synthesise-btn ${canForceSynth ? "ready" : ""}`}
            disabled={!canForceSynth}
            onClick={handleCancelRemaining}
            title="Cancel remaining agents and keep completed results"
          >
            Skip remaining ({completedCount}/{agentStates.length})
          </button>
        )}
      </header>

      {/* ── Grid view ── */}
      {layout === "grid" && (
        <div className="grid-main">
          {agentStates.map((agent) => {
            const isCompleted = agent.status === "complete" && agent.streamingUrl;
            return (
              <div
                key={agent.id}
                className={`grid-cell ${agent.status}`}
                onClick={() => { setLayout("focus"); setSelectedAgent(agent.id); }}
                title="Click to focus this agent"
              >
                <div className="grid-cell-header">
                  <span className={`status-dot ${agent.status}`} />
                  {(() => {
                    const idea = iterationIdeas?.[agent.id];
                    if (idea) {
                      return (
                        <>
                          <span className="grid-cell-label">#{idea.rank} {idea.title}</span>
                          <span className="grid-cell-goal">{idea.what_to_build}</span>
                        </>
                      );
                    }
                    return (
                      <>
                        <span className="grid-cell-label">Agent {agent.id + 1}</span>
                        <span className="grid-cell-goal">{agent.goal}</span>
                      </>
                    );
                  })()}
                </div>
                <div className="grid-cell-iframe">
                  {isCompleted ? (
                    <div className="iframe-placeholder completed">
                      <span className="completed-check">✓</span>
                      <p className="completed-label">Session complete</p>
                    </div>
                  ) : agent.streamingUrl ? (
                    <iframe
                      key={agent.streamingUrl}
                      src={agent.streamingUrl}
                      title={`Agent ${agent.id + 1} live preview`}
                    />
                  ) : (
                    <div className="iframe-placeholder">
                      <div className={`placeholder-spinner ${agent.status === "error" ? "error" : ""}`}>
                        {agent.status === "error" ? "⚠" : "◎"}
                      </div>
                      <p>{agent.status === "error" ? "Error" : "Waiting…"}</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Focus view: Sidebar + Right panel ── */}
      {layout === "focus" && <>
        <aside className="sidebar">
          {agentStates.map((agent) => {
            // In iteration phase, show compact idea card if we have the original ideas
            const idea = iterationIdeas?.[agent.id];
            const rankColors = ["#ff6701", "#ff8c3a", "#ffa865", "#ffbe89", "#fecb8b", "#fcdba9", "#fae9c7", "#fef3e1"];

            return (
              <button
                key={agent.id}
                className={`agent-card ${selectedAgent === agent.id ? "selected" : ""}`}
                onClick={() => setSelectedAgent(agent.id)}
              >
                <div className="agent-card-top">
                  <span className={`status-dot ${agent.status}`} />
                  {idea ? (
                    <>
                      <span className="idea-rank-badge" style={{ color: rankColors[idea.rank - 1] ?? "#fecb8b" }}>
                        #{idea.rank}
                      </span>
                      <span className="agent-label">{idea.title}</span>
                    </>
                  ) : (
                    <span className="agent-label">Agent {agent.id + 1}</span>
                  )}
                </div>
                {idea ? (
                  <p className="agent-goal">{idea.what_to_build}</p>
                ) : (
                  <p className="agent-goal">{agent.goal}</p>
                )}
              </button>
            );
          })}
        </aside>

        {/* ── Right panel ── */}
        <section
          className="right-panel"
          ref={rightPanelRef}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div className="iframe-container" style={{ flexBasis: `${splitPct}%` }}>
            {showCompletedState ? (
              <div className="iframe-placeholder completed">
                <span className="completed-check">✓</span>
                <p className="completed-label">Session complete</p>
                <p className="completed-sub">{selected.url}</p>
              </div>
            ) : selected.streamingUrl ? (
              <iframe
                key={selected.streamingUrl}
                src={selected.streamingUrl}
                title={`Agent ${selected.id + 1} live preview`}
              />
            ) : (
              <div className="iframe-placeholder">
                <div className={`placeholder-spinner ${selected.status === "error" ? "error" : ""}`}>
                  {selected.status === "error" ? "⚠" : "◎"}
                </div>
                <p>{selected.status === "error" ? "Agent encountered an error" : "Waiting for browser session…"}</p>
              </div>
            )}
          </div>

          <div className="resize-handle" onPointerDown={onDividerPointerDown} title="Drag to resize" />

          <div className="stream-panel" style={{ flexBasis: `${100 - splitPct}%` }}>
            <div className="stream-content">
              {selected.events.map((ev, idx) => (
                <div key={idx} className={`stream-line ${ev.type === "ERROR" ? "error" : ""}`}>
                  <span className="stream-type">{ev.type}</span>
                  <span className="stream-text">{String(ev.purpose || ev.message || JSON.stringify(ev))}</span>
                </div>
              ))}

              {selected.result ? (
                <>
                  <div className="stream-separator">— TinyFish Result —</div>
                  <ResultRenderer result={selected.result} />
                </>
              ) : null}

              {/* LLM analysis report — iteration phase only */}
              {phase === "iteration" && (() => {
                const report = llmReports[selected.id];
                if (report === "loading") {
                  return (
                    <div className="stream-separator llm-loading">
                      ◎ Running VC analysis…
                    </div>
                  );
                }
                if (report && typeof report === "object") {
                  return (
                    <>
                      <div className="stream-separator synthesis">— VC Analysis —</div>
                      <LLMReportRenderer report={report} />
                    </>
                  );
                }
                return null;
              })()}

              <div ref={streamEndRef} />
            </div>
          </div>
        </section>
      </>}
    </div>
  );
}

// ── Layout toggle icons ───────────────────────────────────────────────────────

function FocusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      {/* Two-column layout: narrow sidebar + wide main */}
      <rect x="1" y="1" width="4" height="14" rx="1" fill="currentColor" opacity="0.5" />
      <rect x="7" y="1" width="8" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      {/* 2×2 grid */}
      <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" />
      <rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" />
      <rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

// ── LLM Analysis renderer ─────────────────────────────────────────────────────
// Renders the 6-metric Brutal VC Partner verdict in the stream panel.

const LLM_METRIC_LABELS: { key: keyof LLMAnalysis; label: string; badge: (m: LLMMetric) => string }[] = [
  { key: "desperation_score", label: "Desperation Score", badge: (m) => `${m.score ?? "?"}/10` },
  { key: "ghost_town_check",  label: "Ghost Town Check",  badge: (m) => m.verdict ?? "?" },
  { key: "buildability",      label: "Buildability",       badge: (m) => m.verdict ?? "?" },
  { key: "kill_factor",       label: "Kill Factor",        badge: (m) => m.risk ?? "?" },
  { key: "the_prize_tam",     label: "The Prize (TAM)",    badge: (m) => m.annual_revenue_1pct ?? "?" },
  { key: "sustainability",    label: "Sustainability",     badge: (m) => m.proposed_model ?? "?" },
];

function LLMReportRenderer({ report }: { report: LLMAnalysis }) {
  return (
    <div className="llm-report">
      {LLM_METRIC_LABELS.map(({ key, label, badge }) => {
        const metric = report[key];
        if (!metric) return null;
        return (
          <div key={key} className="llm-metric">
            <div className="llm-metric-header">
              <span className="llm-metric-label">{label}</span>
              <span className="llm-metric-badge">{badge(metric)}</span>
            </div>
            <p className="llm-metric-reasoning">{metric.reasoning}</p>
          </div>
        );
      })}
    </div>
  );
}

// ── Result renderer ───────────────────────────────────────────────────────────
// Tries to render structured JSON as readable cards.
// Falls back to pre-formatted text for strings or unknown shapes.

function ResultRenderer({ result }: { result: unknown }) {
  if (typeof result === "string") {
    return <pre className="stream-result">{result}</pre>;
  }

  if (typeof result === "object" && result !== null) {
    return <JsonCards data={result as Record<string, unknown>} />;
  }

  return <pre className="stream-result">{JSON.stringify(result, null, 2)}</pre>;
}

function JsonCards({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="json-cards">
      {Object.entries(data).map(([key, value]) => (
        <div key={key} className="json-section">
          <p className="json-section-key">{formatKey(key)}</p>
          <JsonValue value={value} />
        </div>
      ))}
    </div>
  );
}

function JsonValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return (
      <div className="json-array">
        {value.map((item, idx) => (
          <div key={idx} className="json-array-item">
            {typeof item === "object" && item !== null
              ? <JsonItemCard data={item as Record<string, unknown>} />
              : <span className="json-scalar">{String(item)}</span>}
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === "object" && value !== null) {
    return <JsonItemCard data={value as Record<string, unknown>} />;
  }

  return <span className="json-scalar">{String(value)}</span>;
}

function JsonItemCard({ data }: { data: Record<string, unknown> }) {
  // If there's a title/name field, show it prominently
  const title = data.title ?? data.name ?? data.label ?? null;
  const rest = Object.entries(data).filter(([k]) => k !== "title" && k !== "name" && k !== "label" && k !== "id");

  return (
    <div className="json-item-card">
      {title && <p className="json-item-title">{String(title)}</p>}
      {rest.map(([k, v]) => (
        <div key={k} className="json-item-row">
          <span className="json-item-key">{formatKey(k)}</span>
          <span className="json-item-val">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
        </div>
      ))}
    </div>
  );
}

function formatKey(key: string): string {
  // Convert snake_case and camelCase to Title Case with spaces
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Synthesis loading state ───────────────────────────────────────────────────

function SynthesisLoading({
  label = "Aggregating VC thoughts…",
  sub = "Combining findings and selecting the strongest idea",
}: {
  label?: string;
  sub?: string;
}) {
  return (
    <div className="synthesis-loading">
      <div className="synthesis-loading-inner">
        <div className="synthesis-spinner" />
        <p className="synthesis-loading-label">{label}</p>
        <p className="synthesis-loading-sub">{sub}</p>
      </div>
    </div>
  );
}

// ── Synthesis types ───────────────────────────────────────────────────────────

export interface IdeaData {
  rank: number;
  title: string;
  what_to_build: string;
  first_customer_and_distribution: string;
  vc_signal: string;
  why_now: string;
}

// ── Synthesis view ────────────────────────────────────────────────────────────
// The backend now returns a JSON array of IdeaData objects. We parse once here
// and pass typed structs down to IdeaCard, avoiding fragile regex text parsing.

function SynthesisView({
  text,
  phase,
}: {
  text: string;
  phase: "discovery" | "iteration";
}) {
  let ideas: IdeaData[] = [];
  let parseError: string | null = null;

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      ideas = parsed as IdeaData[];
    } else if (parsed.error) {
      parseError = parsed.error;
    } else {
      parseError = "Unexpected response shape";
    }
  } catch {
    parseError = `Could not parse synthesis: ${text.slice(0, 200)}`;
  }

  return (
    <div className="synthesis-view">
      <h1 className="synthesis-title">
        {phase === "discovery" ? "Billion Dollar Ideas — launching research…" : "Billion Dollar Ideas"}
      </h1>
      {parseError ? (
        <pre className="synthesis-error">{parseError}</pre>
      ) : (
        <div className="synthesis-ideas">
          {ideas.map((idea) => <IdeaCard key={idea.rank} idea={idea} />)}
        </div>
      )}
    </div>
  );
}

const IDEA_SECTIONS: { key: keyof IdeaData; label: string }[] = [
  { key: "what_to_build",                   label: "WHAT TO BUILD" },
  { key: "first_customer_and_distribution", label: "FIRST CUSTOMER & DISTRIBUTION" },
  { key: "vc_signal",                       label: "VC SIGNAL" },
  { key: "why_now",                         label: "WHY NOW" },
];

function IdeaCard({ idea }: { idea: IdeaData }) {
  // Top 3 get distinct accent colors; #4-8 fade through varied tones
  const rankColors = ["#ff6701", "#ff8c3a", "#ffa865", "#ffbe89", "#fecb8b", "#fcdba9", "#fae9c7", "#fef3e1"];
  const rankColor = rankColors[(idea.rank - 1)] ?? "#fecb8b";

  return (
    <div className="idea-card">
      <div className="idea-card-header" style={{ borderLeftColor: rankColor }}>
        <span className="idea-rank" style={{ color: rankColor }}>#{idea.rank}</span>
        <h2 className="idea-title">{idea.title}</h2>
      </div>

      <div className="idea-sections">
        {IDEA_SECTIONS.map(({ key, label }) => (
          <div key={key} className="idea-section">
            <p className="idea-section-label">{label}</p>
            <p className="idea-section-content">{idea[key] as string}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Build Specs view — final output ──────────────────────────────────────────
// Displays the top 4 concrete build specs produced by the final synthesis LLM.

function PrototypePanel({
  sessions,
  isStarting,
  onPermission,
}: {
  sessions: PrototypeSession[];
  isStarting: boolean;
  onPermission: (sessionId: string, decision: "approve" | "deny") => void;
}) {
  return (
    <div className="prototype-panel-content">
      <div className="prototype-panel-head">
        <h2>Prototype Builder</h2>
        {isStarting && <span className="prototype-status-pill starting">Starting…</span>}
      </div>
      <p className="prototype-panel-sub">Generating one frontend prototype per build spec via WebBuilder.</p>
      <div className="prototype-session-list">
        {sessions.length === 0 ? (
          <p className="prototype-empty">Waiting for build specs to initialize sessions.</p>
        ) : sessions.map((session) => (
          <section key={session.sessionId} className="prototype-session-card">
            <div className="prototype-session-top">
              <p className="prototype-session-title">{session.title}</p>
              <span className={`prototype-status-pill ${session.status}`}>{formatPrototypeStatus(session.status)}</span>
            </div>
            <p className="prototype-session-summary">{session.summary}</p>
            {session.pendingPermission && (
              <div className="prototype-permission">
                <p>{session.pendingPermission.message}</p>
                <div className="prototype-permission-actions">
                  <button onClick={() => onPermission(session.sessionId, "approve")}>Approve</button>
                  <button className="deny" onClick={() => onPermission(session.sessionId, "deny")}>Deny</button>
                </div>
              </div>
            )}
            {session.previewUrl ? (
              <iframe
                src={session.previewUrl}
                title={`${session.title} prototype preview`}
                className="prototype-preview"
              />
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

function formatPrototypeStatus(status: PrototypeStatus): string {
  switch (status) {
    case "starting": return "Starting";
    case "running": return "Running";
    case "awaiting_approval": return "Needs Approval";
    case "completed": return "Completed";
    case "failed": return "Failed";
    default: return "Unknown";
  }
}

const BUILD_SPEC_SECTIONS: { key: keyof BuildSpec; label: string }[] = [
  { key: "whatToBuild",       label: "WHAT TO BUILD" },
  { key: "expectedUser",      label: "EXPECTED USER" },
  { key: "additionalContext", label: "ADDITIONAL CONTEXT" },
];

function BuildSpecsView({ specs }: { specs: BuildSpec[] }) {
  return (
    <div className="synthesis-view">
      <h1 className="synthesis-title">Top {specs.length} Build Specs</h1>
      <div className="synthesis-ideas">
        {specs.map((spec, i) => (
          <BuildSpecCard key={i} spec={spec} rank={i + 1} />
        ))}
      </div>
    </div>
  );
}

function BuildSpecCard({ spec, rank }: { spec: BuildSpec; rank: number }) {
  const rankColors = ["#ff6701", "#ff8c3a", "#ffa865", "#ffbe89"];
  const rankColor = rankColors[rank - 1] ?? "#ffbe89";

  return (
    <div className="idea-card">
      <div className="idea-card-header" style={{ borderLeftColor: rankColor }}>
        <span className="idea-rank" style={{ color: rankColor }}>#{rank}</span>
        <h2 className="idea-title">{spec.title}</h2>
      </div>

      <div className="idea-sections">
        {BUILD_SPEC_SECTIONS.map(({ key, label }) => (
          <div key={key} className="idea-section">
            <p className="idea-section-label">{label}</p>
            <p className="idea-section-content">{spec[key]}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
