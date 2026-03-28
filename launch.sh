#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── backend ──────────────────────────────────────────────────────────────────
echo "[backend] starting FastAPI on :8000"
"$ROOT/backend/.venv/bin/uvicorn" main:app \
  --app-dir "$ROOT/backend" \
  --reload \
  --port 8000 &
BACKEND_PID=$!

# ── frontend ─────────────────────────────────────────────────────────────────
echo "[frontend] starting Vite dev server on :5173"
cd "$ROOT/frontend" && npm run dev &
FRONTEND_PID=$!

# ── cleanup on exit (Ctrl-C / SIGTERM) ───────────────────────────────────────
trap 'echo; echo "shutting down…"; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; wait' EXIT INT TERM

echo "both servers running — press Ctrl-C to stop"
wait
