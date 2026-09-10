<div align="center">

# 🏦 Zimamless

**A Digital Receivables Marketplace for the Hashemite Kingdom of Jordan**

![Phases](https://img.shields.io/badge/phases%200--9-complete-success)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![API](https://img.shields.io/badge/API-NestJS%2010-e0234e)
![Web](https://img.shields.io/badge/Web-Next.js%2016-black)
![ML](https://img.shields.io/badge/ML-FastAPI-009688)
![DB](https://img.shields.io/badge/DB-Supabase%20Postgres-3ecf8e)
![i18n](https://img.shields.io/badge/i18n-EN%20%2B%20AR%20(RTL)-blue)

</div>

## 🧩 The Problem

A supplier in Jordan holding an unpaid, deferred commercial invoice waits 60 to
120 days to be paid. Discounting that invoice early means phone calls, faxed
documents, and a single bank's take-it-or-leave-it quote with fees the supplier
cannot see or compare.

**Zimamless** turns the invoice into a confidential, time-boxed marketplace
listing. It verifies the supplier against government registries, produces a
versioned and explainable Trust Score, and lets multiple licensed banks compete
with offers that are invisible to one another. Only the supplier compares them,
side by side, as full net-payout breakdowns.

### Before / After

- **Before:** one bank, one opaque quote, bundled fees, days of paperwork, no way to compare.
- **After:** many banks bid privately, every offer discloses a full deduction breakdown and a single net figure, the supplier accepts one instantly, and the invoice is atomically locked.

### 📊 Screens

_Screenshots pending. Drop `offer-comparison.png`, `bank-marketplace.png`, and
`platform-admin.png` into `docs/assets/` and reference them here._

---

## 🛠️ Installation & Usage

### 📦 The Stack

The project is a single npm monorepo. Three services run together: the API, the
web app, and the Python ML service, all against a Supabase Postgres database.

> **Note**
> Copy `.env.example` to `.env` first and fill in the four required values:
> `DATABASE_URL` (Supabase **session pooler**, port 5432 — the only string that is
> both IPv4-reachable and able to run DDL), `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
> and `SUPABASE_SERVICE_ROLE_KEY`. The service role key is server-only and must
> never reach `apps/web` or any `NEXT_PUBLIC_*` variable. Full reference:
> [`docs/specs/ENVIRONMENTS.md`](docs/specs/ENVIRONMENTS.md).

**Option 1: Prepare the database**

```bash
npm ci
npm run db:migrate        # applies migrations 0000–0009
npm run db:verify         # asserts the schema matches what the API expects
psql "$DATABASE_URL" -f db/seed/0100_seed_dev.sql
```

**Option 2: Stage the full demo scenario**

```bash
node db/tools/scenario-demo.mjs   # idempotent; heals lapsed listings
```

Seeded personas all use the password `Zimmamless#2026`.

### ▶️ Run the services

```bash
# API — http://localhost:3000  (contract prefix /v1, OpenAPI at /docs)
npm run start:dev -w @zimmamless/api

# ML service — http://localhost:8000
python -m venv services/ml/.venv
services/ml/.venv/Scripts/python -m pip install -r services/ml/requirements.txt
services/ml/.venv/Scripts/python -m uvicorn app.main:app --app-dir services/ml --port 8000

# Web — http://localhost:3001
npm run dev -w web
```

### 🧰 Commands & Options

- `npm run db:migrate` &mdash; Apply all pending SQL migrations in order.
- `npm run db:verify` &mdash; Assert RLS is enabled with a policy on every table; fails the build otherwise.
- `npm run test` &mdash; Unit tests across all workspaces.
- `npm run test:integration -w @zimmamless/api` &mdash; API integration suites, run in band.
- `npm run test:rls -w @zimmamless/api` &mdash; RLS persona suite; connects to Postgres with NestJS out of the picture.
- `npm run test:live -w web` &mdash; Live specs that gate each endpoint's promotion from mock to real.
- `npm run contract:check` &mdash; OpenAPI contract conformance.

```
███████╗██╗███╗   ███╗ █████╗ ███╗   ███╗██╗     ███████╗███████╗███████╗
╚══███╔╝██║████╗ ████║██╔══██╗████╗ ████║██║     ██╔════╝██╔════╝██╔════╝
  ███╔╝ ██║██╔████╔██║███████║██╔████╔██║██║     █████╗  ███████╗███████╗
 ███╔╝  ██║██║╚██╔╝██║██╔══██║██║╚██╔╝██║██║     ██╔══╝  ╚════██║╚════██║
███████╗██║██║ ╚═╝ ██║██║  ██║██║ ╚═╝ ██║███████╗███████╗███████║███████║
╚══════╝╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝╚══════╝╚══════╝

   A confidential, time-boxed marketplace for Jordanian receivables.
   Register → verify → list → compare offers → sign → fund → settle.
```

### 🌐 Web App

1. The web app is built against mock handlers generated from the frozen OpenAPI contract.
2. An endpoint flips to the live API only once a live spec covers its consuming screen.
3. Around 45 endpoints are live on the demo path; the rest remain deliberately mocked.
4. The UI ships English and Arabic with full RTL layout; language is never inferred from the browser locale.

> **Important**
> To talk to the real API instead of the mock shell, create `apps/web/.env.local`
> (copy `apps/web/.env.local.example`) with `NEXT_PUBLIC_API_MOCKING=disabled`
> plus `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` copied from
> the root `.env`. Without it the app silently serves MSW mocks: empty inbox,
> demo personas instead of real logins.

---

## ⚠️ Known Limitations

- **Endpoint coverage.** Roughly 45 endpoints are wired to the live API on the demo path; the remainder are served from contract-generated mocks (non-demo-path).
- **Synthetic data.** The government registry adapters (CCD / ISTD / GAM), the OCR e-invoice set, and the demo time machine are deterministic fixtures, not real integrations.
- **Legal.** Every regulatory, assignment, and enforceability question is tagged `LEGAL_TBD_POST_COMPETITION` and implemented as configurable policy, not settled rule.
- **Risk model.** The Trust Score model is small and trained on labelled synthetic data. It is explainable but not production-calibrated.
- **Contracts.** A contract "PDF" is a hashed HTML document, not a real PDF pipeline.

---

## 🗺️ Roadmap

- 🔜 Promote the remaining mocked endpoints to live as their screens gain live specs.
- 🔜 Real PDF contract rendering with a content hash.
- 🔮 Bank onboarding lifecycle via API (currently seed-only).
- 🔮 Replace the dummy government adapters with real registry integrations.
- 🔮 Production risk-model calibration and monitoring.

---

## 🤝 Contributing

The build is coordinated through [`docs/coordination/`](docs/coordination/):
decisions, open questions, and the endpoint status board. Every finished phase
files a completion report in [`docs/completion/`](docs/completion/) before the
next phase starts. Authoritative planning documents live in [`docs/`](docs/): the
consolidated requirements, the frozen database schema, the frozen API contract,
and the master build plan.

### 🏗️ Monorepo Structure

- `apps/api/` &mdash; NestJS 10 REST API, the `/v1` contract surface, backed by Postgres RLS.
- `apps/web/` &mdash; Next.js 16 / React 19 app router, Tailwind 4, EN + AR with RTL.
- `services/ml/` &mdash; Python FastAPI: OCR extraction, local QR decode, e-invoice validation, and the risk model.
- `db/` &mdash; ordered SQL migrations `0000`–`0009`, seeds, and the migrate / verify / seed tooling.
- `docs/` &mdash; requirements, frozen schema, frozen API contract, per-phase plans, and completion reports.

### 🔧 Local Development

1. Clone the repository.

   ```bash
   git clone <repo-url> zimamless && cd zimamless
   ```

2. Install dependencies.

   ```bash
   npm ci
   ```

3. Configure the environment.

   ```bash
   cp .env.example .env    # then fill in the four required values
   ```

4. Prepare and check the database.

   ```bash
   npm run db:migrate && npm run db:verify
   psql "$DATABASE_URL" -f db/seed/0100_seed_dev.sql
   ```

5. Start the API, the ML service, and the web app (see **Run the services** above).

---

## 🚢 Deployment

| Service | Host |
|---|---|
| Web | Vercel |
| API | Render (blueprint in [`render.yaml`](render.yaml)) |
| ML | Render |
| Database, Auth, Storage | Supabase |

Production sets `NODE_ENV=production`, `DEMO_TIME_MACHINE_ENABLED=false`, and
`CORS_ORIGINS` to the real web origin only. All secrets are pasted into the Render
dashboard; none live in the repo. Step-by-step:
[`docs/ops/DEPLOY_RUNBOOK.md`](docs/ops/DEPLOY_RUNBOOK.md).

---

## License

No license file is present in this repository. Treat the contents as **all rights
reserved** pending a licensing decision.
