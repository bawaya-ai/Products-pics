> Generated: 2026-07-26 · Commit: 2f26e26 · Generator: make-docs

# Architecture — scraper-pro

scraper-pro is a single Next.js application: one product-image/video scraping pipeline, one
Postgres database, and a set of external AI/search/storage providers it calls out to. There is
no separate backend service, no queue, and no worker fleet — every pipeline run executes inside
one Vercel serverless function for the lifetime of one HTTP request.

## 1. Context — who talks to the system

| Actor | What they do | Auth |
|---|---|---|
| **Operator** (role `operator`) | Runs the tool surface: scrape a URL or product name, review images/video/price, save to a store or download a ZIP | Signed session cookie, any role |
| **Admin** (role `admin`) | Everything an operator can do, plus `/admin`: manage provider keys, save-destination stores, and users | Signed session cookie, `role==='admin'`, DB-freshness-checked on mutations |
| **External "store" (Kiss Play)** | Receives finished product manifests via its own `/api/scraper/import` endpoint; downloads product video bytes itself | Shared secret token (`X-Scraper-Token`), issued by the store, stored encrypted here |
| **Source product sites** (arbitrary domains, e.g. Temu/AliExpress-class marketplaces) | Passive — the system fetches their pages/images/video headers | None (public HTTP) |
| **AI / search / storage providers** | Anthropic, OpenAI, Replicate, remove.bg, Firecrawl, Google (Vertex AI Search + Custom Search), Instagram, Resend, open.er-api.com, GitHub Releases | Per-provider API keys, resolved server-side (see [ADR-0003](./adr/0003-encrypted-config-in-postgres.md)) |

Exactly two roles exist system-wide — `admin` and `operator` (`components/App.tsx:12,34`, enforced
server-side in every admin route via `requireRoleFresh(req,'admin')`, e.g.
`app/api/users/route.ts:13,19,33,52`). There is no public/anonymous surface beyond the login and
password-reset pages.

## 2. Containers

```mermaid
graph TB
  Operator["Operator / Admin<br/>(browser, components/App.tsx)"]

  subgraph Vercel["scraper-pro — Vercel deployment"]
    Edge["Edge Middleware<br/>middleware.ts<br/>coarse cookie-presence gate only"]
    App["Next.js App Router<br/>app/api/*, app/page.tsx, app/admin/page.tsx<br/>Node runtime, requireRole / requireRoleFresh"]
    Onnx["In-process ONNX runtime<br/>onnxruntime-node (core/localbg.ts)<br/>no separate service"]
  end

  DB[("Neon Postgres<br/>app_config · stores · users")]

  Anthropic["Anthropic API<br/>enrichment + watermark detect"]
  OpenAI["OpenAI API<br/>fallback enrichment, watermark inpaint,<br/>opt-in bg removal"]
  Replicate["Replicate API<br/>bg removal"]
  RemoveBg["remove.bg API<br/>bg removal"]
  Firecrawl["Firecrawl API<br/>rendered-page fetch + search"]
  Discovery["Google Vertex AI Search<br/>(Discovery Engine)"]
  GoogleAuth["Google OAuth2<br/>token endpoint"]
  Cse["Google Custom Search<br/>JSON API"]
  Instagram["Instagram<br/>public HTML / CDN"]
  Fx["open.er-api.com<br/>currency rates"]
  Resend["Resend<br/>password-reset email"]
  Store["External store (Kiss Play)<br/>/api/scraper/import"]
  GitHub["GitHub Releases<br/>ONNX model weights"]
  SourceSite["Source product site<br/>(arbitrary domain)"]

  Operator -->|HTTPS| Edge
  Edge -->|cookie present? redirect only| App
  App -->|SQL over TLS| DB
  App --> Onnx
  App -->|"vision + copy (ADR-0001)"| Anthropic
  App -->|fallback| OpenAI
  App -->|"bg removal ladder (ADR-0002)"| Replicate
  App --> RemoveBg
  App --> Firecrawl
  App -->|"search (ADR-0004)"| Discovery
  Discovery --> GoogleAuth
  App --> Cse
  App --> Instagram
  App --> Fx
  App --> Resend
  App -->|"manifest + image bytes, video = URL only (ADR-0005)<br/>source_url -> optional duplicate flag (ADR-0007)"| Store
  App -->|one-time weight download| GitHub
  App -->|fetch page / images / video headers| SourceSite
  Store -->|downloads video bytes itself| SourceSite
```

