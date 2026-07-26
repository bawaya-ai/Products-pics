// ── GET /api/db-health — DB reachability. Public shape is {ok} ONLY; the table
// list / driver error details (a ready-made recon map) require an admin session.

import { NextRequest, NextResponse } from 'next/server';
import { dbHealth } from '@/core/db';
import { requireRole } from '@/core/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = requireRole(req); if ('error' in g) return g.error;
  const h = await dbHealth();
  if (g.session.role !== 'admin') return NextResponse.json({ ok: h.ok });
  return NextResponse.json(h);
}
