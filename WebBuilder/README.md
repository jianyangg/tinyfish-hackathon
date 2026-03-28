# Codex Frontend Prototype Streamer

A TypeScript web app that:

- Accepts a JSON list of pitches in the browser.
- Starts one Codex CLI session per pitch on the server.
- Shows a concise live summary of what each Codex agent is doing.
- Detects permission prompts and shows Approve/Deny buttons.
- Shows each generated website in its own small live-refreshing iframe preview.

## Requirements

- Node.js 20+
- Codex CLI available on PATH as `codex`
- Auth configured for Codex (either run `codex login` once, or set `OPENAI_API_KEY`)

## Run

```bash
npm install
npm run dev
```

Then open:

- http://localhost:3000

## How It Works

- `POST /api/sessions`
  - Starts one Codex process for a single pitch.
- `POST /api/sessions/batch`
  - Starts one Codex process per item from a JSON list.
  - Body shape: `{ "items": [{ "title": "...", "whatToBuild": "...", "expectedUser": "...", "additionalContext": "..." }] }`
- `GET /api/sessions/:id/stream`
  - SSE endpoint for live logs and status events.
- `POST /api/sessions/:id/permission`
  - Sends `y` (approve) or `n` (deny) back to Codex stdin.
- `GET /api/sessions/:id/preview/index.html`
  - Serves the generated site for iframe embedding.

## Optional Environment Variables

- `PORT` (default: `3000`)
- `CODEX_BIN` (default: `codex`)
- `CODEX_ARGS` (space-separated args passed to Codex)
- `CODEX_ISOLATE_HOME` (`true` to use a fresh per-run `CODEX_HOME`; default keeps your normal Codex auth/config)

Example:

```bash
CODEX_BIN=codex CODEX_ARGS="--model gpt-5.4" npm run dev
```

## Notes

- Permission detection uses common prompt patterns from CLI output. You can tune these patterns in `/src/server.ts`.
- Sessions are kept in-memory in this implementation.
- Each run uses a UUID-named temp folder under `tmp/`.
- When generation completes, each produced website is previewed in an iframe on the main page.
- The `tmp/` folder is removed on app shutdown (`SIGINT`, `SIGTERM`, or process exit).
