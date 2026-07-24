// ── Best-image selection — download pool → measure resolution → dedupe → rank ──
// Cheap pre-filter that runs BEFORE the expensive background removal, so we only
// process the highest-resolution, non-duplicate candidates. AI vision (in analyze.ts)
// then makes the final quality/role judgment on this shortlist.

import sharp from 'sharp';
import { fetchImage } from './extract';
import type { Settings } from './settings';

export interface Candidate {
  sourceUrl: string;
  buf: Buffer;
  contentType: string;
  width: number;
  height: number;
  megapixels: number;
  bytes: number;
  aHash: bigint; // 64-bit perceptual hash for dedupe
}

const MIN_DIM = 300;          // drop thumbnails/icons smaller than this
const DOWNLOAD_BUDGET_MS = 16_000;

/** 8×8 average-hash (perceptual) — near-duplicate images share most bits. */
async function aHash(buf: Buffer): Promise<bigint> {
  const px = await sharp(buf).greyscale().resize(8, 8, { fit: 'fill' }).raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += px[i];
  const avg = sum / 64;
  let h = 0n;
  for (let i = 0; i < 64; i++) if (px[i] >= avg) h |= 1n << BigInt(i);
  return h;
}
function hamming(a: bigint, b: bigint): number {
  let x = a ^ b, c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

/**
 * Download the candidate pool, measure real dimensions, drop tiny + near-duplicate
 * images, and return them ranked by resolution (highest first).
 */
export async function selectPool(
  urls: string[],
  s: Settings,
  log: (m: string) => void,
): Promise<Candidate[]> {
  const started = Date.now();
  const all: Candidate[] = [];

  for (const url of urls) {
    if (Date.now() - started > DOWNLOAD_BUDGET_MS) { log(`download budget hit — measured ${all.length}/${urls.length}`); break; }
    const got = await fetchImage(url);
    if (!got) continue;
    try {
      const meta = await sharp(got.buf).metadata();
      const w = meta.width ?? 0, h = meta.height ?? 0;
      if (w < 80 || h < 80) continue;                                 // clearly an icon
      const ar = w / h;
      if (ar < 0.4 || ar > 2.5) continue;                             // banner/strip — not a product photo
      const hash = await aHash(got.buf);
      if (all.some((c) => hamming(c.aHash, hash) <= 6)) continue;     // near-duplicate of one already kept
      all.push({ sourceUrl: url, buf: got.buf, contentType: got.contentType, width: w, height: h, megapixels: (w * h) / 1e6, bytes: got.buf.byteLength, aHash: hash });
    } catch { /* undecodable — skip */ }
  }

  // Prefer images that clear the quality bar; if none do, fall back to the largest.
  const good = all.filter((c) => c.width >= MIN_DIM && c.height >= MIN_DIM);
  const ranked = (good.length ? good : all).sort((a, b) => b.megapixels - a.megapixels || b.bytes - a.bytes);
  if (!good.length && all.length) log(`no image ≥${MIN_DIM}px — using the largest ${Math.min(ranked.length, 3)} available`);
  const pool = ranked.slice(0, Math.min(10, Math.max(s.maxImages * 2, 6)));
  log(`measured ${all.length} valid, shortlisted ${pool.length} by resolution (top ${pool[0] ? pool[0].width + '×' + pool[0].height : '—'})`);
  return pool;
}

/** Small JPEG thumbnail of a raw source buffer — for cheap AI vision selection. */
export async function poolThumb(buf: Buffer, px = 200): Promise<string> {
  const t = await sharp(buf).flatten({ background: { r: 255, g: 255, b: 255 } }).resize(px, px, { fit: 'inside' }).jpeg({ quality: 65 }).toBuffer();
  return t.toString('base64');
}
