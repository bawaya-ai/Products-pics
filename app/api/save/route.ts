// ── POST /api/save — push a reviewed manifest through an adapter ───────────

import { NextRequest, NextResponse } from 'next/server';
import { resolveSettings, checkAppAuth } from '@/core/settings';
import { saveToKissPlay } from '@/adapters/kissplay';
import type { Manifest } from '@/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!(await checkAppAuth(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const manifest: Manifest | undefined = body?.manifest;
  const adapter: string = body?.adapter || 'kiss-play';
  if (!manifest?.images?.length) return NextResponse.json({ error: 'manifest with images required' }, { status: 400 });

  const s = await resolveSettings(body?.settings);

  if (adapter === 'kiss-play') {
    const r = await saveToKissPlay(manifest, s);
    return NextResponse.json(r, { status: r.ok ? 200 : 502 });
  }
  // 'json' adapter is handled fully client-side (download); nothing to do server-side.
  return NextResponse.json({ error: `unknown adapter: ${adapter}` }, { status: 400 });
}
