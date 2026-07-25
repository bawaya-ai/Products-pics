// ── GET /api/auth/me — current session (or {user:null}) ────────────────────
import { NextRequest, NextResponse } from 'next/server';
import { sessionFromReq } from '@/core/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = sessionFromReq(req);
  return NextResponse.json({ user: s ? { email: s.email, role: s.role } : null });
}
