> Generated: 2026-07-26 · Commit: 0f2c759 · Generator: make-docs

# Runbook

Operational playbook for scraper-pro's real failure modes — each one traced to the exact
code path that produces it. No generic incident-response boilerplate: every symptom below
is something the code actually does, and every mitigation is something the code actually
supports.

There is no APM/alerting integration in this repo (no Sentry, Datadog, or similar found in
`package.json` or the codebase) — "how to confirm" below means reading the NDJSON log
stream in the UI, checking an API response, or querying Neon directly. There is also no
`imports`/audit-log table (`docs/DATABASE.md`) — the NDJSON stream *is* the only record of
a given scrape run, and it is not persisted anywhere once the browser tab closes.

## Index

| # | Failure mode | Operator-visible signal |
|---|---|---|
| 1 | [Anthropic AND OpenAI both down](#1-anthropic-and-openai-both-down) | Product ships with blank name/description, `ai_enrichment_unavailable` warning |
| 2 | [Neon Postgres unreachable](#2-neon-postgres-unreachable) | Admin actions 401 "unauthorized"; DB-stored keys silently vanish |
| 3 | [Firecrawl credits exhausted](#3-firecrawl-credits-exhausted) | JS-heavy sites yield few/no images; category discovery returns empty |
| 4 | [Background-removal chain fully failing](#4-background-removal-chain-fully-failing) | Images ship with original background; `background_not_removed` warning |
| 5 | [Daily safety cap hit](#5-daily-safety-cap-hit) | `429` with a sink cap message on `/api/scrape` or `/api/discover` |
| 6 | [Video download failing](#6-video-download-failing) | Video probed as `probe:'failed'` or ZIP ships a `-link.txt` instead of the file |

---

## 1. Anthropic AND OpenAI both down

**Symptom**
The pipeline does **not** error out. `POST /api/scrape` completes normally (NDJSON `result`
event, HTTP 200), but the returned `Manifest` has empty `name`/`description` in all three
languages, `tags: []`, and `warnings` contains `ai_enrichment_unavailable` (or
`ai_output_unparseable — …` if a model answered but its JSON couldn't be used). Images are
still processed — the default `keepOrder` ("first pool image = main, rest = angle",
`app/api/scrape/route.ts:116`) is never overridden, since `ai.imageRoles` is empty and the
`if (kept.length)` block that would reorder it (`:125-129`) never fires.

**How to confirm**
- In the NDJSON log stream (the `stage:'log'` lines shown live in the UI), look for one of:
  - `AI enrich skipped (no API key)` — neither key is configured at all (`core/enrich.ts:144`).
  - `AI enrich anthropic failed: <message>` — Anthropic key is set but the call errored/timed out (`core/enrich.ts:120`).
  - `AI enrich openai failed: <message>` — OpenAI fallback also errored (`core/enrich.ts:140`).
  - `AI enrich: anthropic response unusable — raw: …` / `…openai response unusable…` — a model responded but `hasContent()` found no name in any language, treated as failure not success (`core/enrich.ts:116, 138, 149-151`).
- `enrich()` returns the module-level `EMPTY` constant (`core/enrich.ts:22-26`) whenever both providers are exhausted — this is the exact object that becomes `ai` in the route and flows into the final manifest.
- Anthropic gets one retry on `429`/`529` with a 1.5s backoff before falling through to OpenAI (`core/enrich.ts:118-124`) — a single transient 429 is not fatal on its own; only two consecutive failures (Anthropic then OpenAI) produce `EMPTY`.

**Mitigation**
- Confirm the keys are actually reaching the request: `GET /api/config` (any role) reports `providers.anthropic`/`providers.openai` as `{set, source}` — `source:'none'` means neither DB nor env has a key (see [`docs/API-REFERENCE.md#get-apiconfig`](./API-REFERENCE.md#get-apiconfig)).
- If `source:'db'` was expected but shows `'none'`, this is very likely **not** an Anthropic/OpenAI outage — it's Neon being unreachable and `resolveSettings` silently losing the DB-stored key (see [Neon Postgres unreachable](#2-neon-postgres-unreachable) below). Check `GET /api/db-health` first before assuming a provider outage.
- `POST /api/test` (admin) runs a live connectivity probe against every configured provider in parallel and reports `ok`/`fail`/`skip` per row (`app/api/test/route.ts`) — the fastest way to tell "key missing" from "key present but provider erroring" from "provider actually down."
- There is no automatic retry beyond the one Anthropic backoff — if both providers are down, every subsequent `/api/scrape` call in the outage window degrades the same way (blank copy, heuristic image order) until a provider recovers. Nothing queues or replays failed enrichments.
- Short-term workaround: operators can manually fill in name/description/tags in the UI review step before saving — the pipeline never blocks the save path on a missing AI result (`adapters/kissplay.ts` has no AI-provider dependency).

**Escalation**
- Check the named provider's own status page for a real outage.
- If keys are present and both providers return non-429/529 errors (e.g. `401`, `403`), the key itself is likely invalid/revoked — rotate it via the Admin → Integrations panel (`POST /api/config`, admin-only, `app/api/config/route.ts:29-41`).
- This repo has no alerting hook for "AI unavailable" — an operator only discovers it by reading the live log stream or the manifest's `warnings` array. There is no scheduled/automated retry.

---

## 2. Neon Postgres unreachable

Two **opposite** failure directions come out of the same root cause, because different call
sites handle a thrown DB error differently. This asymmetry is the single most important
thing to know about a Neon outage in this app.

### 2a. Admin actions fail closed (fast, visible)

**Symptom**
Every admin-only mutation — `POST /api/config`, `POST`/`DELETE /api/stores`, `POST
/api/stores/test`, `POST /api/test`, and all four `/api/users` verbs — starts returning
`401 {error:'unauthorized'}` for an admin who is genuinely still logged in with a valid
session cookie. It looks exactly like a logged-out/expired session.

**How to confirm**
- All of the above routes use `requireRoleFresh`, which re-fetches the user from the DB on
  every call: `const u = await getUserById(base.session.uid).catch(() => null); if (!u)
  return { error: json({error:'unauthorized'}, 401) };` (`core/auth.ts:70-78`). A thrown
  `getUserById` (Neon unreachable) is caught and treated **identically to "user no longer
  exists"** — there is no separate error path for "DB is down" vs. "user was deleted."
- Confirm it's actually Neon and not a real session problem: `GET /api/db-health` as the
  same admin. Non-admin callers get `{ok: boolean}` only; **admin** callers get the full
  `dbHealth()` object, `{ok:false, error:<driver message, 160 chars>}` on a real failure
  (`app/api/db-health/route.ts:14-15`, `core/db.ts:186-192`). If `ok:false`, Neon is the
  cause, not the session.
- Routes gated by plain `requireRole` (no DB re-check) are **unaffected** by this specific
  symptom — `GET /api/config`, `/api/discover`, `/api/save`, `/api/scrape`,
  `/api/status`, `/api/stores` GET, `/api/video-fetch` keep working on session-cookie
  validity alone (`core/auth.ts:61-66` never touches the DB). Only the six *fresh, admin*
  routes above fail closed.

**Mitigation**
- None available from the app itself — there is no retry or cache for `getUserById`. Wait
  for Neon to recover; the very next request after recovery succeeds with no other action
  needed (nothing needs to be reset, since no bad state was written).
- Do not "fix" this by asking the user to log out/in — a fresh session cookie hits the same
  `requireRoleFresh` DB call and fails the same way while Neon is down.

**Escalation**
- Check the Neon project's own status/dashboard (connection string host is in
  `DATABASE_URL`, driver is `@neondatabase/serverless` — `core/db.ts:1-18`).
- `core/settings.ts:110-122` also defines `checkAppAuth()`, a DB-backed app-password gate
  documented to "fail closed on a DB read error." **A repo-wide search found no call site
  for it in any route** — it is currently dead code, not wired into `/api/auth/*` or any
  other handler. Do not rely on it as a live defense; the actual login gate is the
  session-cookie system in `core/auth.ts`.
  > ⚠️ TODO(owner): confirm whether `checkAppAuth()` is intentionally unused (superseded by
  > `core/auth.ts` sessions) or a wiring gap that should call it somewhere.

### 2b. Everything else fails open (quiet, easy to miss)

**Symptom**
Unlike 2a, most other DB-dependent code paths **swallow** the error and silently degrade
instead of surfacing a failure:
- `resolveSettings()` — `const db = dbConfigured() ? await getAllConfig().catch(() => ({}))
  : {}` (`core/settings.ts:69`). If Neon is unreachable, every admin-panel-entered
  (DB-stored) provider key **disappears from that request's resolved `Settings`** and the
  pipeline falls back to whatever is in env vars, or nothing. This can look exactly like
  [failure mode 1](#1-anthropic-and-openai-both-down) or [3](#3-firecrawl-credits-exhausted)
  even though the actual providers are fine — **always check `GET /api/db-health` before
  troubleshooting a suspected provider outage** if any keys are DB-stored.
- `bumpCounter(...).catch(() => 0)` in both `POST /api/scrape` (`app/api/scrape/route.ts:31`)
  and `POST /api/discover` (`app/api/discover/route.ts:99`) — a thrown counter increment is
  treated as `n = 0`, so `n > cap` is never true. **The daily safety cap silently stops
  being enforced** for the duration of the outage — the opposite of fail-closed.
- `GET /api/stores` — a thrown `listStores()` still returns HTTP `200 {stores: [],
  dbConfigured: true, error: <message, 160 chars>}` (`app/api/stores/route.ts:18-22`), not
  a `5xx`. Look for the `error` field in the JSON body, not the status code.
- `GET /api/config` — a thrown `getAllConfig()` inside its own `appPasswordRequired` lookup
  is caught with `/* keep env value */` (`app/api/config/route.ts:20-24`) — no visible error
  at all.

**How to confirm**
- Same as 2a: `GET /api/db-health` as an admin is the one endpoint that does not swallow the
  error.
- If provider keys were entered via the Admin → Integrations panel and requests started
  behaving as if those keys are unset, cross-check the `source` field for that provider in
  `GET /api/config`'s `providers` map — a key that should show `'db'` showing `'none'`
  during an otherwise-healthy deploy is a strong signal of a Neon blip.

**Mitigation**
- If any provider keys are DB-only (no env-var fallback configured), consider also setting
  the env-var equivalent (see [`docs/CONFIGURATION.md`](./CONFIGURATION.md)) as a hot
  standby — env always resolves even when Neon is down, since `resolveSettings` checks env
  *before* falling back to the client value, and the DB lookup failure only removes the DB
  layer, not the env layer (`core/settings.ts:70-76`).
- Rate-cap enforcement cannot be patched around at request time; it resumes automatically
  once Neon is reachable again (no cap state was lost — `bumpCounter` never got far enough
  to write a bad value).

**Escalation**
- Same Neon status/dashboard check as 2a. There is one root cause; the app just reacts to it
  in two different ways depending on the call site.

---

## 3. Firecrawl credits exhausted

Firecrawl is not gated by a "credits remaining" check anywhere in this codebase — the app
only finds out when a call returns a non-2xx status (e.g. `402`/`429` from Firecrawl's own
API), and every call site reacts by **degrading, not throwing**.

**Symptom** — three independent things get worse at once, in three different files:
1. **JS-rendering escalation** (`core/extract.ts:251-266`) stops firing for JS-heavy/bot-walled
   product pages — the extractor falls back to whatever raw HTML it could fetch (often
   nothing usable), which can push `candidateUrls.length` to zero and trip the in-stream
   `{type:'error'}` on `POST /api/scrape` (`app/api/scrape/route.ts:95-100`).
2. **Text-query image search** (`core/websearch.ts:130-136`) — the Firecrawl leg of the
   `searchImages()` provider ladder stops contributing candidates; if Google CSE / Discovery
   Engine are also unconfigured, the ladder ends in the localized warning
   `no_search_provider — أضف مفتاح Firecrawl أو Google (Vertex) بالإعدادات`
   (`core/websearch.ts:148-153`).
3. **Category/listing discovery** (`POST /api/discover`, query mode) — `searchProductPages()`
   returns `{urls: [], provider:'none', warnings:['firecrawl_search_<status>']}` when the
   `/v1/search` call comes back non-OK, and CATEGORY mode reports an empty result with a
   warning rather than an error (`app/api/discover/route.ts:146`, `core/websearch.ts:180-203`).

**How to confirm**
- Live log line during a scrape: `few images in raw HTML — trying Firecrawl rendered
  fetch…` (`core/extract.ts:253`) followed by **no** `usedFirecrawl` follow-up and a
  `firecrawl fetch failed` warning (`core/extract.ts:263`) — `firecrawlHtml()` catches every error/non-OK
  response and returns `null` rather than throwing (`core/extract.ts:156-167`), so a `402`
  (payment required / credits exhausted) looks identical in the log to a network blip or a
  `500` from Firecrawl's side — the log does not include the HTTP status for this
  particular call site.
- For the search ladder, the warning strings ARE status-specific:
  `firecrawl_search_<status>` (category discovery, `core/websearch.ts:188`) and
  `firecrawl_search_failed: <message>` / `firecrawl_failed: <message>` (specific-product
  search, `core/websearch.ts:114, 135`) — a `402` will show as `firecrawl_search_402` in the
  `warnings` array returned by `POST /api/discover`, or in the message text for
  `searchImages()`'s thrown-error path.
- `POST /api/test` (admin) includes a Firecrawl row — run it to get a direct `ok`/`fail`
  verdict with the response detail, independent of any in-progress scrape
  (`app/api/test/route.ts`).

**Mitigation**
- None of the three call sites retry or queue — a Firecrawl outage/exhaustion degrades every
  affected request until credits/service are restored. The pipeline never hard-fails purely
  because Firecrawl is unavailable — it only hard-fails if Firecrawl was the *only* viable
  source for that particular page/query (e.g. a JS-only SPA with no JSON-LD and no server-
  rendered `<img>` tags).
- If Google CSE (`GOOGLE_CSE_KEY`+`GOOGLE_CSE_CX`) or a Google Vertex AI Search service
  account (`GOOGLE_SA_KEY`) are configured, switch `searchProvider` away from `'firecrawl'`
  (or leave it `'auto'`, which already tries Discovery Engine and Google CSE before
  Firecrawl — `core/websearch.ts:99-136`) so text-query search keeps working without
  Firecrawl.
- Direct product-URL scraping still works for any page whose raw (non-JS-rendered) HTML
  carries JSON-LD `Product` markup or plain `<img>`/`og:image` tags — only JS-heavy/bot-
  walled pages depend on the Firecrawl escalation.

**Escalation**
- Check the Firecrawl account's credit balance/plan (this repo has no local visibility into
  remaining Firecrawl credits — the only signal is the HTTP status Firecrawl itself
  returns).
- Rotate/top up the key via Admin → Integrations (`POST /api/config`).

---

## 4. Background-removal chain fully failing

This has **two** distinct failure surfaces in the code — a per-image one that is silent and
common, and a whole-run one that is loud and rare.

### 4a. Per-image: every provider in the ladder fails or is unconfigured

**Symptom**
The affected image still ships — with its **original, non-removed background** — instead
of failing the run. `ProcessedImage.bgProvider` is `'none'` and its `warnings` includes
`background_not_removed`.

**How to confirm**
- `removeBackground()` walks the provider order `[replicate? → removebg? → local (always) →
  openai?]` for `bgMode:'auto'` (`core/bgremove.ts:42-50`) and returns `null` only if
  **every** entry in that list either throws or fails the `hasRealCutout()` alpha-channel
  quality gate (`core/bgremove.ts:19-26, 65-68`). Since `'local'` (the free ONNX model,
  `core/localbg.ts`) has no key requirement and is always in the `'auto'` ladder, reaching
  `null` here requires the **local model itself** to also fail — e.g. its weights failed to
  download from GitHub Releases on a cold start (`core/localbg.ts:18-33`), or
  `onnxruntime-node` failed to load.
- Live log lines: `bg provider <name> failed: <message>` per rejected provider
  (`core/bgremove.ts:73`), or `bg provider <name> returned no real transparency — rejected,
  trying next` if a provider returned bytes but no genuine alpha channel
  (`core/bgremove.ts:66`).
- `processImage()` never throws because of this — `if (!cut && s.bgMode !== 'off')
  warnings.push('background_not_removed')` (`core/process.ts:47`) and processing continues
  with the original (opaque) image.

**Mitigation**
- Configure at least one paid provider (`REPLICATE_API_TOKEN` or `REMOVEBG_API_KEY`) as a
  fallback ahead of `local` in the ladder — if `local` is the one that's broken (model
  download failure), a paid provider succeeding earlier in the order means `local` is never
  reached.
- If it's specifically the local model failing, it self-heals once outbound access to
  GitHub Releases is restored — weights are cached in `os.tmpdir()/scraper-pro-models/`
  after the first successful download (`core/localbg.ts:18-33`), so this is a one-time
  cold-start risk per deploy environment, not a per-request cost.
- A budget guard already skips paid providers (not `local`) once fewer than 8s remain in
  the request's time budget, routing straight to `local` instead (`core/bgremove.ts:55-58`)
  — a "provider skipped — time budget nearly exhausted" log line is a budget issue, not a
  provider outage.

**Escalation**
- `POST /api/test` reports Replicate/remove.bg connectivity as rows, independent of a live
  scrape.
- The local ONNX path has no external escalation target — it's self-contained; a repeated
  failure there is a deploy/runtime environment issue (missing write access to `tmpdir`,
  `onnxruntime-node` binary incompatible with the runtime) rather than a third-party outage.

### 4b. Whole-run: the guaranteed-result fallback

**Symptom**
The user still gets a result, but with an explicit warning: `الوقت ضاق — رجّعت الصورة
الرئيسية بدون إزالة خلفية...` ("time ran out — returned the main image without background
removal"), and the single returned image has `warnings: ['bg_skipped_time']`,
`bgProvider: 'none'`.

**How to confirm**
- This path only triggers when the entire per-image processing loop produced **zero**
  finished images — most commonly because the request's 280s time budget
  (`TIME_BUDGET_MS`, `app/api/scrape/route.ts:22`) ran out before any image finished (e.g.
  a slow cold-start local-model download stacked with a slow search), not because
  background removal specifically errored. Condition: `images.length === 0 &&
  keepOrder[0] && pool[...] && s.bgMode !== 'off'` (`app/api/scrape/route.ts:189`).
- When it fires, the top-ranked pool candidate is reprocessed once with `bgMode:'off'` and
  `removeWatermark:false` explicitly (`app/api/scrape/route.ts:194`) — no provider is
  called at all on this pass.
- True hard failure (`{type:'error', message:'كل الصور فشلت بالمعالجة.'}`) only happens if
  even this bg-off retry also throws (`app/api/scrape/route.ts:205`) — e.g. the source image
  buffer itself is corrupt/undecodable by Sharp.

**Mitigation**
- If this recurs often, it's a time-budget problem, not a provider problem — check whether
  the local ONNX model is cold-starting on every request (weights not persisting between
  invocations means a slow serverless environment, e.g. ephemeral `/tmp` on every cold
  start) or whether upstream page fetches/Firecrawl calls are consistently slow.

**Escalation**
- Same as 4a for provider-side issues; for time-budget-only recurrences, this is a
  platform/infra question (Vercel function cold-start behavior), not a provider outage.

---

## 5. Daily safety cap hit

**Symptom**
`POST /api/scrape` or `POST /api/discover` returns HTTP `429` with an Arabic-language safety
message, instead of the normal NDJSON stream (scrape) or JSON result (discover).

**How to confirm**
- `/api/scrape`: `{error: 'وصلت سقف الأمان اليومي (${cap} عملية سحب). إذا هاد مقصود، ارفع
  DAILY_RUN_CAP بالإعدادات.'}` — this is a **plain, non-streamed** `Response`, returned
  before the NDJSON stream is even constructed (`app/api/scrape/route.ts:33`).
- `/api/discover`: `{error: 'وصلت سقف الأمان اليومي للاكتشاف (${cap}). ارفع
  DAILY_DISCOVER_CAP إذا مقصود.'}` (`app/api/discover/route.ts:100`).
- The counter itself: `bumpCounter('scrape:{uid}')` / `bumpCounter('discover:{uid}')`
  reuses the `app_config` table, keyed `ctr:<YYYY-MM-DD>:<key>` where the date is
  `new Date().toISOString().slice(0,10)` — **UTC date, not local time**
  (`core/db.ts:79-86`). Defaults: `DAILY_RUN_CAP=400`, `DAILY_DISCOVER_CAP=150`
  (`app/api/scrape/route.ts:30`, `app/api/discover/route.ts:98`).
- Query the live count directly in Neon: `SELECT value FROM app_config WHERE key =
  'ctr:<today-UTC>:scrape:<uid>'`.
- This cap is **only enforced when `dbConfigured()` is true** — if `DATABASE_URL` is unset,
  neither route checks a cap at all (`app/api/scrape/route.ts:29`,
  `app/api/discover/route.ts:97`). It is also silently **disabled** during a Neon outage —
  see [2b](#2b-everything-else-fails-open-quiet-easy-to-miss) — `bumpCounter(...).catch(()
  => 0)` means a DB error never trips the cap.

**Mitigation**
- Raise the ceiling: set `DAILY_RUN_CAP` / `DAILY_DISCOVER_CAP` env vars higher and
  redeploy (see [`docs/DEPLOYMENT.md#manual-deploy-steps`](./DEPLOYMENT.md#manual-deploy-steps)) — there is no runtime/admin toggle for this; it's read fresh from
  `process.env` on every request (`app/api/scrape/route.ts:30`), so a redeploy is required
  to change it, but no code change is (it's an env var, not a constant).
- Wait for UTC-midnight rollover — the counter key is date-scoped, so it resets naturally
  the next day with no manual action.
- An operator with direct Neon access can reset a specific user's count early by updating
  (or deleting) that day's `ctr:<date>:scrape:<uid>` / `ctr:<date>:discover:<uid>` row in
  `app_config` — there is no in-app admin UI or endpoint for this
  (`docs/DATABASE.md#app_config`).

**Escalation**
- This is a deliberate safety ceiling, not a bug — per the code comment, it exists so "a
  bug, a runaway loop, or a stolen session can't drain the provider accounts"
  (`app/api/scrape/route.ts:27-28`). Escalate only to decide whether to raise the cap
  permanently (env var + redeploy) or investigate why one user/session is legitimately
  hitting it (compromised session token, automation script, etc.).

---

## 6. Video download failing

Video handling treats a failed download as **non-fatal everywhere it appears** — no code
path lets a video problem block images, copy, or the save/export flow.

**Symptom, by stage:**

| Stage | What fails | What happens |
|---|---|---|
| Scrape-time probe | `probeVideo()` throws, times out, or returns an inconclusive read | Video is **kept** in the manifest with `probe:'failed'` (or `'partial'`) and `keep:true` — only a *definitive* non-video response (HTML/login wall) is dropped |
| ZIP export (client) | Both the direct browser fetch and the `/api/video-fetch` proxy fail | A `video-N-link.txt` file with the source URL is written into the ZIP folder **instead of** the video file; the rest of the ZIP (images, `description.md`, `manifest.json`) still downloads |
| Store import (`/api/save`) | The destination store fails to download the video server-side | Outside this repo's visibility — see below |

**How to confirm**
- Probe-time: `probeVideos()` — quality-first policy: `if (p && !p.ok) continue;` only
  filters out a definitively-non-video response; a thrown/timed-out probe (`p === null`)
  still gets pushed with `probe: p ? (p.partial ? 'partial' : 'ok') : 'failed'`
  (`core/video.ts:47, 54`). Live log line on success: `videos: N kept (...)`
  (`core/video.ts:59`) — a video with `probe:'failed'` still counts toward N.
- ZIP export: the comment at `components/App.tsx:474` states the contract explicitly — "a
  failed download becomes a link note, never a failed ZIP." The fallback chain is: direct
  cross-origin `fetch(url)` → `/api/video-fetch?url=...` proxy → `null` →
  `f.file('video-${n}-link.txt', ...)` (`components/App.tsx:459-462, 474-482`).
- `/api/video-fetch` itself returns specific, traceable errors when the **proxy** leg fails:
  `400` (SSRF guard rejected the URL, `app/api/video-fetch/route.ts:21-23`), `502
  {error:'source fetch failed'}` (upstream fetch threw/non-OK/no body, `:29-31`), `502
  {error:'not a video (login wall?)'}` (upstream `Content-Type` was `text/html`, `:33-35`),
  or a stream abort once piped bytes exceed the `maxMB` cap (default 100MB, clamped 5-300,
  `:20, 37-44`) — this last case terminates the response stream rather than returning a
  clean JSON error.
- Store-side import (`adapters/kissplay.ts`): the payload sends **URL + metadata only**
  (`url, poster_url, width, height, bytes, content_type`) for up to 2 kept videos — video
  bytes never transit this app; "the STORE downloads these server-side into its own R2"
  (`adapters/kissplay.ts:36-40`). The only signal scraper-pro receives back is the store's
  own `{ok, product_id, product_url}` / `{ok:false, error}` response
  (`adapters/kissplay.ts:60-65`) — if the store treats its own video-download failure as
  non-fatal to product creation, scraper-pro sees a plain `ok:true` with nothing indicating
  the video specifically failed.
  > ⚠️ TODO(owner): confirm how the store's `/api/scraper/import` endpoint surfaces a
  > video-download failure in its response — that endpoint lives in the destination store's
  > own codebase, not this repo.

**Mitigation**
- None needed for probe-time or ZIP-export failures — both are designed to degrade
  gracefully and require no operator action; the operator (or the store's own review UI)
  can always follow the link note / re-fetch manually.
- If `/api/video-fetch` is hitting the `maxMB` cap frequently, raise the per-request
  `maxMB` query param (client-controlled, clamped 5-300) or the `settings.maxVideoMB`
  default (clamped 5-300, `core/settings.ts:62`) — note this only affects the cap, not
  whether the source is reachable at all.
- If probes are consistently `probe:'failed'` for a given source host, that host likely
  blocks range requests or requires a session/referer this scraper doesn't send
  (`core/video.ts:79-84` sends a plain desktop `User-Agent` with a `Range` header, no
  cookies/referer) — this is a per-source limitation, not a bug to chase per incident.

**Escalation**
- For store-side video-download failures specifically, escalate to whoever owns the
  destination store's `/api/scraper/import` implementation — this repo cannot see or fix
  that side.

---

## Related docs

- [`docs/API-REFERENCE.md`](./API-REFERENCE.md) — full request/response/error-code
  reference for every route named above.
- [`docs/CONFIGURATION.md`](./CONFIGURATION.md) — every env var, its resolution order, and
  server-only vs. client-exposed status.
- [`docs/DATABASE.md`](./DATABASE.md) — `app_config`/`stores`/`users` schema, including the
  `ctr:<date>:<key>` counter convention reused for daily caps.
- [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) — manual deploy steps (needed to change an
  env-var-controlled cap) and the rollback procedure.
