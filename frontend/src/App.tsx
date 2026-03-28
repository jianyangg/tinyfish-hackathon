import { useState, type FormEvent } from "react";
import Dashboard, { type IdeaData } from "./Dashboard";
import "./App.css";

// ── Types shared between App and Dashboard ───────────────────────────────────
export interface AgentConfig {
  url: string;
  goal: string;
}

// The multi-step loading sequence shown between prompt submission and dashboard
type LoadingStep = "decomposing" | "spawning" | null;

// ── Hardcoded discovery prompt ───────────────────────────────────────────────
const DISCOVERY_PROMPT = `You are an AI Venture Capital Intelligence Agent.

Your task is to identify high-quality, recent, and high-conviction startup ideas that venture capital firms explicitly want founders to build.

Focus only on RECENT content (last ~3 months). Freshness is critical.

---

OBJECTIVE

Identify and synthesize startup ideas that:
- Are explicitly requested or strongly implied by VCs
- Reflect real, current market demand
- Are scalable and fundable
- Are grounded in recent investor thinking

---

PRIMARY SOURCES (PRIORITIZE)

Search and extract from:

1. https://www.ycombinator.com/rfs
2. https://www.venturewishlist.com/
3. Google News search: "VC startup ideas wishlist" (filter: last 3 months)
4. Google search (filter: last 3 months):
   - "venture capital wishlist startups 2026"
   - "investors want founders to build"
   - "startup ideas VC thesis"
   - "latest startup trends venture capital"
5. Recent VC blogs:
   - a16z (Andreessen Horowitz)
   - Sequoia Capital
   - NFX
   - Founders Fund
6. High-signal publications:
   - TechCrunch
   - Inc
   - Relevant Substack or investor blogs

---

TIME CONSTRAINT

Only use content published within the last ~3 months.

If older:
- Ignore it, unless referenced in a recent source

---

EXTRACTION LOGIC

For each source:
- Extract explicit wishlist ideas, or
- Infer strong investor intent from:
  - repeated themes
  - problem statements
  - capital allocation signals

Focus on real gaps and emerging opportunities.

Avoid generic or saturated ideas.

---

SYNTHESIS

Do not list raw ideas.

You must:
- Combine signals across sources
- Refine into clear, actionable startup concepts
- Elevate into investor-grade opportunities

Each idea should feel fundable today.

---

OUTPUT FORMAT

Return ideas neatly arranged in text as well as the source

For each idea:

1. Idea Title
2. Core Idea (1–2 sentences)
3. Why VCs Want This (link to investor signals)
4. Market Opportunity (why now)
5. Differentiation Angle
6. Source Signals (URLs)
7. Confidence Level (High / Medium / Low)

---

QUALITY BAR

Include only ideas that:
- Are backed by recent investor signals
- Are non-obvious and non-generic
- Have clear commercial potential

---

DO NOT

- Include outdated ideas (>3 months)
- Output raw links without synthesis
- Include low-quality or obvious ideas
- Hallucinate sources

---

FINAL INSTRUCTION

Act as a top-tier VC analyst.

Answer:
"What do investors want someone to build right now?"`;