Containers, not services — everything under "Vercel deployment" above is **one deployable unit**:

| Container | Runtime | Responsibility |
|---|---|---|
| Edge Middleware (`middleware.ts`) | Vercel Edge | Redirects unauthenticated page requests to `/login`; redirects the `admin.` subdomain's `/` to `/admin`. Deliberately does **not** import `core/auth` — checks cookie *presence* only, not validity (`middleware.ts:6-7,12`). Not the security boundary. |
| Next.js App Router (`app/**`) | Vercel Node serverless functions, `runtime='nodejs'`, `dynamic='force-dynamic'` on every route | Every API route, every page, the single client component `components/App.tsx` (992 lines) that renders both the operator tool surface and the admin surface. |
| In-process ONNX runtime (`core/localbg.ts`) | Same Node function, no network service | Free local background-removal fallback; model weights cached in `os.tmpdir()`. |
| Neon Postgres | Managed serverless Postgres (`@neondatabase/serverless`) | Three tables: `app_config` (encrypted provider keys + admin settings + daily-usage counters), `stores` (save destinations), `users` (auth + roles + reset tokens). See [ADR-0003](./adr/0003-encrypted-config-in-postgres.md). |

## 3. Key components (pipeline)

| Component | File | Responsibility |
|---|---|---|
| Auth | `core/auth.ts` | Stateless HMAC-signed session cookies, `requireRole`/`requireRoleFresh` guards, reset tokens. |
| Settings resolver | `core/settings.ts` | DB → env → client-supplied resolution for every provider key/setting; `configStatus()`, `saveConfigKeys()`. |
| Extract | `core/extract.ts` | URL → candidate images/videos/page text. SSRF guard, JSON-LD-first parsing, Firecrawl render escalation. |
| Select | `core/select.ts` | Download pool → measure real dimensions → perceptual dedup → rank → shortlist. See [ADR-0006](./adr/0006-perceptual-hash-image-dedup.md). |
| Web search | `core/websearch.ts` | Text-query → image URLs, provider ladder (Instagram / Discovery Engine / merge / Google CSE / Firecrawl). |
| Discovery Engine client | `core/discovery.ts` | Google Vertex AI Search calls for product pages/images. |
| Google auth | `core/googleauth.ts` | Hand-rolled service-account JWT → OAuth2 Bearer token. See [ADR-0004](./adr/0004-hand-rolled-google-service-account-jwt.md). |
| Instagram | `core/instagram.ts` | Public post/reel media extraction, 3-rung escalating ladder. |
| Video probe | `core/video.ts` | Range-GET + magic-byte/box parsing to measure video candidates without downloading them. See [ADR-0005](./adr/0005-store-side-video-download.md). |
| Enrich | `core/enrich.ts` | AI copywriting (en/ar/he) + image-role curation, Anthropic → OpenAI. See [ADR-0001](./adr/0001-anthropic-primary-openai-fallback.md). |
| Watermark | `core/watermark.ts` | Vision-detect + inpaint an overlaid watermark/logo on the main image only. |
| Background removal | `core/bgremove.ts` | Provider chain: Replicate → remove.bg → local (always) → OpenAI (opt-in). See [ADR-0002](./adr/0002-free-local-onnx-background-removal-fallback.md). |
| Local ONNX cutout | `core/localbg.ts` | U²-Net/ISNet inference via `onnxruntime-node`, no key, no external call. |
| Process | `core/process.ts` | Sharp pipeline: watermark → cutout → trim → pad → tone → multi-format encode with byte-cap enforcement. |
| Currency | `core/currency.ts` | Live-rate → ILS conversion, price cross-check helper, fallback rate table. |
| Budget | `core/budget.ts` | Deadline-aware timeout helpers threaded through every provider call. |
| DB | `core/db.ts` | AES-256-GCM encrypt/decrypt, scrypt password hashing, all SQL (`app_config`/`stores`/`users`). |
| Save adapter | `adapters/kissplay.ts` | Manifest → the Kiss Play store's `/api/scraper/import`; surfaces the store's duplicate-save short-circuit. See [ADR-0007](./adr/0007-duplicate-save-protection.md). |
| UI | `components/App.tsx`, `app/page.tsx`, `app/admin/page.tsx`, `app/login/page.tsx`, `app/reset/page.tsx` | Single client component switched by a server-set `mode: 'tool' \| 'admin'` prop; standalone login/reset pages. |

