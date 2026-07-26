> Generated: 2026-07-26 · Commit: 0f2c759 · Generator: make-docs

# ADR-0003: AES-256-GCM encrypted config in Postgres instead of env-vars-only

## Context

The app holds provider API keys (Anthropic, OpenAI, Replicate, remove.bg, Firecrawl, Google, ...)
and, since it supports multiple save destinations, one import token *per destination store*. A
Vercel env var can express exactly one value per name and requires a redeploy to change — it
fundamentally cannot express "N stores, each with its own token," and every key rotation would
otherwise mean a redeploy.

## Decision

`core/db.ts:20-44` implements symmetric encryption at rest:
- `keyBuf()` derives the encryption key as SHA-256 of `APP_SECRET`, falling back to the literal
  `'dev-insecure-change-me'` outside production, and **fails closed in production** — it throws if
  `NODE_ENV==='production'` and `APP_SECRET` is unset or under 16 characters (`core/db.ts:24-26`).
- `encrypt(plain)` / `decrypt(enc)` use `aes-256-gcm` with a random 12-byte IV per call, stored as
  `iv.base64 . authTag.base64 . ciphertext.base64` (`core/db.ts:29-44`); `decrypt` returns `''` on
  any parse/verify failure rather than throwing.

`core/settings.ts:57-78` (`resolveSettings`) is the canonical resolver for every provider-key
setting, in this order: **DB (`app_config`, admin-editable) → `process.env` → client-supplied
value**. `saveConfigKeys()` (`core/settings.ts:97-106`) persists admin-panel-entered keys to
`app_config`, encrypting every key except an explicit `NON_SECRET` allowlist of non-sensitive
values — URLs, ids, sender addresses (`core/settings.ts:54`). The `stores` table stores each save
destination's import token encrypted per-row (`stores.token_enc`, `core/db.ts:88-127`) — one
encrypted secret per store, not one shared env var.

Exception: `storeBase`/`storeToken` are resolved **server-only** — they never fall back to a
client-supplied value, specifically to prevent an attacker pairing a malicious `storeBase` with
the server's real `storeToken` and exfiltrating it (`core/settings.ts:71-74`, comment cited
verbatim in the facts sheet).

## Consequences

- Admins can rotate or add provider keys, and add/edit/delete multiple destination stores, from
  the in-app admin UI at runtime — no redeploy required for any of it.
- Secrets stay encrypted at rest even if the Postgres data itself leaks (defense in depth beyond
  connection-string/network access control).
- `APP_SECRET` becomes a single point of failure shared by two unrelated concerns: it derives both
  the AES-256-GCM key for config-at-rest (`core/db.ts:22-28`) and the HMAC key for session cookies
  (`core/auth.ts:18-24`). Losing or rotating `APP_SECRET` invalidates every stored encrypted secret
  *and* every live session simultaneously.
- Every DB-backed feature (encrypted config, stores CRUD, users CRUD) hard-requires
  `DATABASE_URL`; those routes return `503` without it (`core/db.ts:18`, e.g.
  `app/api/config/route.ts` POST, `app/api/stores/route.ts` POST/DELETE, `app/api/users/route.ts`
  POST) — the app has no in-memory or file-based fallback for this data.
- One resolution path is intentionally *not* covered by `resolveSettings`: `core/mailer.ts:7-14`
  re-resolves `RESEND_API_KEY`/`RESEND_FROM` independently (DB → env), a small duplicated code
  path for the same DB-first pattern rather than a shared one.
