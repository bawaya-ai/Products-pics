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

const BYTE_CAP = 400 * 1024; // keep files lean; retry at lower quality if above

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

  // 3) unified square canvas, contain (never crop), transparent or white padding
  const transparentOut = Boolean(cut);
  img = img.resize(s.size, s.size, {
    fit: 'contain',
    background: transparentOut ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 255, g: 255, b: 255, alpha: 1 },
    withoutEnlargement: false,
  });

  // 4) encode with byte cap (webp keeps alpha; png for max-compat transparency)
  let quality = s.quality;
  let out: Buffer;
  for (;;) {
    out =
      s.format === 'png'
        ? await img.png({ compressionLevel: 9, palette: quality < 80 }).toBuffer()
        : await img.webp({ quality, alphaQuality: 90, effort: 4 }).toBuffer();
    if (out.byteLength <= BYTE_CAP || quality <= 55) break;
    quality -= 12;
  }
  if (out.byteLength > BYTE_CAP) warnings.push(`large_file_${Math.round(out.byteLength / 1024)}KB`);

  const meta = await sharp(out).metadata();
  return {
    buf: out,
    contentType: s.format === 'png' ? 'image/png' : 'image/webp',
    width: meta.width ?? s.size,
    height: meta.height ?? s.size,
    bytes: out.byteLength,
    hasAlpha: Boolean(meta.hasAlpha),
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