## 4. Flows

The four flows below are traced from the actual route handlers and core modules, not inferred
from UI copy. NDJSON events shown match the `ProgressEvent` union (`core/types.ts:59-66`).

### 4.1 Scrape a product URL — `POST /api/scrape` (URL branch)

```mermaid
sequenceDiagram
  actor U as "Operator (browser)"
  participant Rt as "POST /api/scrape"
  participant Auth as "core/auth (requireRole)"
  participant DB as "Neon (bumpCounter)"
  participant Ex as "core/extract (extractMedia)"
  participant Src as "Source site"
  participant Fc as "Firecrawl"
  participant Vid as "core/video (probeVideos)"
  participant Sel as "core/select (selectPool)"
  participant Enr as "core/enrich"
  participant Anth as "Anthropic"
  participant Oai as "OpenAI"
  participant Proc as "core/process (Sharp)"
  participant Bg as "core/bgremove"
  participant Cur as "core/currency"

  U->>Rt: POST {url, settings}
  Rt->>Auth: requireRole(req)
  Auth-->>Rt: session (or 401)
  Rt->>DB: bumpCounter("scrape:"+uid)
  DB-->>Rt: count (429 if over DAILY_RUN_CAP)
  Rt->>Ex: extractMedia(url, settings)
  Ex->>Ex: assertPublicUrl (SSRF guard)
  Ex->>Src: GET page (desktop UA)
  Note over Ex: JSON-LD parsed FIRST (authoritative price/images)
  alt bot-wall detected OR fewer than 3 candidates
    Ex->>Fc: POST /v1/scrape (rendered HTML, waitFor 3500ms)
    Fc-->>Ex: rendered HTML
    Ex->>Ex: re-run JSON-LD + harvest
  end
  Ex-->>Rt: candidateUrls, videoCandidates, ldPrice, pageText
  par video probe (not awaited yet)
    Rt->>Vid: probeVideos(videoCandidates, 8s budget)
  and image selection
    Rt->>Sel: selectPool(candidateUrls)
    Sel->>Src: parallel image downloads (concurrency 6)
    Sel->>Sel: measure real dims, perceptual dedup (aHash), rank
    Sel-->>Rt: shortlist + 448px thumbnails
  end
  Rt->>Enr: enrich(thumbnails, pageText)
  Enr->>Anth: POST /v1/messages (json_schema structured output)
  alt Anthropic unconfigured, errored, or unusable
    Enr->>Oai: POST /v1/chat/completions (response_format json_object)
  end
  Enr-->>Rt: name/description/tags/price/imageRoles + {type:'cost'}
  Rt->>Rt: price cross-check vs ldPrice / mined PRICE CANDIDATES
  loop each kept image (deadline- and abort-aware)
    Rt->>Proc: processImage(buf, settings, deadlineAt)
    Proc->>Bg: removeBackground(...)
    Bg-->>Proc: cutout bytes (provider chain, local always available)
    Proc-->>Rt: ProcessedImage {dataUrl, width, height, bgProvider,...}
    Rt-->>U: {type:'image', status:'done'} (NDJSON line)
  end
  Rt->>Vid: await videoTask
  Vid-->>Rt: ManifestVideo[]
  Rt->>Cur: toILS(amount, currency)
  Cur-->>Rt: converted price
  Rt-->>U: {type:'result', manifest} (NDJSON, stream closes)
```

Source: `app/api/scrape/route.ts` (orchestrator), `core/extract.ts`, `core/select.ts`,
`core/enrich.ts`, `core/process.ts`, `core/bgremove.ts`, `core/currency.ts`, `core/video.ts`.

In-stream error conditions (e.g. no candidate images found, all image processing fails) are sent
as `{type:'error', message}` NDJSON events at HTTP 200, since headers are already flushed by the
time an error can occur — the client must inspect the stream, not the status code.

### 4.2 Search by product name — `core/websearch.ts` provider ladder

