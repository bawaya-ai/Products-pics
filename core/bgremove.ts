// ── Background removal — dedicated segmentation models, best-available chain ──
// This is a job for specialized cutout models, not general LLMs:
//   replicate  → BiRefNet/RMBG-class models (best quality, ~$0.002-0.01/img)
//   removebg   → remove.bg commercial API (excellent, pricier)
//   local      → U²-Net family ONNX via onnxruntime-node (FREE, no key)
//   openai     → gpt-image-1 edit (opt-in only: may refuse adult products)
// 'auto' picks the best provider that has a key, falling back to the free local model.

import sharp from 'sharp';
import type { Settings } from './settings';
import { localCutout } from './localbg';
import { capTimeout, remainingMs } from './budget';

export interface BgResult { buf: Buffer; provider: string }

/** Quality gate: a REAL cutout must decode AND contain genuinely transparent pixels.
 *  Without this, a misconfigured provider returning an opaque JPEG counts as "success"
 *  and ships a product image with the background still on it. */
async function hasRealCutout(buf: Buffer): Promise<boolean> {
  try {
    const meta = await sharp(buf).metadata();
    if (!meta.hasAlpha) return false;
    const stats = await sharp(buf).ensureAlpha().extractChannel(3).stats();
    return stats.channels[0].min < 128; // at least some clearly-transparent area exists
  } catch { return false; }
}

// per-successful-call cost of each PAID provider — emitted server-side at the moment the
// call actually happens (so billed-but-later-dropped images are still counted)
const PROVIDER_USD: Record<string, number> = { replicate: 0.006, removebg: 0.2, openai: 0.08 };

export async function removeBackground(
  input: Buffer,
  contentType: string,
  s: Settings,
  log: (m: string) => void,
  deadlineAt?: number,
  onCost?: (label: string, usd: number, detail?: string) => void,
): Promise<BgResult | null> {
  if (s.bgMode === 'off') return null;

  const order: string[] =
    s.bgMode === 'auto'
      ? [
          ...(s.replicateKey ? ['replicate'] : []),
          ...(s.removebgKey ? ['removebg'] : []),
          'local',
          ...(s.allowOpenAIImages && s.openaiKey ? ['openai'] : []),
        ]
      : [s.bgMode === 'imgly' ? 'local' : s.bgMode];

  for (const provider of order) {
    // budget check: a nearly-exhausted window goes straight to the free local model
    // (CPU, no network) instead of starting a paid call it can't finish
    if (provider !== 'local' && remainingMs(deadlineAt) < 8000) {
      log(`bg provider ${provider} skipped — time budget nearly exhausted`);
      continue;
    }
    try {
      const t0 = Date.now();
      const buf = await PROVIDERS[provider]?.(input, contentType, s, deadlineAt);
      if (buf && buf.byteLength > 1000) {
        // the provider DID run and bill by this point — count the spend even if rejected below
        if (onCost && PROVIDER_USD[provider]) onCost(`إزالة خلفية · ${provider}`, PROVIDER_USD[provider]);
        if (!(await hasRealCutout(buf))) {
          log(`bg provider ${provider} returned no real transparency — rejected, trying next`);
          continue;
        }
        log(`bg-removed via ${provider} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        return { buf, provider };
      }
    } catch (e: any) {
      log(`bg provider ${provider} failed: ${String(e?.message || e).slice(0, 140)}`);
    }
  }
  return null;
}

type Provider = (input: Buffer, contentType: string, s: Settings, deadlineAt?: number) => Promise<Buffer | null>;

const PROVIDERS: Record<string, Provider> = {
  // ── Replicate: official-model endpoint (no version hash) or owner/model:version ──
  async replicate(input, contentType, s, deadlineAt) {
    const key = s.replicateKey!;
    const model = s.replicateModel || 'bria/remove-background';
    const dataUrl = `data:${contentType};base64,${input.toString('base64')}`;
    const [path, version] = model.includes(':') ? model.split(':') : [model, null];
    const url = version
      ? 'https://api.replicate.com/v1/predictions'
      : `https://api.replicate.com/v1/models/${path}/predictions`;
    const body: any = version
      ? { version, input: { image: dataUrl } }
      : { input: { image: dataUrl } };
    // sync-wait + abort both derived from the remaining request budget
    const t = capTimeout(55000, deadlineAt);
    const wait = Math.min(45, Math.max(5, Math.floor(t / 1000) - 8));
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, Prefer: `wait=${wait}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(t),
    });
    if (!r.ok) throw new Error(`replicate ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const d = (await r.json()) as any;
    const out = typeof d.output === 'string' ? d.output : Array.isArray(d.output) ? d.output[0] : null;
    if (!out) throw new Error(`replicate status=${d.status}, no output`);
    const img = await fetch(out, { signal: AbortSignal.timeout(capTimeout(20000, deadlineAt)) });
    if (!img.ok) throw new Error(`replicate output fetch ${img.status}`);
    return Buffer.from(await img.arrayBuffer());
  },

  // ── remove.bg commercial API ──
  async removebg(input, _ct, s, deadlineAt) {
    const form = new FormData();
    form.append('image_file_b64', input.toString('base64'));
    form.append('size', 'auto');
    form.append('format', 'png');
    const r = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': s.removebgKey! },
      body: form,
      signal: AbortSignal.timeout(capTimeout(45000, deadlineAt)),
    });
    if (!r.ok) throw new Error(`removebg ${r.status}: ${(await r.text()).slice(0, 120)}`);
    return Buffer.from(await r.arrayBuffer());
  },

  // ── FREE local model: U²-Net family via onnxruntime-node ──
  async local(input) {
    return localCutout(input);
  },

  // ── OpenAI gpt-image-1 edit (opt-in; may refuse adult-product imagery) ──
  async openai(input, contentType, s, deadlineAt) {
    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('image', new Blob([new Uint8Array(input)], { type: contentType }), 'input.png');
    form.append('prompt', 'Remove the background completely. Keep the product exactly as-is, centered, on a fully transparent background.');
    form.append('background', 'transparent');
    form.append('size', '1024x1024');
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.openaiKey}` },
      body: form,
      signal: AbortSignal.timeout(capTimeout(55000, deadlineAt)),
    });
    if (!r.ok) throw new Error(`openai images ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const d = (await r.json()) as any;
    const b64 = d?.data?.[0]?.b64_json;
    return b64 ? Buffer.from(b64, 'base64') : null;
  },
};
