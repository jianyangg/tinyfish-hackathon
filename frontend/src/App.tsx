import { useState, useRef, type FormEvent } from "react";
import "./App.css";

export default function App() {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    // TODO: wire up to backend
    console.log("submit:", trimmed);
  }

  return (
    <div className="page">
      {/* ── Wordmark ── */}
      <header className="wordmark">
        <GrassIcon />
        <span>grasstoucher</span>
      </header>

      {/* ── Center content ── */}
      <main className="center">
        <p className="tagline">Ask anything.</p>

        <form className="input-row" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            className="text-input"
            type="text"
            placeholder="What do you want to know?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <button
            className="send-btn"
            type="submit"
            aria-label="Send"
          >
            <ArrowIcon />
          </button>
        </form>
      </main>
    </div>
  );
}

function GrassIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      {/*
       * Three grass blades: a tall centre blade and two shorter outer blades,
       * all curving slightly outward. Drawn as cubic bezier paths rooted at
       * a shared ground line so they read as a single cohesive icon.
       */}
      {/* Left blade — leans left */}
      <path
        d="M7 21 C7 21 5 16 6 10 C6 10 8 13 8 21Z"
        fill="#22C55E"
      />
      {/* Centre blade — tallest, stands upright */}
      <path
        d="M12 21 C12 21 10 13 12 4 C12 4 14 13 12 21Z"
        fill="#16A34A"
      />
      {/* Right blade — leans right */}
      <path
        d="M17 21 C17 21 16 16 18 10 C18 10 19 13 17 21Z"
        fill="#22C55E"
      />
      {/* Ground line */}
      <line x1="4" y1="21" x2="20" y2="21" stroke="#15803D" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="13 6 19 12 13 18" />
    </svg>
  );
}