```mermaid
sequenceDiagram
  actor U as "Operator (browser)"
  participant Rt as "POST /api/scrape (text-query branch)"
  participant Ws as "core/websearch (searchImages)"
  participant Ig as "core/instagram"
  participant Disc as "core/discovery"
  participant GAuth as "core/googleauth"
  participant Cse as "Google CSE"
  participant Fc as "Firecrawl"

  U->>Rt: POST {url: "free-text product name", settings}
  Rt->>Ws: searchImages(query, settings)
  Ws->>Ws: check 1h warm-lambda cache (provider|instagramSearch|query)
  par optional (instagramSearch=true)
    Ws->>Ig: instagramMedia(query) via Promise.race(30s timeout)
  and provider ladder (gated by s.searchProvider + key presence)
    alt googleSaKey set (auto/discovery/merge)
      Ws->>Disc: discoverySearch(query)
      Disc->>GAuth: getGoogleAccessToken(saKey)
      GAuth-->>Disc: cached or freshly minted Bearer token
      Disc-->>Ws: product page URLs
      Ws->>Fc: scrape top 3 pages for high-res images
      Fc-->>Ws: image URLs
    else googleCseKey + googleCseCx set (auto/google)
      Ws->>Cse: GET /customsearch/v1?searchType=image
      Cse-->>Ws: image URLs, sorted by resolution
    else firecrawlKey set (auto/firecrawl)
      Ws->>Fc: POST /v1/search (top 4 result pages)
      Fc-->>Ws: page HTML
      Ws->>Ws: harvest images from each page
    end
  end
  Ws-->>Rt: candidateUrls (unioned/merged), warnings
  Note over Rt: converges into the same pipeline as 4.1<br/>from selectPool() onward
  Rt-->>U: NDJSON progress events, then {type:'result'}
```

Source: `app/api/scrape/route.ts:81-92` (text-query branch), `core/websearch.ts:36-154`
(`searchImages`/`searchImagesUncached`), `core/discovery.ts`, `core/googleauth.ts`,
`core/instagram.ts`. The same ladder, entered via `searchProductPages()`
(`core/websearch.ts:158-204`), also powers `POST /api/discover`'s category/listing mode.

### 4.3 Save to store — `POST /api/save` → `adapters/kissplay.ts`

```mermaid
sequenceDiagram
  actor U as "Operator (browser)"
  participant Rt as "POST /api/save"
  participant Auth as "core/auth (requireRole)"
  participant Set as "core/settings (resolveSettings)"
  participant DBd as "Neon (getStoreResolved / getDefaultStoreResolved)"
  participant Ad as "adapters/kissplay"
  participant St as "External store (Kiss Play)"

  U->>Rt: POST {manifest, adapter, storeId?}
  Rt->>Auth: requireRole(req)
  Auth-->>Rt: session (or 401)
  Rt->>Set: resolveSettings(body.settings)
  alt storeId given and DB configured, storeId != 'env'
    Rt->>DBd: getStoreResolved(storeId)
    DBd-->>Rt: store row (token decrypted) or none
  else DB configured, no storeId
    Rt->>DBd: getDefaultStoreResolved()
    DBd-->>Rt: default store row or none
  else DB not configured or storeId == 'env'
    Rt->>Rt: fall back to legacy s.storeBase / s.storeToken
  end
  alt resolved store has no base_url or token
    Rt-->>U: 400 {ok:false, error}
  else
    Rt->>Ad: saveToKissPlay(manifest, settings)
    Ad->>Ad: keep non-'skip' images, sort main-first
    Ad->>Ad: hasPrice gate -> is_active:false if no reviewed positive price
    Ad->>St: POST {storeBase}/api/scraper/import<br/>X-Scraper-Token header<br/>source_url, images: b64, videos: URL+metadata only
    alt store matches source_url to an existing product (ADR-0007)
      St-->>Ad: {ok:true, duplicate:true, product_id, product_url}<br/>short-circuits before creating a new product
    else no match -> create product
      St-->>Ad: {ok:true, product_id, product_url} or {ok:false, error}
    end
    Ad->>Ad: read d.duplicate off the store's JSON response
    Ad-->>Rt: SaveResult {ok, productId, productUrl, duplicate}
    Rt-->>U: 200 (r.ok) or 502 (adapter failure)
  end
```

Source: `app/api/save/route.ts:14-45`, `adapters/kissplay.ts:11-66`, `core/db.ts:97-107` (token
decryption inside `resolveRow()`). The `is_active:false`-on-no-price safety invariant
(`adapters/kissplay.ts:20-23,33`) means nothing goes live at ₪0 regardless of the `publish` setting.

