// ── POST /api/auth/login — email + password → signed session cookie ────────
import { NextRequest, NextResponse } from 'next/server';
import { getUserByEmail, verifyPassword } from '@/core/db';
import { signSession, sessionCookie, Role } from '@/core/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A valid-format scrypt hash of a random value — verified against when the email doesn't
// exist so scrypt always runs once, hiding account existence behind constant response time.
const DUMMY_HASH = 'scrypt.vlUIq9CNecme2w6ff8x/WQ==.1JJZN6IGWJrnloyP5eaf2pNYsv7gP5dKjIcm9nZwKCQ=';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = String(body?.email || '').trim();
  const password = String(body?.password || '');
  if (!email || !password) return NextResponse.json({ error: 'الإيميل وكلمة السر مطلوبين' }, { status: 400 });

  const u = await getUserByEmail(email).catch(() => null);
  const passOk = verifyPassword(password, u?.password_hash || DUMMY_HASH); // always runs scrypt
  if (!u || !passOk) {
    return NextResponse.json({ error: 'الإيميل أو كلمة السر غلط' }, { status: 401 });
  }
  const role: Role = u.role === 'admin' ? 'admin' : 'operator';
  const token = signSession({ uid: u.id, email: u.email, role });
  const res = NextResponse.json({ ok: true, user: { email: u.email, role, must_change: u.must_change } });
  res.headers.set('Set-Cookie', sessionCookie(token));
  return res;
}
