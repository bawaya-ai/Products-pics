// ── Watermark / logo removal ────────────────────────────────────────────────
// 1) Vision (Claude preferred, OpenAI fallback) locates an OVERLAID watermark/logo/text.
// 2) Inpaint that region: OpenAI image-edits (high quality) when a key is present, else a
//    fast FREE local blur-fill. Runs on the ORIGINAL image; the OpenAI path squares for the
//    API then crops the content back to the original aspect (no baked white letterbox).
// Opt-in. Best-effort: ANY failure returns null → the caller keeps the original image.

import sharp from 'sharp';
import type { Settings } from './settings';
import { capTimeout, remainingMs } from './budget';

interface Box { x: number; y: number; w: number; h: number } // percent 0-100
const S = 1024;

const PROMPT = 'Detect any WATERMARK, logo, store name, URL, or promotional text OVERLAID on top of this product photo (NOT the product\'s own printed text or packaging). Reply STRICT JSON: {"found":true,"x":<left%>,"y":<top%>,"w":<width%>,"h":<height%>} as a bounding box in PERCENT (0-100), padded a little; or {"found":false}. Only SMALL, clearly-overlaid marks — if it would cover most of the image, reply {"found":false}.';

function normBox(j: any): Box | null {
  if (!j || !j.found) return null;
  const c = (n: any) => Math.min(100, Math.max(0, Number(n) || 0));
  const box = { x: c(j.x), y: c(j.y), w: c(j.w), h: c(j.h) };
  if (box.w < 1.5 || box.h < 1.5) return null;               // degenerate
  if (box.w > 80 || box.h > 80 || box.w * box.h > 3500) return null; // >~35% area → mis-detect, don't nuke the product
  return box;
}

async function detectAnthropic(thumb: string, key: string, model: string, deadlineAt?: number): Promise<Box | null> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model || 'claude-opus-4-8', max_tokens: 200, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: thumb } }, { type: 'text', text: PROMPT },
    ] }] }),
    signal: AbortSignal.timeout(capTimeout(30000, deadlineAt)),
  });
  if (!r.ok) throw new Error(`detect anthropic ${r.status}`);
  const d = (await r.json()) as any;
  const txt: string = d.content?.find((b: any) => b.type === 'text')?.text || '';
  const m = txt.match(/\{[\s\S]*\}/);
  return normBox(m ? JSON.parse(m[0]) : null);
}

async function detectOpenAI(thumb: string, key: string, deadlineAt?: number): Promise<Box | null> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: 150, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${thumb}` } }] }] }),
    signal: AbortSignal.timeout(capTimeout(30000, deadlineAt)),
  });
  if (!r.ok) throw new Error(`detect openai ${r.status}`);
  const d = (await r.json()) as any;
  return normBox(JSON.parse(d.choices?.[0]?.message?.content || '{}'));
}

// High-quality: OpenAI image-edits. Squares for the API, then crops the content back to the
// original aspect so no white letterbox is baked in.
async function openaiInpaint(input: Buffer, box: Box, key: string, deadlineAt?: number): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const W = meta.width ?? S, H = meta.height ?? S;
  const scale = Math.min(S / W, S / H);
  const sw = Math.max(1, Math.round(W * scale)), sh = Math.max(1, Math.round(H * scale));
  const ox = Math.floor((S - sw) / 2), oy = Math.floor((S - sh) / 2);
  const square = await sharp(input).resize(sw, sh).extend({ top: oy, bottom: S - sh - oy, left: ox, right: S - sw - ox, background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer();
  // box (% of original) → px within the square's content area
  const mbx = Math.min(S - 8, ox + Math.round((box.x / 100) * sw));
  const mby = Math.min(S - 8, oy + Math.round((box.y / 100) * sh));
  const mbw = Math.max(8, Math.min(S - mbx, Math.round((box.w / 100) * sw)));
  const mbh = Math.max(8, Math.min(S - mby, Math.round((box.h / 100) * sh)));
  const hole = await sharp({ create: { width: mbw, height: mbh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const mask = await sharp({ create: { width: S, height: S, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: hole, left: mbx, top: mby, blend: 'dest-out' }]).png().toBuffer(); // transparent hole = regenerate

  const form = new FormData();
  form.append('model', 'dall-e-2');
  form.append('prompt', 'clean product photo, seamless matching background, no text, no watermark, no logo');
  form.append('size', '1024x1024');
  form.append('response_format', 'b64_json');
  form.append('n', '1');
  form.append('image', new Blob([new Uint8Array(square)], { type: 'image/png' }), 'image.png');
  form.append('mask', new Blob([new Uint8Array(mask)], { type: 'image/png' }), 'mask.png');
  const r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(capTimeout(55000, deadlineAt)) });
  if (!r.ok) throw new Error(`edit ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const d = (await r.json()) as any;
  const b64 = d.data?.[0]?.b64_json;
  if (!b64) throw new Error('no image returned');
  // crop the content area out of the edited square (drop the white bars) → back to original size
  return await sharp(Buffer.from(b64, 'base64')).extract({ left: ox, top: oy, width: sw, height: sh }).resize(W, H).png().toBuffer();
}

