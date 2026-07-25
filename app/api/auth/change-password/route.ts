// ── POST /api/auth/change-password — logged-in user sets a new password ────
import { NextRequest, NextResponse } from 'next/server';
import { sessionFromReq } from '@/core/auth';
import { getUserById, verifyPassword, setUserPassword, hashPassword } from '@/core/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = sessionFromReq(req);
  if (!s) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  const current = String(body?.current || '');
  const next = String(body?.next || '');
  if (next.length < 8) return NextResponse.json({ error: 'كلمة المرور الجديدة قصيرة (٨ أحرف+)' }, { status: 400 });

  const u = await getUserById(s.uid).catch(() => null);
  if (!u || !verifyPassword(current, u.password_hash)) return NextResponse.json({ error: 'كلمة السر الحالية غلط' }, { status: 401 });
  await setUserPassword(u.id, hashPassword(next), false);
  return NextResponse.json({ ok: true });
}
