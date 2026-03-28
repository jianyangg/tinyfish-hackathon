import { useEffect, useRef, useState, useCallback } from "react";
import { GrassIcon, type AgentConfig } from "./App";
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

interface DashboardProps {
  runId: string;
  agents: AgentConfig[];
  prompt: string;
  phase: "discovery" | "iteration";
  onBack: () => void;
  onIterate?: (ideas: IdeaData[]) => void;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard({ runId, agents, prompt, phase, onBack, onIterate }: DashboardProps) {
  const [agentStates, setAgentStates] = useState<AgentState[]>(() =>
    agents.map((a, i) => ({
      id: i, url: a.url, goal: a.goal,
      status: "pending", streamingUrl: null, events: [], result: null,
    }))
  );
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [synthesis, setSynthesis] = useState<string | null>(null);
  // "agents" = main view; "synthesis" = full-screen synthesis panel
  const [view, setView] = useState<"agents" | "synthesis">("agents");
  // "focus" = sidebar + single agent detail; "grid" = all agents in a grid
  const [layout, setLayout] = useState<"focus" | "grid">("focus");

  const [splitPct, setSplitPct] = useState(65);
  const rightPanelRef = useRef<HTMLElement>(null);
  const dragging = useRef(false);
  const streamEndRef = useRef<HTMLDivElement>(null);

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

          if (event.type === "DONE") { es.close(); return; }

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

  // ── Synthesis view — shown automatically once discovery agents finish ──────
  if (view === "synthesis") {
    return (
      <div className="dashboard">
        <header className="dashboard-header">
          <button className="back-btn" onClick={() => setView("agents")} aria-label="Back">←</button>
          <div className="wordmark compact"><GrassIcon /><span>grasstoucher</span></div>
          <p className="header-prompt synthesis-header-label">
            {synthesis ? "Synthesised ideas" : "Synthesising…"}
          </p>
        </header>
        <div className="synthesis-full-panel">
          {synthesis ? (
            <SynthesisView text={synthesis} phase={phase} onIterate={onIterate} />
          ) : (
            <SynthesisLoading />
          )}
        </div>
      </div>
    );
  }

  const showCompletedState = selected.status === "complete" && selected.streamingUrl;
  const completedCount = agentStates.filter((a) => a.status === "complete" || a.status === "error").length;
  const canForceSynth = completedCount > 0;

  async function handleForceSynth() {
    setView("synthesis");
    await fetch(`/api/runs/${runId}/synthesise`, { method: "POST" });
  }

  return (
    <div className="dashboard">
      {/* ── Header ── */}
      <header className="dashboard-header">
        <button className="back-btn" onClick={onBack} aria-label="Back">←</button>
        <div className="wordmark compact"><GrassIcon /><span>grasstoucher</span></div>
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

        {/* Synthesise button — only shown during discovery phase */}
        {phase === "discovery" && (
          <button
            className={`synthesise-btn ${canForceSynth ? "ready" : ""}`}
            disabled={!canForceSynth}
            onClick={handleForceSynth}
            title={canForceSynth ? `Synthesise with ${completedCount}/${agentStates.length} agents` : "Waiting for at least one agent to complete"}
          >
            Synthesise now ({completedCount}/{agentStates.length})
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
                  <span className="grid-cell-label">Agent {agent.id + 1}</span>
                  <span className="grid-cell-goal">{agent.goal}</span>
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
          {agentStates.map((agent) => (
            <button
              key={agent.id}
              className={`agent-card ${selectedAgent === agent.id ? "selected" : ""}`}
              onClick={() => setSelectedAgent(agent.id)}
            >
              <div className="agent-card-top">
                <span className={`status-dot ${agent.status}`} />
                <span className="agent-label">Agent {agent.id + 1}</span>
              </div>
              <p className="agent-goal">{agent.goal}</p>
            </button>
          ))}
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
                  <span className="stream-text">{ev.purpose || ev.message || JSON.stringify(ev)}</span>
                </div>
              ))}

              {selected.result && (
                <>
                  <div className="stream-separator">— Result —</div>
                  <ResultRenderer result={selected.result} />
                </>
              )}

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

function SynthesisLoading() {
  return (
    <div className="synthesis-loading">
      <div className="synthesis-loading-inner">
        <div className="synthesis-spinner" />
        <p className="synthesis-loading-label">Synthesising agent results…</p>
        <p className="synthesis-loading-sub">Combining findings and drafting up to 8 concrete ideas</p>
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
  onIterate,
}: {
  text: string;
  phase: "discovery" | "iteration";
  onIterate?: (ideas: IdeaData[]) => void;
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
      <h1 className="synthesis-title">Draft ideas</h1>
      {parseError ? (
        <pre className="synthesis-error">{parseError}</pre>
      ) : (
        <>
          <div className="synthesis-ideas">
            {ideas.map((idea) => <IdeaCard key={idea.rank} idea={idea} />)}
          </div>

          {/* Show "Research these ideas" button only in discovery phase */}
          {phase === "discovery" && onIterate && ideas.length > 0 && (
            <button className="iterate-btn" onClick={() => onIterate(ideas)}>
              Research these ideas →
            </button>
          )}
        </>
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
  // Top 3 get distinct accent colors; #4–8 fade through varied tones
  const rankColors = ["#3B7BF8", "#22C55E", "#F59E0B", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316", "#6B7280"];
  const rankColor = rankColors[(idea.rank - 1)] ?? "#6B7280";

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
