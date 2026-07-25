// ── POST /api/auth/reset — consume a reset token → set a new password ──────
import { NextRequest, NextResponse } from 'next/server';
import { getUserByValidResetHash, setUserPassword, hashPassword } from '@/core/db';
import { hashResetToken } from '@/core/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const token = String(body?.token || '');
  const password = String(body?.password || '');
  if (!token || password.length < 8) return NextResponse.json({ error: 'التوكن وكلمة مرور (٨ أحرف+) مطلوبين' }, { status: 400 });

  const u = await getUserByValidResetHash(hashResetToken(token)).catch(() => null);
  if (!u) return NextResponse.json({ error: 'الرابط غير صالح أو منتهي الصلاحية' }, { status: 400 });
  await setUserPassword(u.id, hashPassword(password), false);
  return NextResponse.json({ ok: true });
}
