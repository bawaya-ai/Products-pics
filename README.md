> Generated: 2026-07-26 · Commit: 0f2c759 · Generator: make-docs

# Scraper Pro

Scraper Pro turns a product URL — or a free-text product name — into a store-ready
listing. It extracts candidate images from the source page, removes backgrounds
through a fallback provider chain (Replicate → remove.bg → free local ONNX →
optional OpenAI), resizes and encodes them to a uniform spec with `sharp`, writes
AI-generated multilingual (AR/HE/EN) name and description copy, cross-checks and
converts the price, and optionally probes source product video. The result is a
store-agnostic `Manifest` (`core/types.ts`) that a small adapter pushes into a
destination store, or that ships as a downloadable ZIP. Two roles use it day to
day: **operators**, who run and review scrapes, and **admins**, who additionally
manage provider keys, destination stores, and user accounts.

## Stack

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Framework | Next.js (App Router) | `^15.3.0` | every route handler sets `runtime='nodejs'`, `dynamic='force-dynamic'` |
| UI | React / ReactDOM | `^19.0.0` | one client component (`components/App.tsx`) renders both the tool and admin surfaces |
| Language | TypeScript | `^5.7.2` | `strict: true`, path alias `@/*` (`tsconfig.json`) |
| Runtime | Node.js | not pinned in `package.json`/`.nvmrc` | Vercel serverless Node functions |
| Database | Neon Postgres (serverless) | `@neondatabase/serverless ^1.1.0` | optional — enables encrypted config, stores, users; app runs env-only without it |
| Image processing | sharp | `^0.34.1` | cutout / trim / resize / encode pipeline |
| Local ML | onnxruntime-node | `^1.21.0` | free local ISNet/U²-Net background-removal fallback, no key required |
| Client-side export | jszip | `^3.10.1` | ZIP-download save adapter |
| Hosting | Vercel | — | `vercel.json` sets per-route `maxDuration`/`memory` |
| Package manager | pnpm | — | `pnpm-lock.yaml`, `pnpm-workspace.yaml` |

## Quick start

```bash
git clone <this-repo-url> scraper-pro
cd scraper-pro
pnpm install                 # approves native builds for sharp + onnxruntime-node
cp .env.example .env.local   # every var is optional locally — see docs/CONFIGURATION.md
pnpm dev                     # http://localhost:3111
```

No environment variable is required to boot locally. Every provider key
(Anthropic, OpenAI, Replicate, remove.bg, Firecrawl, Google CSE, the store
token, …) can instead be entered through the in-app **Admin → Integrations &
Keys** panel and stored encrypted in Neon Postgres, if `DATABASE_URL` is set.
`APP_SECRET` (≥16 chars) becomes required once `NODE_ENV=production` — the app
fails closed without it. Full reference, including which vars are server-only
vs. client-visible: **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**.

| Command | Purpose |
|---|---|
| `pnpm dev` | dev server on `:3111` |
| `pnpm build` | production build |
| `pnpm start` | run the production build on `:3111` |
| `pnpm typecheck` | `tsc --noEmit` |

There is no `test` or `lint` script — no automated tests and no ESLint config
exist in this repo (see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)).

### Deploy

```bash
vercel            # first run links the project
vercel --prod     # production deploy
```

Deploys are manual via the Vercel CLI — there is no CI/CD pipeline. Full
pipeline, verification checklist, and rollback notes:
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Repository layout

```
scraper-pro/
├── app/               # Next.js App Router: pages + API routes
│   ├── api/           #   route.ts handlers — auth, config, scrape, save, stores, users, ...
│   ├── admin/         #   /admin management UI (admin role only, server-redirected otherwise)
│   ├── login/, reset/ #   standalone auth pages (outside components/App.tsx)
│   └── layout.tsx, page.tsx, manifest.ts, globals.css
├── core/              # framework-free pipeline + data layer: auth, db, settings,
│                      #   extract, select, enrich, bgremove, localbg, process,
│                      #   watermark, websearch, discovery, googleauth, instagram,
│                      #   video, currency, budget, mailer, types
├── adapters/          # Manifest → destination store (kissplay.ts today)
├── components/        # App.tsx (tool + admin UI), PWA.tsx
├── public/            # PWA icons + service worker (sw.js)
├── scripts/           # one-off scripts (gen-icons.mjs)
├── docs/              # this documentation suite
├── middleware.ts      # Edge: coarse cookie-presence gate, admin-subdomain redirect
├── next.config.mjs    # serverExternalPackages: sharp, onnxruntime-node
├── vercel.json        # per-route maxDuration/memory overrides
└── .env.example       # optional server env vars (all overridable via Admin UI)
```

## Documentation suite

| Doc | Covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Containers, key flows, design decisions, boundaries |
| [docs/API-REFERENCE.md](docs/API-REFERENCE.md) | Every route: auth, request/response, error codes |
| [docs/DATABASE.md](docs/DATABASE.md) | Neon Postgres schema (`app_config`, `stores`, `users`) |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every env var: required?, source, resolution order |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deploy pipeline, manual steps, rollback, checklist |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Failure modes: symptom → confirm → mitigate → escalate |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [docs/ONBOARDING.md](docs/ONBOARDING.md) | Day-1 guide: one request traced end to end |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Branching, commits, tests/lint/typecheck, PR checklist |
