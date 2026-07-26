// ── GET /api/video-fetch?url=… — streaming video proxy for the ZIP download path ──
// The browser tries a direct fetch first (free bandwidth); most product CDNs block
// cross-origin reads, so this proxy is the fallback. Auth-gated (session cookie),
// SSRF-guarded, and hard-capped by a byte counter — bytes stream through, never buffered.

import { NextRequest } from 'next/server';
import { requireRole } from '@/core/auth';
import { assertPublicUrl } from '@/core/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export async function GET(req: NextRequest) {
  const g = requireRole(req); if ('error' in g) return g.error;
  const url = req.nextUrl.searchParams.get('url') || '';
  const maxMB = Math.min(300, Math.max(5, Number(req.nextUrl.searchParams.get('maxMB')) || 100));
  try { assertPublicUrl(url); } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message) }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const upstream = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'video/*,*/*' },
    signal: AbortSignal.timeout(280_000),
  }).catch(() => null);
  if (!upstream || !upstream.ok || !upstream.body) {
    return new Response(JSON.stringify({ error: 'source fetch failed' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
  const ct = (upstream.headers.get('content-type') || 'video/mp4').split(';')[0].trim();
  if (/text\/html/i.test(ct)) {
    return new Response(JSON.stringify({ error: 'not a video (login wall?)' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  const cap = maxMB * 1024 * 1024;
  let sent = 0;
  const counted = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sent += chunk.byteLength;
      if (sent > cap) { controller.error(new Error('size cap exceeded')); return; }
      controller.enqueue(chunk);
    },
  }));
  const len = upstream.headers.get('content-length');
  return new Response(counted, {
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'no-store',
      ...(len && Number(len) <= cap ? { 'Content-Length': len } : {}),
    },
  });
}
