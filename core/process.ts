// ── Image processing (Sharp): cutout → trim → unified square → webp/png ────
// Output contract: transparent background (when cutout succeeded), unified
// SIZE×SIZE canvas, contain-fit (never crops), consistent quality, capped bytes.

import sharp from 'sharp';
import type { Settings } from './settings';
import { removeBackground } from './bgremove';

export interface ProcessOutput {
  buf: Buffer;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
  hasAlpha: boolean;
  bgProvider: string;
  warnings: string[];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
function hexRgb(hex: string): { r: number; g: number; b: number; alpha: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return { r: 255, g: 255, b: 255, alpha: 1 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: 1 };
}

export async function processImage(
  input: Buffer,
  contentType: string,
  s: Settings,
  log: (m: string) => void,
): Promise<ProcessOutput> {
  const warnings: string[] = [];

  // 1) background removal via the provider chain
  const cut = await removeBackground(input, contentType, s, log);
  const bgProvider = cut?.provider ?? 'none';
  if (!cut && s.bgMode !== 'off') warnings.push('background_not_removed');

  let img = sharp(cut?.buf ?? input, { limitInputPixels: 80e6 }).rotate();

  // 2) trim: with a cutout, trim transparent borders so the product fills the frame
  if (cut) {
    try { img = sharp(await img.trim({ threshold: 12 }).toBuffer()); }
    catch { /* fully-transparent or tiny images can fail trim — keep untrimmed */ }
  }

  // Background: transparent only when we have a cutout AND the user kept 'transparent'.
  const wantTransparent = Boolean(cut) && (!s.bgColor || s.bgColor === 'transparent');
  const solidBg = hexRgb(s.bgColor && s.bgColor !== 'transparent' ? s.bgColor : '#ffffff');
  const clearBg = { r: 0, g: 0, b: 0, alpha: 0 };

  // 3) padding: letterbox/extend with a TRANSPARENT field, so the tone step below can't
  //    tint the padding — the chosen solid color is applied last, pristine.
  const pad = clamp(s.padding ?? 0, 0, 40);
  const inner = Math.max(16, Math.round(s.size * (1 - pad / 100)));
  let geo = await img.resize(inner, inner, { fit: 'contain', background: clearBg, withoutEnlargement: false }).toBuffer();
  if (inner < s.size) {
    const total = s.size - inner, t = Math.floor(total / 2), l = Math.floor(total / 2);
    geo = await sharp(geo).extend({ top: t, bottom: total - t, left: l, right: total - l, background: clearBg }).toBuffer();
  }

  // 4) tone on the transparent-padded image (adjusts the subject only; padding stays clear)
  let tone = sharp(geo);
  const bright = clamp(s.brightness ?? 100, 50, 150) / 100;
  const contr = clamp(s.contrast ?? 100, 50, 150) / 100;
  if (bright !== 1) tone = tone.modulate({ brightness: bright });
  if (contr !== 1) tone = tone.linear(contr, Math.round(128 * (1 - contr)));
  const sh = clamp(s.sharpen ?? 0, 0, 100);
  if (sh > 0) tone = tone.sharpen({ sigma: 0.5 + (sh / 100) * 2.5 });
  let tonedBuf = await tone.png().toBuffer();
  // Solid bg chosen → flatten onto the exact color in a SEPARATE pass (sharp reorders an
  // in-pipeline flatten ahead of tone, which is what tinted the color before).
  if (!wantTransparent) tonedBuf = await sharp(tonedBuf).flatten({ background: solidBg }).toBuffer();

  // 5) encode with byte cap (webp keeps alpha; png for max-compat transparency)
  const cap = clamp(s.maxKB ?? 400, 50, 3000) * 1024;
  let quality = s.quality;
  let out: Buffer;
  for (;;) {
    const enc = sharp(tonedBuf);
    out =
      s.format === 'png'
        ? await enc.png({ compressionLevel: 9, palette: quality < 80 }).toBuffer()
        : await enc.webp({ quality, alphaQuality: 90, effort: 4 }).toBuffer();
    if (out.byteLength <= cap || quality <= 45) break;
    quality -= 12;
  }
  if (out.byteLength > cap) warnings.push(`large_file_${Math.round(out.byteLength / 1024)}KB`);

  const meta = await sharp(out).metadata();
  return {
    buf: out,
    contentType: s.format === 'png' ? 'image/png' : 'image/webp',
    width: meta.width ?? s.size,
    height: meta.height ?? s.size,
    bytes: out.byteLength,
    hasAlpha: Boolean(meta.hasAlpha) && wantTransparent,
    bgProvider,
    warnings,
  };
}

/** Small JPEG thumbnail (for cheap AI vision classification). */
export async function thumbnailJpeg(buf: Buffer, px = 256): Promise<Buffer> {
  return sharp(buf)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(px, px, { fit: 'inside' })
    .jpeg({ quality: 70 })
    .toBuffer();
}
