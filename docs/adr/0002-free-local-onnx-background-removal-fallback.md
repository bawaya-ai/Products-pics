> Generated: 2026-07-26 · Commit: 0f2c759 · Generator: make-docs

# ADR-0002: A free, local ONNX background-removal fallback always exists

## Context

Clean transparent-background product cutouts are the core value proposition of the scraper. Paid
cutout providers (Replicate, remove.bg) need API keys and cost money per image, and a fresh
deployment — or an operator who hasn't set up billing yet — won't have either configured on day
one.

## Decision

`core/bgremove.ts`'s `'auto'` provider ladder is:
`[replicate if replicateKey] → [removebg if removebgKey] → 'local' (always) → [openai if allowOpenAIImages && openaiKey]`
(`core/bgremove.ts:42-49`).

`'local'` is included **unconditionally** — unlike the other three providers, it requires no key
check before being tried. `core/localbg.ts` runs U²-Net-family / ISNet segmentation models
in-process via `onnxruntime-node` (N-API, ABI-stable session, cached per-process,
`core/localbg.ts:37-60`); model weights auto-download once from GitHub Releases
(`danielgatis/rembg`) into `os.tmpdir()/scraper-pro-models/`, written atomically via a `.part` file
+ rename (`core/localbg.ts:18-33,47-54`). The header comment states it plainly: "`local` → U²-Net
family ONNX via onnxruntime-node (FREE, no key)" (`core/bgremove.ts:1-7`); `core/localbg.ts:1-6`:
"No API key, no external service."

The time-budget guard that skips *paid* providers when the deadline is close
(`remainingMs(deadlineAt) < 8000`, `core/bgremove.ts:55-58`) explicitly exempts `'local'`
(`provider !== 'local'`) — it costs no network round-trip to start, so it's never worth skipping
for time.

## Consequences

- The scraper's guaranteed-result fallback (`app/api/scrape/route.ts:186-204`, which reprocesses
  the top candidate with `bgMode:'off'` only when the whole per-image loop produced zero images)
  is backed by a chain that can always produce a *real cutout*, not "no background removal at
  all," even with zero provider keys configured anywhere.
- A brand-new deployment works out of the box for its primary feature before an operator adds any
  paid keys — there's no hard external dependency to reach first-run success.
- CPU-only inference inside a Vercel Node serverless function is slower and generally lower
  quality than the paid provider models (Replicate/remove.bg use dedicated segmentation
  infrastructure).
- The first request after a cold start (or the very first deployment) pays a one-time model-weight
  download from GitHub Releases before local inference can run.
- Quality is still gated: `hasRealCutout()` (`core/bgremove.ts:19-26`) requires the returned image
  to decode and contain real alpha transparency; a broken local result is rejected the same way a
  broken paid-provider result would be, so "always available" doesn't mean "never fails silently."
