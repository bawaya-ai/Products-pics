// ── AI enrichment — each model does what it's best at ──────────────────────
//   Claude (Opus/Sonnet): product copywriting (AR/HE/EN) + vision classification
//   OpenAI GPT-4o:        automatic fallback when no Anthropic key is set
// One combined call: page context + image thumbnails → JSON (copy + image roles).

import type { Settings } from './settings';
import type { LocalizedText, MediaRole } from './types';

export interface Enrichment {
  name: LocalizedText;
  description: LocalizedText;
  tags: string[];
  price: { amount: number | null; currency: string | null }; // as shown on the page
  imageRoles: { index: number; role: MediaRole }[];
  provider: string;
}

const EMPTY: Enrichment = {
  name: { en: '', ar: '', he: '' },
  description: { en: '', ar: '', he: '' },
  tags: [], price: { amount: null, currency: null }, imageRoles: [], provider: 'none',
};

const SYS = `You are a senior e-commerce product specialist + photo editor for an adult (18+) intimate-products store in the Middle East.
You receive a product page's title/text and a SHORTLIST of candidate image thumbnails (already pre-sorted by resolution, highest first). Curate the best set and write the copy. Return STRICT JSON only (no markdown):
{
 "name":       {"en":"…","ar":"…","he":"…"},          // short, premium product names
 "description":{"en":"…","ar":"…","he":"…"},          // 2-3 tasteful marketing sentences each; Arabic in warm Palestinian-friendly tone; never explicit
 "tags":       ["…"],                                  // 3-6 lowercase tags
 "price":      {"amount":number|null,"currency":"USD|EUR|GBP|ILS|SAR|AED|…"|null},  // the price AS SHOWN with its currency — else null; NEVER guess
 "images":     [{"index":0,"role":"main|angle|detail|skip"}]  // judge EVERY thumbnail by index
}
Image curation rules — KEEP a rich set (aim for AT LEAST 3 good images when the page has them):
- "main" = exactly ONE: the clearest full-product hero. PREFER a clean product-ONLY photo on a plain/white/neutral background (no hands/model). If none exists, use the best available.
- "angle"/"detail" = KEEP every other distinct usable view of the SAME product — other angles, close-ups, packaging, AND in-context/lifestyle shots. Do NOT drop a usable image just because it's lifestyle/in-hand; keep it as angle/detail. Keep up to 6.
- "skip" = ONLY true junk: blurry, watermarked, a collage/multi-product grid, a clearly DIFFERENT product, a size chart / pure text / logo / banner, or a near-duplicate of one you already kept.
- If thumbnails show DIFFERENT products (e.g. a search page), keep only the ONE product matching the page title (its main + its own extra views); skip the others.
For price: use PRICE CANDIDATES / any visible price in the text — return the amount AND its currency exactly as shown (e.g. $19.99 → {"amount":19.99,"currency":"USD"}). If no currency symbol/code is visible, set currency to null. Never invent a price that isn't shown.
Professional, tasteful language only. If the page text is unrelated, derive the name from the kept images.`;

export async function enrich(
  pageTitle: string,
  pageText: string,
  thumbsJpegB64: string[],
  s: Settings,
  log: (m: string) => void,
): Promise<Enrichment> {
  if (!s.aiEnabled) return EMPTY;
  const userText = `PAGE TITLE: ${pageTitle || '(none)'}\n\nPAGE TEXT (truncated):\n${pageText || '(none)'}\n\nThere are ${thumbsJpegB64.length} thumbnails (index 0..${thumbsJpegB64.length - 1}). Return the JSON.`;

  try {
    if (s.anthropicKey) {
      const out = await callAnthropic(s.anthropicKey, s.anthropicModel || 'claude-opus-4-8', userText, thumbsJpegB64);
      if (out) { log(`AI enrich via ${s.anthropicModel || 'claude-opus-4-8'}`); return { ...parse(out), provider: 'anthropic' }; }
    }
    if (s.openaiKey) {
      const out = await callOpenAI(s.openaiKey, userText, thumbsJpegB64);
      if (out) { log('AI enrich via gpt-4o'); return { ...parse(out), provider: 'openai' }; }
    }
    log('AI enrich skipped (no API key)');
  } catch (e: any) {
    log(`AI enrich failed: ${String(e?.message || e).slice(0, 140)}`);
  }
  return EMPTY;
}

async function callAnthropic(key: string, model: string, text: string, thumbs: string[]): Promise<string | null> {
  const content: any[] = [
    ...thumbs.map((b64) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })),
    { type: 'text', text },
  ];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1600, system: SYS, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(55000),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 140)}`);
  const d = (await r.json()) as any;
  return d.content?.find((b: any) => b.type === 'text')?.text ?? null;
}

async function callOpenAI(key: string, text: string, thumbs: string[]): Promise<string | null> {
  const content: any[] = [
    { type: 'text', text },
    ...thumbs.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } })),
  ];
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o', max_tokens: 1600, temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYS }, { role: 'user', content }],
    }),
    signal: AbortSignal.timeout(55000),
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 140)}`);
  const d = (await r.json()) as any;
  return d.choices?.[0]?.message?.content ?? null;
}

function parse(raw: string): Omit<Enrichment, 'provider'> {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : raw);
    const loc = (o: any): LocalizedText => ({ en: str(o?.en), ar: str(o?.ar), he: str(o?.he) });
    const roles = Array.isArray(j.images)
      ? j.images
          .filter((x: any) => Number.isInteger(x?.index))
          .map((x: any) => ({ index: x.index, role: (['main', 'angle', 'detail', 'skip'].includes(x.role) ? x.role : 'angle') as MediaRole }))
      : [];
    const amt = typeof j.price?.amount === 'number' ? j.price.amount
      : typeof j.price_ils === 'number' ? j.price_ils : null; // tolerate the old shape
    const cur = typeof j.price?.currency === 'string' ? j.price.currency.trim().slice(0, 8) : null;
    return {
      name: loc(j.name), description: loc(j.description),
      tags: Array.isArray(j.tags) ? j.tags.slice(0, 6).map(str) : [],
      price: { amount: amt != null && amt > 0 && amt < 1e7 ? amt : null, currency: cur || null },
      imageRoles: roles,
    };
  } catch { return { ...EMPTY }; }
}
const str = (v: any) => (typeof v === 'string' ? v.trim().slice(0, 1200) : '');
