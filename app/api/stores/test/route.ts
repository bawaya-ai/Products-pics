// ── POST /api/stores/test — check a store is reachable + speaks the import protocol ──
// Body: { id } (test a saved store with its stored token) OR { base_url, token }.
// Pings {base}/api/scraper/import with empty images and interprets the response.

import { NextRequest, NextResponse } from 'next/server';
import { requireRoleFresh } from '@/core/auth';
import { getStoreResolved } from '@/core/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const g = await requireRoleFresh(req, 'admin'); if ('error' in g) return g.error;
  const body = await req.json().catch(() => null);

  let base = String(body?.base_url || '').trim().replace(/\/+$/, '');
  let token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (body?.id) {
    const st = await getStoreResolved(Number(body.id)).catch(() => null);
    if (!st) return NextResponse.json({ ok: false, detail: 'المتجر غير موجود' });
    base = st.base_url.replace(/\/+$/, '');
    if (!token) token = st.token;
  }
  if (!/^https?:\/\//i.test(base)) return NextResponse.json({ ok: false, detail: 'رابط غير صحيح — لازم يبدأ بـ https://' });
  if (!token) return NextResponse.json({ ok: false, detail: 'ما في توكن — اكتبه أو احفظ المتجر أول' });

  try {
    const r = await fetch(`${base}/api/scraper/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scraper-Token': token },
      body: JSON.stringify({ images: [], name_en: '' }),
      signal: AbortSignal.timeout(12000),
    });
    if (r.status === 401) return NextResponse.json({ ok: false, detail: 'التوكن غير صحيح (401)' });
    if (r.status === 503) return NextResponse.json({ ok: false, detail: 'الاستيراد مُطفأ بالمتجر (503) — فعّله بالمتجر' });
    if (r.status === 404) return NextResponse.json({ ok: false, detail: 'ما في نقطة /api/scraper/import — المتجر غير متوافق مع الأداة' });
    // A compatible store rejects empty images with a JSON body — that means it exists AND the token passed auth.
    const d = (await r.json().catch(() => null)) as any;
    if (d && typeof d === 'object') return NextResponse.json({ ok: true, detail: `متوافق ✓ — النقطة موجودة والتوكن مقبول (HTTP ${r.status})` });
    return NextResponse.json({ ok: false, detail: `رد غير متوقّع (HTTP ${r.status}) — يبدو المتجر غير متوافق` });
  } catch (e: any) {
    return NextResponse.json({ ok: false, detail: `تعذّر الوصول للمتجر: ${String(e?.message).slice(0, 90)}` });
  }
}
