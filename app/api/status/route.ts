// ── GET /api/status — which keys are configured server-side (booleans only) ──
// Never returns values. The UI combines this with its own (browser) fields to
// show each provider as: saved-on-server / saved-in-browser / missing.
// Auth-gated: even booleans are a config map an attacker shouldn't get for free.

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/core/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = requireRole(req); if ('error' in g) return g.error;
  const e = process.env;
  const has = (v?: string) => Boolean(v && v.trim());
  return NextResponse.json({
    env: {
      anthropic: has(e.ANTHROPIC_API_KEY),
      openai: has(e.OPENAI_API_KEY),
      removebg: has(e.REMOVEBG_API_KEY),
      replicate: has(e.REPLICATE_API_TOKEN),
      firecrawl: has(e.FIRECRAWL_API_KEY),
      googleCse: has(e.GOOGLE_CSE_KEY) && has(e.GOOGLE_CSE_CX),
      storeBase: has(e.STORE_BASE),
      storeToken: has(e.STORE_IMPORT_TOKEN),
      appPassword: has(e.APP_PASSWORD),
    },
    appPasswordRequired: has(e.APP_PASSWORD),
  });
}
