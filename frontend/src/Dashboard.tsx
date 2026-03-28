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
  onBack: () => void;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard({ runId, agents, prompt, onBack }: DashboardProps) {
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

  // Auto-navigate to synthesis view once every agent is done
  useEffect(() => {
    const allDone = agentStates.every(
      (a) => a.status === "complete" || a.status === "error"
    );
    if (allDone && agentStates.length > 0) {
      setView("synthesis");
    }
  }, [agentStates]);

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

  // ── Synthesis view — shown automatically once all agents finish ───────────
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
            <SynthesisView text={synthesis} />
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
        <p className="header-prompt" title={prompt}>
          {prompt.length > 100 ? prompt.slice(0, 100) + "…" : prompt}
        </p>
        <button
          className={`synthesise-btn ${canForceSynth ? "ready" : ""}`}
          disabled={!canForceSynth}
          onClick={handleForceSynth}
          title={canForceSynth ? `Synthesise with ${completedCount}/${agentStates.length} agents` : "Waiting for at least one agent to complete"}
        >
          Synthesise now ({completedCount}/{agentStates.length})
        </button>
      </header>

      {/* ── Sidebar ── */}
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

function SynthesisLoading() {
  return (
    <div className="synthesis-loading">
      <div className="synthesis-loading-inner">
        <div className="synthesis-spinner" />
        <p className="synthesis-loading-label">Synthesising agent results…</p>
        <p className="synthesis-loading-sub">Combining findings and ranking the top 3 ideas</p>
      </div>
    </div>
  );
}

// ── Synthesis view ────────────────────────────────────────────────────────────
// Parses the text output from the synthesis prompt (which uses --- separators
// and labelled sections) into structured idea cards.

function SynthesisView({ text }: { text: string }) {
  // Split on --- delimiters, drop empty chunks
  const chunks = text.split(/^---$/m).map((c) => c.trim()).filter(Boolean);

  return (
    <div className="synthesis-view">
      <h1 className="synthesis-title">Top ideas</h1>
      <div className="synthesis-ideas">
        {chunks.map((chunk, idx) => <IdeaCard key={idx} raw={chunk} />)}
      </div>
    </div>
  );
}

// Section labels from the synthesis prompt
const SECTION_LABELS = ["WHAT TO BUILD", "FIRST CUSTOMER & DISTRIBUTION", "VC SIGNAL", "WHY NOW", "CONVICTION SCORE"];

function IdeaCard({ raw }: { raw: string }) {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  // First line is the rank + title: "#1. Some Title"
  const titleLine = lines[0] ?? "";
  const titleMatch = titleLine.match(/^#(\d+)\.\s+(.+)$/);
  const rank = titleMatch ? parseInt(titleMatch[1]) : null;
  const title = titleMatch ? titleMatch[2] : titleLine;

  // Parse remaining lines into labelled sections
  const sections: { label: string; content: string[] }[] = [];
  let current: { label: string; content: string[] } | null = null;

  for (const line of lines.slice(1)) {
    const matchedLabel = SECTION_LABELS.find((l) => line.startsWith(l));
    if (matchedLabel) {
      if (current) sections.push(current);
      current = { label: matchedLabel, content: [] };
    } else if (current) {
      current.content.push(line);
    }
  }
  if (current) sections.push(current);

  const rankColors = ["#3B7BF8", "#22C55E", "#F59E0B"];
  const rankColor = rank ? (rankColors[rank - 1] ?? "#6B7280") : "#6B7280";

  return (
    <div className="idea-card">
      <div className="idea-card-header" style={{ borderLeftColor: rankColor }}>
        {rank && <span className="idea-rank" style={{ color: rankColor }}>#{rank}</span>}
        <h2 className="idea-title">{title}</h2>
      </div>

      <div className="idea-sections">
        {sections.map(({ label, content }) => (
          <div key={label} className="idea-section">
            <p className="idea-section-label">{label}</p>
            <p className="idea-section-content">{content.join(" ")}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