// FREE fallback: blur the watermark region out of the ORIGINAL image (no squaring/letterbox).
async function localFill(input: Buffer, box: Box): Promise<Buffer | null> {
  const meta = await sharp(input).metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  if (!W || !H) return null;
  const pad = Math.round(Math.min(W, H) * 0.012);
  const left = Math.max(0, Math.round((box.x / 100) * W) - pad);
  const top = Math.max(0, Math.round((box.y / 100) * H) - pad);
  const width = Math.min(W - left, Math.round((box.w / 100) * W) + pad * 2);
  const height = Math.min(H - top, Math.round((box.h / 100) * H) + pad * 2);
  if (width < 6 || height < 6) return null;
  const region = await sharp(input).extract({ left, top, width, height }).blur(Math.max(8, Math.min(width, height) / 3)).toBuffer();
  return await sharp(input).composite([{ input: region, left, top }]).png().toBuffer();
}

/** Cleaned buffer, or null (keep original) when disabled / no AI key / nothing found / any error. */
export async function removeWatermark(input: Buffer, s: Settings, log: (m: string) => void, deadlineAt?: number): Promise<Buffer | null> {
  if (!s.removeWatermark) return null;
  if (!s.anthropicKey && !s.openaiKey) { log('watermark: skipped (needs an Anthropic or OpenAI key)'); return null; }
  // optional + slow (detect 2-8s + inpaint 10-30s): never START it into a nearly-spent budget
  if (remainingMs(deadlineAt) < 25_000) { log('watermark: skipped — time budget too low'); return null; }
  try {
    const thumb = (await sharp(input).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer()).toString('base64');
    const box = s.anthropicKey ? await detectAnthropic(thumb, s.anthropicKey, s.anthropicModel || 'claude-opus-4-8', deadlineAt) : await detectOpenAI(thumb, s.openaiKey!, deadlineAt);
    if (!box) { log('watermark: none detected'); return null; }
    log(`watermark @ ${box.x}/${box.y} ${box.w}×${box.h}% — removing…`);
    if (s.openaiKey) {
      try { const c = await openaiInpaint(input, box, s.openaiKey, deadlineAt); log('watermark: inpainted (OpenAI) ✓'); return c; }
      catch (e: any) { log(`OpenAI inpaint failed (${String(e?.message).slice(0, 60)}) — local fill`); }
    }
    const c2 = await localFill(input, box);
    if (c2) { log('watermark: cleared (local) ✓'); return c2; }
    return null;
  } catch (e: any) {
    log(`watermark: failed (${String(e?.message).slice(0, 80)}) — keeping original`);
    return null;
  }
}
