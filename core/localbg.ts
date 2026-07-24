// ── FREE local background removal — U²-Net-family ONNX via onnxruntime-node ──
// No API key, no external service. Model auto-downloads once to the OS temp dir.
//   BG_LOCAL_MODEL = silueta (43MB, default — good quality)
//                  | u2netp  (4.7MB — fastest, lighter edges)
//                  | u2net   (176MB — classic full model)
// onnxruntime-node is N-API based (ABI-stable across Node versions).

import { tmpdir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

interface ModelSpec { url: string; size: number; mean: number[]; std: number[]; divideByMax: boolean }
const MODELS: Record<string, ModelSpec> = {
  // ISNet (DIS) — best local quality; 1024 input, /255 with 0.5 mean
  'isnet-general-use': {
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
    size: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1], divideByMax: false,
  },
  // U²-Net family — smaller/faster, softer masks; 320 input, ImageNet stats
  silueta: {
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx',
    size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], divideByMax: true,
  },
  u2netp: {
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
    size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], divideByMax: true,
  },
  u2net: {
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx',
    size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], divideByMax: true,
  },
};
const DEFAULT_MODEL = 'isnet-general-use';

let sessionPromise: Promise<{ session: any; spec: ModelSpec }> | null = null;

async function getSession(): Promise<{ session: any; spec: ModelSpec }> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort: any = await import('onnxruntime-node');
      const name = (process.env.BG_LOCAL_MODEL || DEFAULT_MODEL).toLowerCase();
      const spec = MODELS[name] || MODELS[DEFAULT_MODEL];
      const dir = path.join(tmpdir(), 'scraper-pro-models');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${name}.onnx`);
      if (!existsSync(file)) {
        const r = await fetch(spec.url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
        if (!r.ok) throw new Error(`model download failed: HTTP ${r.status}`);
        const tmp = `${file}.part`;
        await writeFile(tmp, Buffer.from(await r.arrayBuffer()));
        await rename(tmp, file);
      }
      const session = await ort.InferenceSession.create(file);
      return { session, spec };
    })().catch((e) => { sessionPromise = null; throw e; });
  }
  return sessionPromise;
}

/** Smoothstep contrast curve: crush haze to 0, solidify the subject to 255. */
function curve(v: number): number {
  const lo = 0.15, hi = 0.85;
  if (v <= lo) return 0;
  if (v >= hi) return 255;
  const t = (v - lo) / (hi - lo);
  return Math.round(t * t * (3 - 2 * t) * 255);
}

/** Cut the subject out of an image → PNG with alpha (transparent background). */
export async function localCutout(input: Buffer): Promise<Buffer> {
  const ort: any = await import('onnxruntime-node');
  const { session, spec } = await getSession();

  // Bake EXIF rotation first so metadata dims match pixel data.
  const upright = await sharp(input, { limitInputPixels: 80e6 }).rotate().removeAlpha().toBuffer();
  const meta = await sharp(upright).metadata();
  const W = meta.width!, H = meta.height!;

  // Preprocess: stretch to model input, normalize per model spec, NCHW float32.
  const S = spec.size;
  const rgb = await sharp(upright).resize(S, S, { fit: 'fill' }).raw().toBuffer();
  let denom = 255;
  if (spec.divideByMax) {
    let mx = 0; for (let i = 0; i < rgb.length; i++) if (rgb[i] > mx) mx = rgb[i];
    denom = mx || 255;
  }
  const data = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++)
    for (let c = 0; c < 3; c++) data[c * S * S + i] = (rgb[i * 3 + c] / denom - spec.mean[c]) / spec.std[c];

  const feeds: Record<string, any> = {};
  feeds[session.inputNames[0]] = new ort.Tensor('float32', data, [1, 3, S, S]);
  const outputs = await session.run(feeds);
  const pred = outputs[session.outputNames[0]].data as Float32Array;

  // Min-max normalize the saliency map, then apply the contrast curve.
  let mi = Infinity, ma = -Infinity;
  for (let i = 0; i < S * S; i++) { const v = pred[i]; if (v < mi) mi = v; if (v > ma) ma = v; }
  const range = ma - mi || 1;
  const mask = Buffer.alloc(S * S);
  for (let i = 0; i < S * S; i++) mask[i] = curve((pred[i] - mi) / range);

  // Upscale mask to source size and attach as alpha channel.
  // toColourspace('b-w') forces a SINGLE channel — otherwise Sharp promotes the
  // grayscale to 3-channel sRGB and joinChannel misaligns rows (scanline artifact).
  const maskFull = await sharp(mask, { raw: { width: S, height: S, channels: 1 } })
    .resize(W, H, { fit: 'fill' })
    .blur(0.4)
    .toColourspace('b-w')
    .raw()
    .toBuffer();

  return sharp(upright)
    .ensureAlpha()
    .joinChannel(maskFull, { raw: { width: W, height: H, channels: 1 } })
    .png()
    .toBuffer();
}
