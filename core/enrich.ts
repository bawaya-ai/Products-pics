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
  price_ils: number | null;
  imageRoles: { index: number; role: MediaRole }[];
  provider: string;
}

const EMPTY: Enrichment = {
  name: { en: '', ar: '', he: '' },
  description: { en: '', ar: '', he: '' },
  tags: [], price_ils: null, imageRoles: [], provider: 'none',
};

const SYS = `You are a senior e-commerce product specialist for an adult (18+) intimate-products store in the Middle East.
Given a product page's title/text and product image thumbnails, return STRICT JSON only (no markdown) with:
{
 "name":       {"en":"…","ar":"…","he":"…"},          // short, premium product names
 "description":{"en":"…","ar":"…","he":"…"},          // 2-3 tasteful marketing sentences each; Arabic in warm Palestinian-friendly tone; never explicit
 "tags":       ["…"],                                  // 3-6 lowercase tags
 "price_ils":  number|null,                            // price in Israeli Shekels if clearly present in the text, else null — NEVER guess
 "images":     [{"index":0,"role":"main|angle|detail|skip"}]  // classify EVERY thumbnail by index; exactly one "main" (the clearest full product shot); "skip" = irrelevant/junk
}
Professional, tasteful language only. If the page text is garbage/unrelated, derive the name from what the images show.`;

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
    return {
      name: loc(j.name), description: loc(j.description),
      tags: Array.isArray(j.tags) ? j.tags.slice(0, 6).map(str) : [],
      price_ils: typeof j.price_ils === 'number' && j.price_ils > 0 && j.price_ils < 100000 ? j.price_ils : null,
      imageRoles: roles,
    };
  } catch { return { ...EMPTY }; }
}
const str = (v: any) => (typeof v === 'string' ? v.trim().slice(0, 1200) : '');
