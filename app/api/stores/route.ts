// ── /api/stores — manage save destinations ─────────────────────────────────
// GET    → list stores (never returns tokens; only has_token boolean)
// POST   → create/update a store { id?, name, base_url, token?, category_default?, is_default? }
//          (token encrypted at rest; empty token on edit keeps the existing one)
// DELETE → remove a store (?id= or { id })
// Mutations are gated by the app password; listing is open (base URLs aren't secret).

import { NextRequest, NextResponse } from 'next/server';
import { requireRole, requireRoleFresh } from '@/core/auth';
import { dbConfigured, listStores, upsertStore, deleteStore } from '@/core/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = requireRole(req); if ('error' in g) return g.error;
  if (!dbConfigured()) return NextResponse.json({ stores: [], dbConfigured: false });
  try {
    return NextResponse.json({ stores: await listStores(), dbConfigured: true });
  } catch (e: any) {
    return NextResponse.json({ stores: [], dbConfigured: true, error: String(e?.message).slice(0, 160) });
  }
}

export async function POST(req: NextRequest) {
  const g = await requireRoleFresh(req, 'admin'); if ('error' in g) return g.error;
  if (!dbConfigured()) return NextResponse.json({ error: 'DATABASE_URL not set — server storage unavailable' }, { status: 503 });
  const body = await req.json().catch(() => null);
  const s = body?.store || body;
  if (!s?.name || !s?.base_url) return NextResponse.json({ error: 'name and base_url are required' }, { status: 400 });
  try {
    const id = await upsertStore({
      id: s.id ? Number(s.id) : undefined,
      name: String(s.name), base_url: String(s.base_url),
      token: typeof s.token === 'string' ? s.token : undefined,
      category_default: s.category_default ? String(s.category_default) : undefined,
      is_default: Boolean(s.is_default),
    });
    return NextResponse.json({ ok: true, id });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message).slice(0, 200) }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const g = await requireRoleFresh(req, 'admin'); if ('error' in g) return g.error;
  if (!dbConfigured()) return NextResponse.json({ error: 'DATABASE_URL not set' }, { status: 503 });
  const body = await req.json().catch(() => null);
  const id = Number(new URL(req.url).searchParams.get('id') || body?.id);
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  try {
    await deleteStore(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message).slice(0, 160) }, { status: 500 });
  }
}