The store enforces idempotency by `source_url`; this app only surfaces the result. This app
already sent `source_url: m.sourceUrl` in the payload (`adapters/kissplay.ts:34`) before the store
added the check — no payload change was needed here, only reading the extra `duplicate` field off
the response (`adapters/kissplay.ts:62`) and forwarding it through `NextResponse.json(r, ...)`
unchanged (`app/api/save/route.ts:40-41`). The UI treats a duplicate as a successful save, not an
error: `save()` shows "↩ محفوظ مسبقًا" instead of "✓ انحفظ بالمتجر" (`components/App.tsx:416`), and
batch-mode `saveProduct()` logs a warn-level "↩ منتج N محفوظ مسبقًا" line while still marking the
product saved (`components/App.tsx:434,436`). See
[ADR-0007](./adr/0007-duplicate-save-protection.md). This repo does not implement or control the
store's matching logic (schema, indexing, SQL) — that lives in a different repo; see
[Boundaries](#6-boundaries--what-this-system-deliberately-does-not-do).

### 4.4 Video probe + download

```mermaid
sequenceDiagram
  actor U as "Operator (browser)"
  participant Rt as "POST /api/scrape"
  participant Vid as "core/video (probeVideos)"
  participant Src as "Source CDN"
  participant Save as "POST /api/save"
  participant Ad as "adapters/kissplay"
  participant St as "External store"
  participant Vf as "GET /api/video-fetch"

  Note over Rt,Src: 1. Probe during scrape — headers only, no full download
  Rt->>Vid: probeVideos(videoCandidates)
  loop up to 6 candidates, in parallel
    Vid->>Src: Range GET, first 256KB (assertPublicUrl SSRF guard)
    Src-->>Vid: partial bytes + headers
    Vid->>Vid: detect ftyp/EBML magic bytes, parse moov/mvhd/tkhd
  end
  Vid-->>Rt: ManifestVideo[] {url, width, height, bytes, probe, keep}
  Rt-->>U: {type:'result'} includes manifest.videos

  Note over U,St: 2a. Save to store — store downloads the bytes itself
  U->>Save: POST {manifest}
  Save->>Ad: saveToKissPlay(manifest)
  Ad->>St: POST /api/scraper/import {videos:[{url, poster_url, width, height,...}]}
  St->>Src: GET full video (store fetches server-side into its own storage)
  St-->>Ad: {ok, product_url}

  Note over U,Vf: 2b. ZIP export — browser downloads directly, proxy is the fallback
  U->>Src: fetch(video.url) direct (free bandwidth)
  alt source CDN blocks CORS
    U->>Vf: GET /api/video-fetch?url=...&maxMB=100
    Vf->>Vf: assertPublicUrl (SSRF guard)
    Vf->>Src: GET video (spoofed desktop UA, 280s abort timeout)
    Src-->>Vf: video byte stream
    Vf->>Vf: counting TransformStream enforces maxMB cap
    Vf-->>U: streamed bytes, Content-Type passed through, no buffering
  end
  U->>U: bundle into ZIP (jszip) with images, manifest.json, description.md
```

Source: `core/video.ts` (probe), `adapters/kissplay.ts:36-40,53-59` (store-side download comment
and the widened 280s timeout), `app/api/video-fetch/route.ts` (proxy fallback), `components/App.tsx:459-462`
(client tries a direct fetch before falling back to the proxy). See
[ADR-0005](./adr/0005-store-side-video-download.md).

## 5. Key design decisions

Inline pointers into the ADR log — see each file for Context/Decision/Consequences:

- AI provider order for enrichment and watermark detection — [ADR-0001](./adr/0001-anthropic-primary-openai-fallback.md)
- Background-removal ladder always has a free, keyless fallback — [ADR-0002](./adr/0002-free-local-onnx-background-removal-fallback.md)
- Provider keys and store tokens live encrypted in Postgres, not only in env vars — [ADR-0003](./adr/0003-encrypted-config-in-postgres.md)
- Google service-account auth is hand-rolled, not a library — [ADR-0004](./adr/0004-hand-rolled-google-service-account-jwt.md)
- Video bytes never transit this app at scrape time — [ADR-0005](./adr/0005-store-side-video-download.md)
- Image dedup is content-aware (perceptual hash), not URL-based — [ADR-0006](./adr/0006-perceptual-hash-image-dedup.md)
- Duplicate-save protection is enforced store-side by `source_url`; this app surfaces the result — [ADR-0007](./adr/0007-duplicate-save-protection.md)

## 6. Boundaries — what this system deliberately does NOT do

- **Never stores video bytes itself.** The probe stage Range-GETs only the first 256KB of each
  candidate (`core/video.ts:82`). At save time, the destination store downloads the full video
  server-side from the original source URL — this app forwards `{url, poster_url, width, height,
  bytes, content_type}`, never bytes (`adapters/kissplay.ts:38-40`). See
  [ADR-0005](./adr/0005-store-side-video-download.md). The one partial exception is the
  client-initiated ZIP-export fallback proxy (`GET /api/video-fetch`), which streams bytes through
  without buffering the whole file, only when the browser's own direct fetch is CORS-blocked.
- **No queue, no worker fleet, no background jobs.** Every scrape, discover, or save request runs
  synchronously inside one Vercel Node serverless function for the duration of that HTTP request
  (`maxDuration: 300` on `/api/scrape`, `/api/save`, `/api/video-fetch`, `vercel.json:1-8`). There
  is no job table, no retry queue, and no process outside the request/response cycle.
- **CI is type-check-only — no test suite, no CD.** `.github/workflows/typecheck.yml` runs on every
  push/PR to `master`: checkout → pnpm 9 → Node 22 → `pnpm install --frozen-lockfile
  --ignore-scripts` → `pnpm typecheck` (`tsc --noEmit`). This is the repo's first CI of any kind
  and closes the gap previously documented here, but it stays narrow on purpose: `--ignore-scripts`
  skips `sharp`/`onnxruntime-node`'s native postinstall builds because the type-check only needs
  their `.d.ts` files, which keeps the job fast and avoids native-build flakiness
  (`.github/workflows/typecheck.yml:28-30`). There is still no automated test suite (`package.json`
  has no `test` script) and no ESLint config, and CI does not deploy anything — deploys stay
  manual: `vercel` for preview, `vercel --prod` for production.
- **No client-bundled secrets.** A repo-wide grep for `NEXT_PUBLIC_*` finds no matches — every
  provider key and store token stays server-side; the client only ever sees boolean "is a key
  configured" flags (`GET /api/status`, `GET /api/config`).
- **Edge middleware is not the security boundary.** `middleware.ts` checks session-cookie
  *presence* only, for coarse page-level redirects. Every API route independently re-verifies the
  signed cookie and role via `requireRole`/`requireRoleFresh` in `core/auth.ts` running in the
  Node runtime (`core/auth.ts:3-5`).
- **No HLS/ffmpeg support.** Pages that only expose `.m3u8` video get a warning but no video
  output — there is no ffmpeg in this stack (`core/extract.ts:65-68,78,200,280-287`).
- **No video transcoding of any kind.** The probe stage parses container metadata (magic bytes,
  `moov`/`mvhd`/`tkhd` boxes) from partial Range responses; it never decodes, re-encodes, or
  generates thumbnails from video frames server-side.
- **No filesystem persistence for processed media.** Images are held in memory as Sharp buffers
  and shipped to the client as base64 `dataUrl`s inside the NDJSON stream and the final manifest;
  nothing is written to local disk except the one-time ONNX model-weight cache in `os.tmpdir()`.
- **No schema migrations, no ORM.** The Postgres schema is not version-controlled anywhere in the
  repo — table shape is inferred entirely from the hand-written SQL in `core/db.ts` (confirmed: no
  `CREATE TABLE`/migration file exists in the tree).
- **No multi-tenant/organization layer.** Exactly two roles exist, `admin` and `operator`
  (`core/auth.ts:14`) — there is no concept of teams, workspaces, or per-customer isolation beyond
  the `stores`/`users` tables.
- **No IP-based rate limiting or WAF.** The only throttling is a per-user daily counter on
  `/api/scrape` (`DAILY_RUN_CAP`, default 400) and `/api/discover` (`DAILY_DISCOVER_CAP`, default
  150), both stored as `app_config` rows keyed by day and user id (`core/db.ts:79-86`).
- **No duplicate-detection logic of its own.** This app never owns product storage, so it cannot
  independently know whether a manifest it's about to save already exists as a live product — that
  check (matching on `source_url`) runs store-side. This app only reads the `duplicate` field the
  store returns and surfaces it to the operator (`adapters/kissplay.ts:62`). See
  [ADR-0007](./adr/0007-duplicate-save-protection.md).
