// ── POST /api/save — push a reviewed manifest through an adapter ───────────

import { NextRequest, NextResponse } from 'next/server';
import { resolveSettings, checkAppAuth } from '@/core/settings';
import { dbConfigured, getStoreResolved, getDefaultStoreResolved } from '@/core/db';
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
  const storeId = body?.storeId; // number → a DB store; 'env'/undefined → legacy settings/env store
  if (!manifest?.images?.length) return NextResponse.json({ error: 'manifest with images required' }, { status: 400 });

  const s = await resolveSettings(body?.settings);

  if (adapter === 'kiss-play') {
    // Resolve the destination: an explicit DB store, else the default DB store, else the legacy settings/env store.
    if (dbConfigured() && storeId !== 'env') {
      if (storeId != null) {
        // explicit choice → it must exist and carry a token
        const st = await getStoreResolved(Number(storeId));
        if (!st) return NextResponse.json({ ok: false, error: 'الوجهة (المتجر) غير موجودة' }, { status: 400 });
        if (!st.token) return NextResponse.json({ ok: false, error: `المتجر "${st.name}" ما إله توكن — عدّله بالإعدادات` }, { status: 400 });
        s.storeBase = st.base_url; s.storeToken = st.token;
      } else {
        // implicit default → use it only if usable; otherwise fall through to the legacy env/settings store
        const def = await getDefaultStoreResolved();
        if (def && def.token) { s.storeBase = def.base_url; s.storeToken = def.token; }
      }
    }
    const r = await saveToKissPlay(manifest, s);
    return NextResponse.json(r, { status: r.ok ? 200 : 502 });
  }
  // 'json' adapter is handled fully client-side (download); nothing to do server-side.
  return NextResponse.json({ error: `unknown adapter: ${adapter}` }, { status: 400 });
}
