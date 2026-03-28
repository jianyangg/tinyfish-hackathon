# GoTouchGrass
GoTouchGrass is an autonomous venture pipeline that eliminates "Analysis Paralysis" for founders who constantly pivot. It replaces months of "pivoting" and "ideating" with an agentic assembly line that finds real pain points from validated sources, validates them with brutal logic, and ships functional MVPs.

# The Problem
Founders spend 90% of their time "thinking" about problems instead of solving them. The same applies to innovation studios across large enterprises that dedicate tons of time and resources to innovation and finding new ideas to adopt that solve real problems. We spent two hours arguing over a problem statement before realising the biggest issue is finding a real problem.

# Key Product Layers
## 1. 🎣 Fishermen
Casting the net for real ideas.
Agents scrape high-signal sources like the YC Request for Startups and investor wishlists. They bypass the "fluff" to identify where the money and the misery are, generating a structured Opportunity Map.

## 2. 🦈 Shark Tank
The Verdict.
Our AI Partners run a Build/Kill analysis on the "catch." They evaluate ideas based on:

Desperation Score: Is this a "wallet-out" emergency?

Ghost Town Check: Is the market empty or over-saturated?

The "Kill" Factor: Is it safe from Big Tech (Google/Meta)?

TAM/SAM/SOM: Is the prize big enough to bother?

3. 🧱 ** Building Phase**
The Building.
With help from our dear friend Codex, our validated real solutions to identified problems can be brought to a reality.


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