export default function App() {
  const [view, setView] = useState<"prompt" | "loading" | "dashboard">("prompt");
  const [loadingStep, setLoadingStep] = useState<LoadingStep>(null);
  const [runId, setRunId] = useState("");
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [phase, setPhase] = useState<"discovery" | "iteration">("discovery");

  async function handleLaunch(e?: FormEvent) {
    if (e) e.preventDefault();
    if (view === "loading") return;

    setPhase("discovery");
    setView("loading");
    setLoadingStep("decomposing");

    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: DISCOVERY_PROMPT }),
      });
      if (!res.ok) throw new Error(`Backend error: ${res.status}`);

      const data = await res.json();
      setRunId(data.run_id);
      setAgents(data.agents);

      // Brief pause on "spawning" so the user registers the step
      setLoadingStep("spawning");
      await new Promise((r) => setTimeout(r, 1200));

      setView("dashboard");
      setLoadingStep(null);
    } catch (err) {
      console.error("Failed to create run:", err);
      alert("Failed to start agents — check that the backend is running.");
      setView("prompt");
      setLoadingStep(null);
    }
  }

  // ── Iteration handler ──────────────────────────────────────────────────────
  // Fetches the prompt template from the backend (single source of truth),
  // builds one task per idea, and creates a new run with auto_synthesise=false.
  async function handleIterate(ideas: IdeaData[]) {
    setPhase("iteration");
    setView("loading");
    setLoadingStep("spawning");

    try {
      // Fetch the iteration prompt template from the backend so prompts
      // stay in one place (backend/prompts.py).
      const tplRes = await fetch("/api/iteration-template");
      if (!tplRes.ok) throw new Error(`Failed to fetch template: ${tplRes.status}`);
      const { goal_template, default_url } = await tplRes.json();

      const tasks = ideas.map((idea) => ({
        url: default_url,
        goal: goal_template.replace("{idea}", `${idea.title}: ${idea.what_to_build}`),
      }));

      const res = await fetch("/api/runs/from-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Market research iteration",
          tasks,
          auto_synthesise: false,
        }),
      });
      if (!res.ok) throw new Error(`Backend error: ${res.status}`);

      const data = await res.json();
      setRunId(data.run_id);
      setAgents(data.agents);

      await new Promise((r) => setTimeout(r, 800));
      setView("dashboard");
      setLoadingStep(null);
    } catch (err) {
      console.error("Failed to start iteration:", err);
      alert("Failed to start research agents — check that the backend is running.");
      setView("prompt");
      setPhase("discovery");
      setLoadingStep(null);
    }
  }

  // ── Dashboard view ─────────────────────────────────────────────────────────
  if (view === "dashboard") {
    return (
      <Dashboard
        runId={runId}
        agents={agents}
        prompt={DISCOVERY_PROMPT}
        phase={phase}
        onBack={() => { setView("prompt"); setPhase("discovery"); }}
        onIterate={handleIterate}
      />
    );
  }

  // ── Loading view ───────────────────────────────────────────────────────────
  if (view === "loading") {
    return (
      <div className="page">
        <header className="wordmark">
          <GrassIcon />
          <span>grasstoucher</span>
        </header>

        <main className="center">
          <div className="loading-sequence">
            {phase === "discovery" ? (
              <>
                <LoadingStepIndicator
                  label="Analyzing prompt"
                  detail="Breaking your prompt into focused research tasks…"
                  active={loadingStep === "decomposing"}
                  done={loadingStep === "spawning"}
                />
                <LoadingStepIndicator
                  label="Spawning agents"
                  detail="Launching parallel browser sessions…"
                  active={loadingStep === "spawning"}
                  done={false}
                />
              </>
            ) : (
              <LoadingStepIndicator
                label="Spawning research agents"
                detail="Launching market research for each draft idea…"
                active={loadingStep === "spawning"}
                done={false}
              />
            )}
          </div>
        </main>
      </div>
    );
  }

  // ── Prompt view ────────────────────────────────────────────────────────────
  return (
    <div className="page">
      <header className="wordmark">
        <GrassIcon />
        <span>grasstoucher</span>
      </header>

      <main className="center">
        <p className="tagline">What do investors want built right now?</p>

        <button className="send-btn launch-btn" onClick={handleLaunch} aria-label="Launch">
          <ArrowIcon />
        </button>
      </main>
    </div>
  );
}

// ── Loading step indicator ───────────────────────────────────────────────────

function LoadingStepIndicator({
  label,
  detail,
  active,
  done,
}: {
  label: string;
  detail: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <div className={`loading-step ${active ? "active" : ""} ${done ? "done" : ""}`}>
      <div className="loading-step-icon">
        {done ? (
          <span className="checkmark">✓</span>
        ) : active ? (
          <Spinner />
        ) : (
          <span className="step-dot" />
        )}
      </div>
      <div className="loading-step-text">
        <p className="loading-step-label">{label}</p>
        <p className="loading-step-detail">{detail}</p>
      </div>
    </div>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────

export function GrassIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 21 C7 21 5 16 6 10 C6 10 8 13 8 21Z" fill="#22C55E" />
      <path d="M12 21 C12 21 10 13 12 4 C12 4 14 13 12 21Z" fill="#16A34A" />
      <path d="M17 21 C17 21 16 16 18 10 C18 10 19 13 17 21Z" fill="#22C55E" />
      <line x1="4" y1="21" x2="20" y2="21" stroke="#15803D" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="13 6 19 12 13 18" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" className="spinner">
      <path d="M12 2 a10 10 0 0 1 10 10" />
    </svg>
  );
}
