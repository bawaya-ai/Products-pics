// ── /api/config — server-side key management ──────────────────────────────
// GET  → per-provider status { set, source: db|env|none } (never values) + appPasswordRequired
// POST → save/edit keys to the DB (encrypted at rest). Empty string clears a key.
// Gated by the same app password as the rest of the app (open until one is set).

import { NextRequest, NextResponse } from 'next/server';
import { configStatus, saveConfigKeys, checkAppAuth } from '@/core/settings';
import { dbConfigured } from '@/core/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const providers = await configStatus();
  // whether the app-password gate is on (DB value or env), without leaking it
  let gateOn = Boolean(process.env.APP_PASSWORD);
  if (dbConfigured()) {
    try {
      const { getAllConfig } = await import('@/core/db');
      const db = await getAllConfig();
      gateOn = Boolean(db.appPassword || process.env.APP_PASSWORD);
    } catch { /* keep env value */ }
  }
  return NextResponse.json({ providers, dbConfigured: dbConfigured(), appPasswordRequired: gateOn });
}

export async function POST(req: NextRequest) {
  if (!(await checkAppAuth(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!dbConfigured()) return NextResponse.json({ error: 'DATABASE_URL not set — server storage unavailable' }, { status: 503 });
  const body = await req.json().catch(() => null);
  const keys = body?.keys;
  if (!keys || typeof keys !== 'object') return NextResponse.json({ error: 'keys object required' }, { status: 400 });
  try {
    const saved = await saveConfigKeys(keys);
    return NextResponse.json({ ok: true, saved });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message).slice(0, 200) }, { status: 500 });
  }
}
