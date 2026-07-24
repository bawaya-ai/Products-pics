# 🛒 Scraper Pro

Universal product scraper: paste a product URL → get **background-free, unified-size,
high-quality images** + AI-written copy → push into **any store** via adapters.

Built as a standalone **Next.js app for Vercel** (Node runtime, so `sharp` + local
ONNX cutout models run natively). Reusable across projects — the core is
store-agnostic; each project plugs a small adapter.

---

## What it does

```
URL → extract media → per image: fetch → remove background → unify size/quality
    → AI enrich (name/description/translation + image roles) → preview/edit → save
```

- **Extraction** — URL query params (Temu `top_gallery_url`), `og:image`, `<img>`/`srcset`,
  inline-JSON image links, and optional **Firecrawl** rendered fetch for JS-heavy pages.
- **Background removal** — best-available chain: **Replicate** (BiRefNet/RMBG) → **remove.bg**
  → **free local ISNet ONNX** (no key, model auto-downloads once) → optional OpenAI image edit.
- **Processing (Sharp)** — cutout → trim → **unified N×N square**, `contain` (never crops),
  transparent background, WebP/PNG, byte-capped.
- **AI enrichment** — **Claude Opus** (fallback GPT-4o) writes premium names + descriptions
  in AR/HE/EN and classifies each image (main/angle/detail/skip).
- **Save** — `kiss-play` adapter POSTs to the store's token-guarded import endpoint (store
  stores images in its own R2 + D1); or `json` adapter downloads a ZIP (images + manifest).

## Output contract (`Manifest`)

Store-agnostic JSON — see `core/types.ts`. Any project can consume it directly.

## Run locally

```bash
pnpm install          # approves sharp + onnxruntime-node native builds
pnpm dev              # http://localhost:3111
```

Paste a product URL, open **⚙️ الإعدادات**, add your keys (or set them via env), press
**معالجة**, review, then **حفظ للمتجر** / **تنزيل ZIP**.

## Deploy to Vercel

```bash
vercel            # first run links the project
vercel --prod     # production
```

Set the env vars from `.env.example` in **Vercel → Project → Settings → Environment
Variables** (Node runtime; `vercel.json` raises the function timeout to 60s).

## Add a new project (reuse)

1. Add an adapter in `adapters/yourstore.ts` that turns a `Manifest` into your store's API/DB.
2. Wire it in `app/api/save/route.ts` and the UI's adapter dropdown.
   The extraction + cutout + AI core stays untouched.

## Keys & cost (per product)

| Service | When | Cost |
|---|---|---|
| Local ISNet cutout | default | **free** |
| Replicate cutout | optional (higher quality) | ~$0.002–0.01 |
| Claude/OpenAI enrich | optional | ~$0.01–0.02 |
| Firecrawl | full galleries / hard sites | ~$19/mo plan |

Temu's main image is free from the URL — a minimal run costs **$0/product**.
