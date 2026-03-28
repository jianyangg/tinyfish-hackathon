# tinyfish-hackathon

TypeScript (Vite + React) frontend with a Python (FastAPI) backend.

## Prerequisites

- Node.js
- Python 3.11+

## Setup

The virtual environment and node modules are already installed. If you need to reinstall:

```bash
# backend
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt

# frontend
cd frontend && npm install
```

## Running

```bash
./launch.sh
```

- Frontend: http://localhost:5173
- Backend: http://localhost:8000

## Environment variables

Copy `backend/.env.example` to `backend/.env` and fill in values. Backend reads all vars via `python-dotenv`. Frontend only receives vars prefixed with `VITE_`.

| Variable          | Used by  | Description         |
| ----------------- | -------- | ------------------- |
| `TINYFISH_API_KEY` | backend | tinyfish API key    |
