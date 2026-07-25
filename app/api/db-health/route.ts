import { NextResponse } from 'next/server';
import { dbHealth } from '@/core/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await dbHealth());
}
