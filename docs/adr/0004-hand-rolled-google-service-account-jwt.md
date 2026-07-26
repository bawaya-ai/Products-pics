> Generated: 2026-07-26 · Commit: 0f2c759 · Generator: make-docs

# ADR-0004: Hand-rolled Google service-account JWT instead of a client library

## Context

The app needs exactly one Google Cloud capability: a short-lived OAuth2 Bearer token to call
Google Vertex AI Search (Discovery Engine) for product-page/image search
(`core/discovery.ts:31-49`). The standard way to get that token is Google's own
`google-auth-library` (or the full `googleapis` package), which pulls in a non-trivial dependency
tree into what is otherwise a lean Vercel Node serverless function.

## Decision

`core/googleauth.ts:getGoogleAccessToken` implements the full service-account JWT-bearer OAuth2
flow using only `node:crypto`, with no Google auth SDK dependency:
- Accepts the raw service-account-key JSON or a base64-encoded copy (`parseSaKey()`,
  `core/googleauth.ts:12-22`).
- Builds the JWT header/claims and signs it RS256 with `createSign` (`:41-45`).
- Exchanges the signed JWT at the key's `token_uri` (default
  `https://oauth2.googleapis.com/token`) using the
  `urn:ietf:params:oauth:grant-type:jwt-bearer` grant (`:47-53`).
- Caches the resulting access token in-process, keyed by a SHA-256 fingerprint of
  `client_email|private_key|scope` (`:27,36-39`) — a rotated or forged key can never accidentally
  reuse a token minted from a different key.

The header comment states the intent directly: "Mints a short-lived OAuth2 access token from a
service-account key by signing a JWT (RS256) with node:crypto and exchanging it at the token
endpoint" (`core/googleauth.ts:1-5`).

## Consequences

- No extra dependency tree for a single OAuth2 exchange; `node:crypto` is already a zero-cost
  Node built-in, so this adds no npm packages and no meaningful bundle weight to the serverless
  function.
- Smaller function bundle can help cold-start latency on Vercel's Node runtime.
- The team owns correctness of the JWT-bearer flow itself — clock-skew handling, claim shape,
  error responses from the token endpoint — instead of relying on a maintained, widely-used
  library to absorb edge cases and future API changes.
- The implementation only supports the one flow it was built for (service-account JWT-bearer for
  a single scope). Adding a second Google auth mode (e.g. user-delegated OAuth, a different scope
  set) would mean writing new code here, not changing configuration.

> **(Inferred)** No comment in the code states the dependency-avoidance rationale explicitly as
> "we chose this over google-auth-library because..." — the ~50-line hand-rolled implementation
> and the header comment describing exactly the JWT-bearer flow are the direct evidence; the
> cold-start/bundle-size motivation is inferred from the fact that this app runs as a Vercel Node
> serverless function and only needs one narrow OAuth2 capability.
