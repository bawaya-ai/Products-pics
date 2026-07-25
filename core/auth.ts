// ── Auth: signed session cookies (HMAC) + role gate + reset tokens ─────────
// Sessions are STATELESS signed cookies (HMAC-SHA256 keyed by APP_SECRET). The
// authoritative verification (signature + expiry + role) runs in Node route
// handlers / server components. Edge middleware only checks cookie PRESENCE for
// coarse routing/redirects — it is not the security boundary.

import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { getUserById } from './db';

export const SESSION_COOKIE = 'sp_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24h — bounds the stale-session window
const RESET_TTL_MS = 1000 * 60 * 30; // 30 min

export type Role = 'admin' | 'operator';
export interface Session { uid: number; email: string; role: Role; exp: number }

function key(): Buffer {
  const s = process.env.APP_SECRET || '';
  // Fail CLOSED in production: never sign/verify sessions (or key at-rest crypto) with the
  // public dev fallback — a forgotten APP_SECRET would make every session cookie forgeable.
  if (process.env.NODE_ENV === 'production' && s.length < 16) {
    throw new Error('APP_SECRET is required (min 16 chars) in production');
  }
  return createHash('sha256').update(s || 'dev-insecure-change-me').digest();
}
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signSession(sess: { uid: number; email: string; role: Role; exp?: number }): string {
  const payload = { uid: sess.uid, email: sess.email, role: sess.role, exp: sess.exp ?? Date.now() + SESSION_TTL_MS };
  const p = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', key()).update(p).digest());
  return `${p}.${sig}`;
}

export function verifySession(token: string | undefined | null): Session | null {
  if (!token || token.indexOf('.') < 0) return null;
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  const expected = b64url(createHmac('sha256', key()).update(p).digest());
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(unb64url(p).toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (payload.role !== 'admin' && payload.role !== 'operator') return null;
    return payload as Session;
  } catch { return null; }
}

/** Read + verify the session from a Request's Cookie header (Node handlers). */
export function sessionFromReq(req: Request): Session | null {
  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
  return m ? verifySession(decodeURIComponent(m[1])) : null;
}

/** 401 if not logged in, 403 if role insufficient. Returns the session otherwise.
 *  Fast, stateless — the token's role is trusted (bounded by the TTL). For privileged
 *  MUTATIONS use requireRoleFresh so a demoted/deleted admin's live cookie is rejected now. */
export function requireRole(req: Request, role?: Role): { session: Session } | { error: Response } {
  const s = sessionFromReq(req);
  if (!s) return { error: json({ error: 'unauthorized' }, 401) };
  if (role === 'admin' && s.role !== 'admin') return { error: json({ error: 'forbidden' }, 403) };
  return { session: s };
}

/** Like requireRole but re-checks the DB: the user must still exist and still hold the role.
 *  Use on admin-gated mutations so role changes / deletions take effect immediately. */
export async function requireRoleFresh(req: Request, role?: Role): Promise<{ session: Session } | { error: Response }> {
  const base = requireRole(req, role);
  if ('error' in base) return base;
  const u = await getUserById(base.session.uid).catch(() => null);
  if (!u) return { error: json({ error: 'unauthorized' }, 401) };
  const freshRole: Role = u.role === 'admin' ? 'admin' : 'operator';
  if (role === 'admin' && freshRole !== 'admin') return { error: json({ error: 'forbidden' }, 403) };
  return { session: { ...base.session, role: freshRole } };
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── cookies ──
// COOKIE_DOMAIN=.baw-ai.dev lets the session be shared between baw-ai.dev and
// admin.baw-ai.dev; unset → host-only (fine on a single vercel.app domain).
function cookieAttrs(): string {
  const dom = process.env.COOKIE_DOMAIN ? `; Domain=${process.env.COOKIE_DOMAIN}` : '';
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `; Path=/; HttpOnly; SameSite=Lax${secure}${dom}`;
}
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}${cookieAttrs()}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=${cookieAttrs()}; Max-Age=0`;
}

// ── reset tokens: raw is emailed, only its sha256 is stored in the DB ──
export function makeResetToken(): { raw: string; hash: string; expires: Date } {
  const raw = randomBytes(32).toString('hex');
  return { raw, hash: createHash('sha256').update(raw).digest('hex'), expires: new Date(Date.now() + RESET_TTL_MS) };
}
export function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
