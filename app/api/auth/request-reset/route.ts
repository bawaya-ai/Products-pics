// ── POST /api/auth/request-reset — email a reset link (via Resend) ─────────
// Always returns {ok:true} regardless of whether the email exists (no enumeration).
import { NextRequest, NextResponse } from 'next/server';
import { getUserByEmail, setResetToken } from '@/core/db';
import { makeResetToken } from '@/core/auth';
import { sendResetEmail } from '@/core/mailer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = String(body?.email || '').trim();
  if (!email) return NextResponse.json({ error: 'الإيميل مطلوب' }, { status: 400 });

  const u = await getUserByEmail(email).catch(() => null);
  if (u) {
    const { raw, hash, expires } = makeResetToken();
    await setResetToken(u.id, hash, expires).catch(() => {});
    const url = `${resetBaseUrl(req)}/reset?token=${raw}&email=${encodeURIComponent(u.email)}`;
    await sendResetEmail(u.email, url).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}

// The reset link carries a live secret token, so its host must NOT come from the
// untrusted Host header (host-header poisoning → token theft). Use a fixed server
// value (APP_URL), else only a known-good Host, else a safe default.
const ALLOWED_HOSTS = new Set(['baw-ai.dev', 'admin.baw-ai.dev', 'scraper-pro-zeta.vercel.app']);
function resetBaseUrl(req: NextRequest): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  const host = (req.headers.get('host') || '').toLowerCase();
  if (ALLOWED_HOSTS.has(host)) return `https://${host}`;
  return 'https://baw-ai.dev';
}
