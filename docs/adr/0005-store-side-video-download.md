> Generated: 2026-07-26 · Commit: 0f2c759 · Generator: make-docs

# ADR-0005: Store-side video download instead of proxying bytes through this app

## Context

Product videos can run from a few to tens of megabytes. Vercel serverless functions enforce
request/response body-size limits, and this app already ships processed images to the destination
store as base64 inside a JSON payload — doing the same for video would inflate the payload further
and risk hitting those limits outright.

## Decision

Video bytes never transit this server at scrape time. `core/video.ts` only Range-GETs the first
256KB of each candidate to probe container type, dimensions, and duration
(`core/video.ts:82,92-93,120-158`) — the full file is never fetched during scraping. The header
comment states the contract directly: "Video BYTES never transit this server at scrape time — the
store downloads them server-side at save, and the ZIP downloads them in the browser."
(`core/video.ts:6-8`).

At save time, `adapters/kissplay.ts` sends the destination store only URL + metadata per video —
`{url, poster_url, width, height, bytes, content_type}` (`adapters/kissplay.ts:38-40`) — never the
video bytes themselves. The in-code comment is explicit: "the STORE downloads these server-side
into its own R2 — bytes never transit this tool (Vercel body limits make base64 video
impossible)" (`adapters/kissplay.ts:36-37`). The save request's fetch timeout to the store is
deliberately widened to 280s specifically to give the store time to perform that download itself
(`adapters/kissplay.ts:57-59`).

For the client-side ZIP-export path, the browser attempts a direct cross-origin fetch of the video
first (free bandwidth, no server involvement). Only when the source CDN blocks that with CORS does
the client fall back to `GET /api/video-fetch` — a streaming proxy that pipes bytes through without
buffering the full file in memory, enforces an SSRF guard (`assertPublicUrl`) and a `maxMB` byte
cap via a counting `TransformStream` (`app/api/video-fetch/route.ts:19-23,37-44`).

## Consequences

- Avoids Vercel's request/response body-size limits on this app's own functions — video never
  needs to be base64-encoded into a JSON payload here.
- Avoids double egress (fetch the video once into this app, then re-upload it once to the store)
  and avoids holding a Node function open for the full duration of a large video transfer during
  the main scrape/save request cycle.
- The destination store must implement its own server-side video-download step to actually ingest
  video content; this app has no way to guarantee that download succeeds, retry it, or verify the
  result — it only forwards the URL and whatever metadata the probe stage measured.
- `GET /api/video-fetch` is a deliberate, scoped exception to "bytes never transit this server": it
  exists specifically for the client-initiated ZIP-export fallback (when direct browser fetch is
  CORS-blocked), still holds a Node function open for up to 300s (`maxDuration=300`,
  `app/api/video-fetch/route.ts:12`), and streams rather than buffers to bound memory use.
- Because only a 256KB Range slice is probed, video metadata is a best-effort measurement — an
  inconclusive probe is deliberately *kept* as `probe:'partial'` rather than dropped (see
  `core/video.ts:5-6,94-97`), so a real video is never discarded just because the probe couldn't
  fully characterize it.
