> Generated: 2026-07-26 · Commit: 2f26e26 · Generator: make-docs

# ADR-0007: Duplicate-save protection via store-side source_url check

## Context

`POST /api/save` runs inside a single Vercel Node serverless function and forwards the manifest
to the external store's `/api/scraper/import` endpoint over a single `fetch` with a 280s timeout
(`adapters/kissplay.ts:52-59`). A double-click on the save button, or a client retry after a
request that actually committed on the store's side but whose response was lost — a timeout, a
network drop between the store's response and this app receiving it — could resubmit the same
manifest. Without any idempotency check, that resubmission would create a second live product on
the store for the same source, indistinguishable from a genuinely new one.

## Decision

The destination store (Kiss Play — a separate repo/system, not part of this codebase) now checks
the submitted `source_url` against its existing products *before* creating anything, and responds
`{ok:true, duplicate:true, product_id, product_url}` for an exact match instead of creating a
second product. This app already sent `source_url: m.sourceUrl` in the save payload before this
change (`adapters/kissplay.ts:34`); no payload change was needed on this side — only the response
gained the extra `duplicate` field.

This app's role is limited to surfacing that field to the operator, not enforcing the check
itself:

- `adapters/kissplay.ts`'s `SaveResult` interface gained an optional `duplicate?: boolean`
  (`adapters/kissplay.ts:9`), and `saveToKissPlay()` reads it off the store's JSON response:
  `return { ok: true, productId: d.product_id, productUrl: d.product_url, duplicate:
  Boolean(d.duplicate) }` (`adapters/kissplay.ts:62`).
- `app/api/save/route.ts` required no code change — it already forwards the adapter's full result
  object verbatim via `NextResponse.json(r, ...)` (`app/api/save/route.ts:40-41`), so `duplicate`
  flows through to the client automatically.
- `components/App.tsx` branches on `d.duplicate` in both save paths, and treats a duplicate as a
  successful outcome, not an error:
  - single-product `save()` shows "↩ محفوظ مسبقًا — فتحنا نفس المنتج بدل ما ننشئ نسخة ثانية
    (`<productId>`)" instead of the normal "✓ انحفظ بالمتجر" message (`components/App.tsx:416`).
  - batch-mode `saveProduct()` pushes a warn-level log line "↩ منتج N محفوظ مسبقًا — فتحنا نفس
    النسخة" (`components/App.tsx:436`); the product is still marked saved (`components/App.tsx:434`).

> ⚠️ Inferred: the store's match is by exact `source_url` string equality and runs before product
> creation. This repo's code only observes the resulting `duplicate` flag on the response, not the
> store's matching logic itself — the store's schema, indexing, and match implementation live in a
> different repo and are out of scope here, consistent with the "Boundaries" framing in
> [ARCHITECTURE.md](../ARCHITECTURE.md#6-boundaries--what-this-system-deliberately-does-not-do) that
> this app never owns product storage.

## Consequences

- Protects against the double-click / lost-response-after-commit scenario: a retried save no
  longer silently creates a second live product for the same source.
- This app cannot enforce the guarantee alone — it relies entirely on the external store's
  cooperation to perform the `source_url` check before creating a product. If the store's check
  were ever removed or bypassed, this app has no independent duplicate-detection of its own to
  fall back on.
- The check is by exact `source_url` match, which is a deliberate, narrow definition of
  "duplicate": a product that was genuinely re-scraped or hand-edited into a different manifest
  (new images, new copy, a corrected price) but shares the same source URL is still treated as the
  same product on purpose — the operator gets routed back to the existing listing rather than
  getting a second copy to reconcile.
- `duplicate:true` is surfaced as `ok:true` end-to-end (`adapters/kissplay.ts:62`,
  `app/api/save/route.ts:41`) — callers that only check `r.ok`/`d.ok` will not distinguish a fresh
  save from a duplicate short-circuit without also reading the `duplicate` field.
