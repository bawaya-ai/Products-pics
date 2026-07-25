// ── /api/users — admin-only user & role management ─────────────────────────
// GET list · POST create {email,password,role} · PATCH {id,role?,password?} · DELETE ?id=
// Guards: can't delete yourself; can't remove/demote the last admin (enforced atomically).

import { NextRequest, NextResponse } from 'next/server';
import { requireRoleFresh } from '@/core/auth';
import { dbConfigured, listUsers, createUser, setUserRoleGuarded, setUserPassword, deleteUserGuarded, getUserById, getUserByEmail, hashPassword } from '@/core/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await requireRoleFresh(req, 'admin'); if ('error' in g) return g.error;
  if (!dbConfigured()) return NextResponse.json({ users: [] });
  return NextResponse.json({ users: await listUsers() });
}

export async function POST(req: NextRequest) {
  const g = await requireRoleFresh(req, 'admin'); if ('error' in g) return g.error;
  if (!dbConfigured()) return NextResponse.json({ error: 'DATABASE_URL not set' }, { status: 503 });
  const body = await req.json().catch(() => null);
  const email = String(body?.email || '').trim();
  const password = String(body?.password || '');
  const role = body?.role === 'admin' ? 'admin' : 'operator';
  if (!email || !/.+@.+\..+/.test(email)) return NextResponse.json({ error: 'إيميل غير صحيح' }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: 'كلمة مرور مبدئية (٨ أحرف+) مطلوبة' }, { status: 400 });
  if (await getUserByEmail(email).catch(() => null)) return NextResponse.json({ error: 'الإيميل مستخدم مسبقاً' }, { status: 409 });
  const id = await createUser(email, hashPassword(password), role, true);
  return NextResponse.json({ ok: true, id });
}

export async function PATCH(req: NextRequest) {
  const g = await requireRoleFresh(req, 'admin'); if ('error' in g) return g.error;
  const body = await req.json().catch(() => null);
  const id = Number(body?.id);
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const target = await getUserById(id).catch(() => null);
  if (!target) return NextResponse.json({ error: 'المستخدم غير موجود' }, { status: 404 });

  if (typeof body?.role === 'string') {
    const role = body.role === 'admin' ? 'admin' : 'operator';
    const ok = await setUserRoleGuarded(id, role); // atomically refuses to demote the last admin
    if (!ok) return NextResponse.json({ error: 'ما بتقدر تنزّل رتبة آخر أدمن' }, { status: 400 });
  }
  if (typeof body?.password === 'string' && body.password.length >= 8) {
    await setUserPassword(id, hashPassword(body.password), true);
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const g = await requireRoleFresh(req, 'admin'); if ('error' in g) return g.error;
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  if (id === g.session.uid) return NextResponse.json({ error: 'ما بتقدر تحذف حسابك' }, { status: 400 });
  const ok = await deleteUserGuarded(id); // atomically refuses to delete the last admin
  if (!ok) return NextResponse.json({ error: 'ما بتقدر تحذف آخر أدمن' }, { status: 400 });
  return NextResponse.json({ ok: true });
}
