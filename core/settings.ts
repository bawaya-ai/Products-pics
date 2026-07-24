// ── Settings: client-provided values merged with server env (env wins) ─────

export interface Settings {
  // output
  size: number;            // unified square size (px)
  quality: number;         // webp/png quality
  format: 'webp' | 'png';
  maxImages: number;
  // background removal
  bgMode: 'auto' | 'off' | 'replicate' | 'removebg' | 'local' | 'imgly' | 'openai'; // 'imgly' = legacy alias of 'local'
  replicateKey?: string;
  replicateModel?: string; // e.g. "bria/remove-background" or "owner/model:versionhash"
  removebgKey?: string;
  allowOpenAIImages?: boolean;
  // AI enrichment
  aiEnabled: boolean;
  anthropicKey?: string;
  anthropicModel?: string;
  openaiKey?: string;
  // extraction
  firecrawlKey?: string;
  // web image search (by product name)
  googleCseKey?: string;
  googleCseCx?: string;
  // target store (kiss-play adapter)
  storeBase?: string;
  storeToken?: string;
  category?: string;
  publish?: boolean;
}

const DEFAULTS: Settings = {
  size: 1024,
  quality: 88,
  format: 'webp',
  maxImages: 8,
  bgMode: 'auto',
  aiEnabled: true,
  anthropicModel: 'claude-opus-4-8',
  category: 'toys',
  publish: true,
};

/** Merge order: defaults ← client settings ← server env (env always wins for keys). */
export function resolveSettings(client: Partial<Settings> | undefined): Settings {
  const e = process.env;
  const s: Settings = { ...DEFAULTS, ...(client || {}) };
  s.size = clamp(Number(s.size) || 1024, 256, 2048);
  s.quality = clamp(Number(s.quality) || 88, 40, 100);
  s.maxImages = clamp(Number(s.maxImages) || 8, 1, 12);
  if (s.format !== 'png') s.format = 'webp';

  s.replicateKey = e.REPLICATE_API_TOKEN || s.replicateKey;
  s.removebgKey = e.REMOVEBG_API_KEY || s.removebgKey;
  s.anthropicKey = e.ANTHROPIC_API_KEY || s.anthropicKey;
  s.openaiKey = e.OPENAI_API_KEY || s.openaiKey;
  s.firecrawlKey = e.FIRECRAWL_API_KEY || s.firecrawlKey;
  s.googleCseKey = e.GOOGLE_CSE_KEY || s.googleCseKey;
  s.googleCseCx = e.GOOGLE_CSE_CX || s.googleCseCx;
  s.storeBase = e.STORE_BASE || s.storeBase;
  s.storeToken = e.STORE_IMPORT_TOKEN || s.storeToken;
  return s;
}

/** Optional shared password for the whole app (set APP_PASSWORD env to enable). */
export function checkAppAuth(req: Request): boolean {
  const want = process.env.APP_PASSWORD;
  if (!want) return true;
  return req.headers.get('x-app-password') === want;
}

function clamp(n: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, n)); }
