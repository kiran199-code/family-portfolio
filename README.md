# Family Portfolio

Ledger-based portfolio app. Static data (ledger, balances, instruments) lives in Postgres; prices, NAVs and FX are fetched live with provenance.
Stack: Node 22 + TypeScript + Fastify, Postgres 16, React + Vite.

## Run with Docker
    cp .env.example .env   # edit values
    docker compose up --build
    # open http://localhost:8080, sign in with ADMIN_USER / ADMIN_PASSWORD
First start migrates the schema. Load your data once: `docker compose exec app npx tsx src/cli/seed.ts` (reads seed/prototype-data.json; it truncates and reseeds).

## Run locally
    cd backend && npm i && DATABASE_URL=... APP_SECRET=... ADMIN_USER=... ADMIN_PASSWORD=... npm run seed && npm start
    cd frontend && npm i && npm run build   # backend serves frontend/dist

## Tests
`cd backend && npm test` (needs Postgres at DATABASE_URL; 82 tests: ledger, providers with fixtures, reconciliation to the prototype, API integration).

## Before you trust the numbers
1. Run `node scripts/phase0-spike.mjs` locally (set NODE_USE_ENV_PROXY=1 behind a proxy) to confirm the providers respond.
2. Admin page: add your Upstox (or Dhan) token; verify every stock symbol (seeded symbols are unverified guesses).
3. Set manual prices for ULIP funds, DBS and unmapped stocks (MOCAPITAL, Shadowfax, Vedanta Aluminium).
See docs/providers.md. Known gaps: no CAMS PDF parser, no NPS live feed, tax rules not encoded (gains show holding days only).
The seed file contains real holdings: keep this repo private.

## Deploy on Render
1. Render dashboard > New > Blueprint > pick this (private) GitHub repo. It reads `render.yaml`: one Docker web service + one Postgres.
2. When prompted, set ADMIN_USER and ADMIN_PASSWORD (10+ chars). APP_SECRET is generated; **do not change it later** or stored broker tokens become unreadable.
3. First start migrates the schema and, because the ledger is empty, seeds from `seed/prototype-data.json`. After that, set `SEED_ON_EMPTY` to `false`.
4. Open the service URL, sign in, then Admin: add the broker token and verify symbols.
Notes: keep the service on a paid, always-on plan (the scheduler runs in-process). Enable Postgres backups/point-in-time recovery on the database plan you choose; confirm what your plan includes.
