// ── POST /api/discover — find product-page URLs on a listing/category page ──
// { url, settings } → { productUrls: [...] }. The UI then scrapes each one via
// /api/scrape. Uses plain fetch first, Firecrawl render as fallback for JS pages.

import { NextRequest, NextResponse } from 'next/server';
import { resolveSettings, checkAppAuth } from '@/core/settings';
import { assertPublicUrl, collectProductLinks } from '@/core/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function firecrawlHtml(url: string, key: string): Promise<string | null> {
  try {
    const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ['html'], waitFor: 3500, timeout: 30000 }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as any;
    return d?.data?.html || d?.html || null;
  } catch { return null; }
}

export async function POST(req: NextRequest) {
  if (!checkAppAuth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  const input: string = (body?.url || '').trim();
  if (!/^https?:\/\//i.test(input)) return NextResponse.json({ error: 'a listing URL is required' }, { status: 400 });

  const s = resolveSettings(body?.settings);
  const limit = Math.min(Number(body?.limit) || 16, 24);

  let target: URL;
  try { target = assertPublicUrl(input); } catch (e: any) { return NextResponse.json({ error: String(e?.message) }, { status: 400 }); }

  const warnings: string[] = [];
  let html = '';
  try {
    const r = await fetch(target.href, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(20000) });
    html = await r.text();
  } catch (e: any) { warnings.push(`fetch failed: ${e?.message}`); }

  let links = html ? collectProductLinks(html, target.href, limit) : [];

  // JS-rendered listing → Firecrawl render fallback
  if (links.length < 3 && s.firecrawlKey) {
    const rendered = await firecrawlHtml(target.href, s.firecrawlKey);
    if (rendered) links = collectProductLinks(rendered, target.href, limit);
    else warnings.push('firecrawl render failed');
  } else if (links.length < 3 && !s.firecrawlKey) {
    warnings.push('few links in raw HTML and no Firecrawl key');
  }

  // drop the listing page itself
  links = links.filter((u) => u.replace(/\/+$/, '') !== target.href.replace(/[?#].*$/, '').replace(/\/+$/, ''));
  return NextResponse.json({ productUrls: links.slice(0, limit), count: links.length, warnings });
}
