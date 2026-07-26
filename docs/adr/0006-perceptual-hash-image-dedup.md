> Generated: 2026-07-26 · Commit: 0f2c759 · Generator: make-docs

# ADR-0006: Perceptual-hash image dedup instead of exact-URL dedup

## Context

This scraper's real-world sources are marketplace-style sites (the code comment names
Temu/AliExpress-class sites, `core/extract.ts:132`) that routinely serve the *same physical
product photo* at many different CDN URLs — different sizes, crops, cache-busting query strings,
or even entirely different hostnames. An exact-URL dedup would treat every one of those variants
as a distinct image, wasting a paid background-removal call on a true duplicate and cluttering the
AI-curation shortlist with redundant angles of the same shot.

## Decision

Dedup happens in two passes, in order, each addressing a different variant type:

1. **Cheap URL-shape pre-filter**, in `core/extract.ts` — `baseKey()` strips known CDN size-suffix
   patterns (`_400x400`, `-800x800`, `_600w`-style) before comparing URLs (`core/extract.ts:40-42`)
   — catches obvious same-family variants without downloading anything.
2. **Perceptual-hash dedup on downloaded pixels**, in `core/select.ts` — an 8×8 greyscale
   average-hash (`aHash`, `:26-34`) with Hamming distance ≤6 (`hamming`, `:35-39,75`) flags
   near-duplicate images; on a hit, the copy with more megapixels is kept (`:74-77`). This only
   runs when `settings.dedup !== false`.

The header comment in `core/select.ts:1-4` states the ordering rationale directly: "Cheap
pre-filter that runs BEFORE the expensive background removal, so we only process the
highest-resolution, non-duplicate candidates." The comment at `core/select.ts:72-73` names the
specific failure mode this design avoids: "arrival order must not let a 300px thumbnail
permanently evict its own 2000px original" — whichever URL variant happens to be seen first must
not win by default; the higher-resolution copy always wins regardless of discovery order.

## Consequences

- Catches near-identical *content* regardless of URL shape, host, or query string — something an
  exact-URL or even a normalized-URL comparison cannot do, since the underlying bytes served at
  different URLs can be pixel-identical or near-identical crops/resizes of the same source photo.
- Saves paid background-removal spend by not processing true duplicates, and keeps the
  AI-curation shortlist focused on genuinely distinct product views.
- Requires the pixels to already be downloaded before this pass can run — it necessarily executes
  after (not instead of) the cheaper URL-based pre-filter in `extract.ts`, and after the
  per-candidate download cost has already been paid.
- A perceptual hash is a heuristic: Hamming distance ≤6 on an 8×8 average-hash can, in principle,
  collide two genuinely different but visually similar product photos (e.g. two colorways of the
  same product shot the same way), or fail to catch two truly-duplicate images that were cropped
  or rotated enough to shift the hash beyond the threshold.
