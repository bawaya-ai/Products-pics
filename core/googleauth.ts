// ── Google service-account auth (no external dep) ──────────────────────────
// Mints a short-lived OAuth2 access token from a service-account key by signing a
// JWT (RS256) with node:crypto and exchanging it at the token endpoint. Token is
// cached in-process until ~1 min before expiry. The SA key value is a SECRET —
// it is read from resolved settings (DB-encrypted or env), never logged.

import { createSign, createHash } from 'node:crypto';

interface SaKey { client_email: string; private_key: string; token_uri: string }

/** Accept the raw JSON key file contents OR a base64-encoded copy of it. */
function parseSaKey(raw: string): SaKey | null {
  try {
    const t = raw.trim();
    const txt = t.startsWith('{') ? t : Buffer.from(t, 'base64').toString('utf8');
    const j = JSON.parse(txt);
    if (j.client_email && j.private_key) {
      return { client_email: j.client_email, private_key: j.private_key, token_uri: j.token_uri || 'https://oauth2.googleapis.com/token' };
    }
  } catch { /* fall through */ }
  return null;
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

// cache keyed by the key's fingerprint so a rotated key never serves a stale token
let cache: { fp: string; token: string; exp: number } | null = null;

export async function getGoogleAccessToken(
  saKeyRaw: string,
  scope = 'https://www.googleapis.com/auth/cloud-platform',
): Promise<string> {
  const key = parseSaKey(saKeyRaw);
  if (!key) throw new Error('invalid service-account key (expected the JSON key file, raw or base64)');
  // fingerprint includes the private key so a rotated/forged key can never hit a token
  // minted from a different key (a garbage key then misses cache → sign() throws, as it should)
  const fp = createHash('sha256').update(key.client_email + '|' + key.private_key + '|' + scope).digest('hex');
  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.fp === fp && cache.exp - 60 > now) return cache.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: key.client_email, scope, aud: key.token_uri, iat: now, exp: now + 3600 };
  const signingInput = `${b64url(header)}.${b64url(claim)}`;
  const sig = createSign('RSA-SHA256').update(signingInput).sign(key.private_key).toString('base64url');
  const jwt = `${signingInput}.${sig}`;

  const r = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`google token ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const d = (await r.json()) as any;
  if (!d.access_token) throw new Error('google token: no access_token in response');
  cache = { fp, token: d.access_token, exp: now + (Number(d.expires_in) || 3600) };
  return cache.token;
}
