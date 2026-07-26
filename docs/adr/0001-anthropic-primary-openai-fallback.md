> Generated: 2026-07-26 · Commit: 0f2c759 · Generator: make-docs

# ADR-0001: Anthropic primary, OpenAI fallback for enrichment and watermark detection

## Context

The scraper needs a vision-capable LLM for two jobs: product enrichment (trilingual name/
description, tags, price extraction, and per-image role curation — `core/enrich.ts`) and
watermark bounding-box detection (`core/watermark.ts`). Both run inside a hard per-request time
budget (`/api/scrape` has `maxDuration=300`, internal `TIME_BUDGET_MS=280_000`,
`app/api/scrape/route.ts:20,22`), and both need to keep working even if one AI vendor is down,
rate-limited, or refuses a request outright.

## Decision

Call Anthropic (Claude) first for both jobs:
- Enrichment: `callAnthropic()` (`core/enrich.ts:97-125,159-194`) — POSTs
  `https://api.anthropic.com/v1/messages` using **server-enforced structured outputs**
  (`output_config.format.type='json_schema'`, schema `ENRICH_SCHEMA`, `core/enrich.ts:52-69,176-177`).
  The in-code comment states this makes a `parse()` failure "impossible on this path"
  (`core/enrich.ts:175-177`).
- Watermark detection: `detectAnthropic()` (`core/watermark.ts:26-39`).

If Anthropic is unconfigured, errors, or returns a response `parse()` can't use (the `sawUnusable`
flag, `core/enrich.ts:127-145,196-217`), fall through to OpenAI as an independently try/caught,
independently billed second attempt:
- Enrichment fallback: `callOpenAI()` POSTs `https://api.openai.com/v1/chat/completions`
  (`model:'gpt-4o'`, `response_format:{type:'json_object'}`) — this only guarantees valid JSON,
  not schema conformance, a weaker guarantee than the Anthropic path.
- Watermark detect fallback: `detectOpenAI()` (`core/watermark.ts:41-51`).

The header comment in `core/enrich.ts:1-4` states the division of labor explicitly: "Claude:
product copywriting + vision classification. OpenAI GPT-4o: automatic fallback."

## Consequences

- A single vendor incident (outage, revoked key, rate limit, policy refusal) does not blank the
  whole enrichment or watermark-detection stage — the pipeline degrades to the second provider
  instead of failing outright.
- The primary path carries a stronger reliability guarantee (schema-enforced JSON) than the
  fallback path (valid-JSON-only), so a fallback response needs more defensive parsing
  (`core/enrich.ts:221-251` dedupes/bounds-checks image indices for exactly this reason).
- Two vendor integrations, two API keys, and two cost models to operate and monitor instead of
  one (`app/api/test/route.ts` probes both independently).
- Copy tone/quality can differ subtly between the two providers since each has its own prompt
  format and parser.

> **(Inferred)** The system prompt frames the target audience explicitly: "an adult (18+)
> intimate-products store in the Middle East" (`core/enrich.ts:28`), and the OpenAI bg-removal
> provider is marked opt-in specifically because it "may refuse adult products"
> (`core/bgremove.ts:6`). Whether content-sensitivity for this product category was an explicit
> factor in choosing Anthropic as primary is not stated verbatim in any comment — this rationale
> is inferred from the surrounding code, not quoted from it.
