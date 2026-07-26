// ── Video probe & rank — validate/measure candidates WITHOUT downloading them ──
// One Range GET of the first 256KB per candidate: enough for status + content-type +
// total size (Content-Range) + mp4 dimensions/duration (ftyp/moov/mvhd/tkhd) or the
// webm EBML magic. Non-fast-start mp4s get one tail fetch to find the moov box.
// Quality-first rule: an inconclusive probe NEVER drops a real video — it's kept as
// probe:'partial'; only definitive non-videos (HTML login walls) are rejected.
// Video BYTES never transit this server at scrape time — the store downloads them
// server-side at save, and the ZIP downloads them in the browser.

import type { Settings } from './settings';
import type { ManifestVideo } from './types';
import { assertPublicUrl } from './extract';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEAD_BYTES = 262_144;

export interface VideoCandidate { url: string; poster?: string; source: ManifestVideo['source'] }

interface Probe {
  ok: boolean;                 // false = definitively NOT a video
  contentType?: string;
  bytes?: number;
  width?: number; height?: number; durationS?: number;
  partial: boolean;            // true = kept but not fully measured
}

/** Probe all candidates in parallel under a hard deadline; rank; cap at 3. */
export async function probeVideos(
  cands: VideoCandidate[],
  s: Settings,
  deadlineMs: number,
  log: (m: string) => void,
): Promise<ManifestVideo[]> {
  if (!cands.length) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((res) => { timer = setTimeout(() => res(null), deadlineMs); });
  const probed = await Promise.all(cands.slice(0, 6).map(async (c, i) => ({
    c, i,
    p: await Promise.race([probeVideo(c.url).catch(() => null), deadline]),
  })));
  if (timer) clearTimeout(timer);

  const maxBytes = (s.maxVideoMB || 100) * 1024 * 1024;
  const vids: ManifestVideo[] = [];
  for (const { c, i, p } of probed) {
    if (p && !p.ok) continue;                          // HTML/login wall — not a video
    if (p?.bytes && p.bytes > maxBytes) { log(`video ${i} skipped — ${(p.bytes / 1048576).toFixed(0)}MB فوق السقف`); continue; }
    vids.push({
      id: `vid_${i}_${Math.random().toString(36).slice(2, 7)}`,
      url: c.url, poster: c.poster, source: c.source,
      width: p?.width, height: p?.height, durationS: p?.durationS, bytes: p?.bytes,
      contentType: p?.contentType,
      probe: p ? (p.partial ? 'partial' : 'ok') : 'failed',
      keep: true,
    });
  }
  const ranked = rankVideos(vids).slice(0, 3);
  if (ranked.length) log(`videos: ${ranked.length} kept (${ranked.map((v) => v.width ? `${v.width}×${v.height}` : v.probe).join(', ')})`);
  return ranked;
}

/** Dedupe signed variants of the same file; best (height → bytes → URL hints) first. */
export function rankVideos(vids: ManifestVideo[]): ManifestVideo[] {
  const seen = new Set<string>();
  const out: ManifestVideo[] = [];
  for (const v of vids) {
    const key = v.url.split('?')[0].replace(/_(?:\d{3,4}[wp])\./, '.');
    if (seen.has(key)) continue;
    seen.add(key); out.push(v);
  }
  const hint = (u: string) => (/1080|\bhd\b|high/i.test(u) ? 2 : /720/.test(u) ? 1 : 0);
  return out.sort((a, b) =>
    ((b.height || 0) * (b.width || 0)) - ((a.height || 0) * (a.width || 0)) ||
    (b.bytes || 0) - (a.bytes || 0) ||
    hint(b.url) - hint(a.url));
}

async function probeVideo(url: string): Promise<Probe> {
  assertPublicUrl(url);
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Range: `bytes=0-${HEAD_BYTES - 1}`, Accept: 'video/*,*/*' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok && r.status !== 206) return { ok: false, partial: false };
  const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());
  const cr = r.headers.get('content-range');                       // "bytes 0-262143/12345678"
  const totalRaw = cr ? parseInt(cr.split('/')[1] || '', 10) : (r.status === 200 ? buf.byteLength : NaN);
  const total = Number.isFinite(totalRaw) ? totalRaw : undefined;

  const isMp4 = buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp';
  const isWebm = buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  if (!isMp4 && !isWebm) {
    if (/text\/html/.test(ct) || /^\s*</.test(buf.toString('latin1', 0, 64))) return { ok: false, partial: false };
    if (ct.startsWith('video/')) return { ok: true, contentType: ct, bytes: total, partial: true };
    return { ok: true, contentType: ct || undefined, bytes: total, partial: true }; // inconclusive → keep
  }

  const contentType = isMp4 ? 'video/mp4' : 'video/webm';
  let dims = isMp4 ? parseMp4(buf) : null;
  // non-fast-start mp4: the moov box lives at the END of the file — one tail fetch
  if (isMp4 && !dims?.width && total && total > HEAD_BYTES) {
    try {
      const tail = await fetch(url, {
        headers: { 'User-Agent': UA, Range: `bytes=-${HEAD_BYTES}` },
        signal: AbortSignal.timeout(15000),
      });
      if (tail.status === 206) {
        const tbuf = Buffer.from(await tail.arrayBuffer());
        const idx = tbuf.indexOf('moov', 0, 'latin1');
        if (idx >= 4) dims = parseMp4(tbuf.subarray(idx - 4));
      }
    } catch { /* keep as partial */ }
  }
  return { ok: true, contentType, bytes: total, ...(dims || {}), partial: !dims?.width };
}

/** Minimal MP4 box walker: moov → mvhd (duration) + trak → tkhd (width/height, 16.16 fixed). */
function parseMp4(buf: Buffer): { width?: number; height?: number; durationS?: number } | null {
  try {
    const out: { width?: number; height?: number; durationS?: number } = {};
    const walk = (start: number, end: number, depth: number) => {
      if (depth > 4) return;
      let off = start;
      while (off + 8 <= end) {
        let size = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        let head = 8;
        if (size === 1) { if (off + 16 > end) return; size = Number(buf.readBigUInt64BE(off + 8)); head = 16; }
        else if (size === 0) size = end - off;
        if (size < 8 || !Number.isFinite(size)) return;
        const boxEnd = Math.min(off + size, end);
        if (type === 'moov' || type === 'trak') walk(off + head, boxEnd, depth + 1);
        else if (type === 'mvhd' && boxEnd - (off + head) >= 20) {
          const ver = buf[off + head];
          if (ver === 1 && boxEnd - (off + head) >= 32) {
            const ts = buf.readUInt32BE(off + head + 20);
            const dur = Number(buf.readBigUInt64BE(off + head + 24));
            if (ts) out.durationS = Math.round(dur / ts);
          } else if (ver === 0) {
            const ts = buf.readUInt32BE(off + head + 12);
            const dur = buf.readUInt32BE(off + head + 16);
            if (ts && dur !== 0xffffffff) out.durationS = Math.round(dur / ts);
          }
        } else if (type === 'tkhd' && off + size <= end && size >= 84) {
          const w = buf.readUInt32BE(boxEnd - 8) >>> 16;   // 16.16 fixed → integer part
          const h = buf.readUInt32BE(boxEnd - 4) >>> 16;
          if (w && h && w < 10000 && h < 10000 && w * h > (out.width || 0) * (out.height || 0)) { out.width = w; out.height = h; }
        }
        if (off + size > end) break;                        // truncated box (rest of moov beyond our window)
        off += size;
      }
    };
    walk(0, buf.length, 0);
    return out.width || out.durationS ? out : null;
  } catch { return null; }
}
