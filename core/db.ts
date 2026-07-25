// ── Data layer — Neon Postgres: config (encrypted secrets), stores, users, imports ──
import { neon } from '@neondatabase/serverless';
import { createHash, randomBytes, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto';

export const sql = neon(process.env.DATABASE_URL || '');
export const dbConfigured = () => Boolean(process.env.DATABASE_URL);

// ── AES-256-GCM at-rest encryption (key derived from APP_SECRET) ──
function keyBuf(): Buffer {
  return createHash('sha256').update(process.env.APP_SECRET || 'dev-insecure-change-me').digest();
}
export function encrypt(plain: string): string {
  if (!plain) return '';
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyBuf(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}
export function decrypt(enc: string): string {
  if (!enc || (enc.match(/\./g) || []).length !== 2) return '';
  try {
    const [ivB, tagB, ctB] = enc.split('.');
    const d = createDecipheriv('aes-256-gcm', keyBuf(), Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
  } catch { return ''; }
}

// ── password hashing (scrypt) ──
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt.${salt.toString('base64')}.${scryptSync(pw, salt, 32).toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  try {
    const [, saltB, hB] = stored.split('.');
    const h = scryptSync(pw, Buffer.from(saltB, 'base64'), 32);
    const want = Buffer.from(hB, 'base64');
    return h.length === want.length && timingSafeEqual(h, want);
  } catch { return false; }
}

// ── config / secrets (key → value; secrets stored encrypted) ──
export async function getConfig(key: string): Promise<string | null> {
  const r = (await sql`SELECT value, encrypted FROM app_config WHERE key = ${key}`) as any[];
  if (!r.length) return null;
  return r[0].encrypted ? decrypt(r[0].value) : r[0].value;
}
export async function setConfig(key: string, value: string, encrypted = false): Promise<void> {
  const stored = encrypted ? encrypt(value) : value;
  await sql`INSERT INTO app_config (key, value, encrypted, updated_at) VALUES (${key}, ${stored}, ${encrypted}, now())
            ON CONFLICT (key) DO UPDATE SET value = ${stored}, encrypted = ${encrypted}, updated_at = now()`;
}
export async function getAllConfig(): Promise<Record<string, string>> {
  const rows = (await sql`SELECT key, value, encrypted FROM app_config`) as any[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.encrypted ? decrypt(r.value) : r.value;
  return out;
}

// ── stores (multiple save destinations; token encrypted at rest) ──
export interface StoreRow { id: number; name: string; base_url: string; category_default: string; is_default: boolean; has_token: boolean }
export interface StoreResolved { id: number; name: string; base_url: string; token: string; category_default: string }

export async function listStores(): Promise<StoreRow[]> {
  const rows = (await sql`SELECT id, name, base_url, category_default, is_default, (token_enc <> '') AS has_token
                          FROM stores ORDER BY is_default DESC, id`) as any[];
  return rows.map((r) => ({ id: r.id, name: r.name, base_url: r.base_url, category_default: r.category_default, is_default: r.is_default, has_token: r.has_token }));
}
async function resolveRow(rows: any[]): Promise<StoreResolved | null> {
  if (!rows.length) return null;
  const r = rows[0];
  return { id: r.id, name: r.name, base_url: r.base_url, token: r.token_enc ? decrypt(r.token_enc) : '', category_default: r.category_default };
}
export async function getStoreResolved(id: number): Promise<StoreResolved | null> {
  return resolveRow((await sql`SELECT id, name, base_url, token_enc, category_default FROM stores WHERE id = ${id}`) as any[]);
}
export async function getDefaultStoreResolved(): Promise<StoreResolved | null> {
  return resolveRow((await sql`SELECT id, name, base_url, token_enc, category_default FROM stores WHERE is_default = true ORDER BY id LIMIT 1`) as any[]);
}
export async function upsertStore(i: { id?: number; name: string; base_url: string; token?: string; category_default?: string; is_default?: boolean }): Promise<number> {
  const name = (i.name || '').trim();
  const base = (i.base_url || '').trim().replace(/\/+$/, '');
  const cat = (i.category_default || 'toys').trim() || 'toys';
  const def = Boolean(i.is_default);
  if (!name || !base) throw new Error('name and base_url are required');
  if (def) await sql`UPDATE stores SET is_default = false WHERE is_default = true`;
  const hasNewToken = typeof i.token === 'string' && i.token.trim().length > 0;
  if (i.id) {
    if (hasNewToken) {
      await sql`UPDATE stores SET name=${name}, base_url=${base}, token_enc=${encrypt(i.token!.trim())}, category_default=${cat}, is_default=${def} WHERE id=${i.id}`;
    } else {
      await sql`UPDATE stores SET name=${name}, base_url=${base}, category_default=${cat}, is_default=${def} WHERE id=${i.id}`;
    }
    return i.id;
  }
  const rows = (await sql`INSERT INTO stores (name, base_url, token_enc, category_default, is_default)
                          VALUES (${name}, ${base}, ${hasNewToken ? encrypt(i.token!.trim()) : ''}, ${cat}, ${def}) RETURNING id`) as any[];
  return rows[0].id;
}
export async function deleteStore(id: number): Promise<void> {
  await sql`DELETE FROM stores WHERE id = ${id}`;
}

// ── health ──
export async function dbHealth(): Promise<{ ok: boolean; tables?: string[]; error?: string }> {
  if (!dbConfigured()) return { ok: false, error: 'DATABASE_URL not set' };
  try {
    const r = (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`) as any[];
    return { ok: true, tables: r.map((x) => x.table_name) };
  } catch (e: any) { return { ok: false, error: String(e?.message).slice(0, 160) }; }
}
