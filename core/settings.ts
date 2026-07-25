// ── Settings: client prefs + keys resolved from DB (editable) → env → client ──
import { getAllConfig, setConfig, dbConfigured } from './db';

export interface Settings {
  size: number; quality: number; format: 'webp' | 'png'; maxImages: number;
  bgMode: 'auto' | 'off' | 'replicate' | 'removebg' | 'local' | 'imgly' | 'openai';
  replicateKey?: string; replicateModel?: string; removebgKey?: string; allowOpenAIImages?: boolean;
  aiEnabled: boolean; anthropicKey?: string; anthropicModel?: string; openaiKey?: string;
  firecrawlKey?: string; googleCseKey?: string; googleCseCx?: string;
  storeBase?: string; storeToken?: string; category?: string; publish?: boolean;
  searchProvider?: 'auto' | 'firecrawl' | 'google';
}

const DEFAULTS: Settings = {
  size: 1024, quality: 88, format: 'webp', maxImages: 8,
  bgMode: 'auto', aiEnabled: true, anthropicModel: 'claude-opus-4-8', category: 'toys', publish: true,
  searchProvider: 'auto',
};

// setting key → env var name
const ENV_MAP: Record<string, string> = {
  replicateKey: 'REPLICATE_API_TOKEN', removebgKey: 'REMOVEBG_API_KEY', anthropicKey: 'ANTHROPIC_API_KEY',
  openaiKey: 'OPENAI_API_KEY', firecrawlKey: 'FIRECRAWL_API_KEY', googleCseKey: 'GOOGLE_CSE_KEY',
  googleCseCx: 'GOOGLE_CSE_CX', storeBase: 'STORE_BASE', storeToken: 'STORE_IMPORT_TOKEN',
};
const KEY_FIELDS = Object.keys(ENV_MAP);
// extra app_config keys that aren't provider KEY_FIELDS but are still admin-editable
const EXTRA_CONFIG = new Set(['appPassword', 'resendKey', 'resendFrom']);
// which stored values are secrets (encrypted at rest); URLs/ids/senders are not
const NON_SECRET = new Set(['storeBase', 'googleCseCx', 'resendFrom']);

/** Resolve keys: DB (UI-editable, wins) → env (legacy) → client. Prefs from client/defaults. */
export async function resolveSettings(client: Partial<Settings> | undefined): Promise<Settings> {
  const s: Settings = { ...DEFAULTS, ...(client || {}) };
  s.size = clamp(Number(s.size) || 1024, 256, 2048);
  s.quality = clamp(Number(s.quality) || 88, 40, 100);
  s.maxImages = clamp(Number(s.maxImages) || 8, 1, 12);
  if (s.format !== 'png') s.format = 'webp';

  const db = dbConfigured() ? await getAllConfig().catch(() => ({} as Record<string, string>)) : {};
  for (const k of KEY_FIELDS) {
    // The store destination (base + token) is resolved SERVER-SIDE ONLY (DB → env), never from the
    // client body — otherwise a caller could pair an attacker-controlled storeBase with the server's
    // real storeToken and have us POST the secret token to their URL (token exfiltration).
    const serverOnly = k === 'storeBase' || k === 'storeToken';
    (s as any)[k] = db[k] || process.env[ENV_MAP[k]] || (serverOnly ? undefined : (s as any)[k]) || undefined;
  }
  return s;
}

/** Per-provider config status for the UI (booleans + source; never values). */
export async function configStatus(): Promise<Record<string, { set: boolean; source: 'db' | 'env' | 'none' }>> {
  const db = dbConfigured() ? await getAllConfig().catch(() => ({} as Record<string, string>)) : {};
  const providers: Record<string, string> = {
    firecrawl: 'firecrawlKey', anthropic: 'anthropicKey', openai: 'openaiKey',
    replicate: 'replicateKey', removebg: 'removebgKey', googleCse: 'googleCseKey', store: 'storeToken',
  };
  const out: Record<string, { set: boolean; source: 'db' | 'env' | 'none' }> = {};
  for (const [id, key] of Object.entries(providers)) {
    const inDb = Boolean(db[key]); const inEnv = Boolean(process.env[ENV_MAP[key]]);
    out[id] = { set: inDb || inEnv, source: inDb ? 'db' : inEnv ? 'env' : 'none' };
  }
  return out;
}

/** Save editable keys to the DB (secrets encrypted). Empty string clears a key. */
export async function saveConfigKeys(keys: Record<string, unknown>): Promise<string[]> {
  const saved: string[] = [];
  for (const [k, v] of Object.entries(keys)) {
    if (!KEY_FIELDS.includes(k) && !EXTRA_CONFIG.has(k)) continue;
    if (typeof v !== 'string') continue;
    await setConfig(k, v.trim(), !NON_SECRET.has(k)); // encrypt everything except URLs/ids
    saved.push(k);
  }
  return saved;
}

/** App password gate: DB value (editable) → env → open only if genuinely unset.
 *  Fails CLOSED on a DB read error: a transient Neon blip must not silently disable the gate. */
export async function checkAppAuth(req: Request): Promise<boolean> {
  const envPw = process.env.APP_PASSWORD || '';
  let dbPw = ''; let dbFailed = false;
  if (dbConfigured()) {
    try { const db = await getAllConfig(); dbPw = db.appPassword || ''; }
    catch { dbFailed = true; }
  }
  const want = dbPw || envPw;
  if (want) return req.headers.get('x-app-password') === want;
  // No password known. If the DB read failed we can't be sure one isn't configured → deny.
  if (dbFailed) return false;
  return true; // genuinely unset → open (documented default)
}

function clamp(n: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, n)); }
