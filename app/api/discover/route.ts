// ── POST /api/discover — find product-page URLs from a DOMAIN or listing page ──
// Give it a bare domain (lelo.com), a homepage, or a listing/category page.
// It fetches the page, collects product links; if not enough, it discovers the
// shop/products/store/collection/category pages and harvests products from those.
// Returns up to `limit` product URLs. Uses Firecrawl render for JS-heavy sites.

import { NextRequest, NextResponse } from 'next/server';
import { resolveSettings, checkAppAuth } from '@/core/settings';
import { assertPublicUrl, collectProductLinks } from '@/core/extract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIME_BUDGET_MS = 48_000;

// paths that usually list many products
const LISTING_HINT = /\/(shop|products?|store|collections?|catalog(?:ue)?|categor(?:y|ies)|best-?sellers?|all-products|shop-all|new-arrivals?|sale|featured|toys|for-(?:her|him|women|men|couples))(\/|$|\?)/i;
// common shop paths to probe if the homepage gives nothing
const COMMON_PATHS = ['/collections/all', '/shop', '/products', '/store', '/collections', '/catalog', '/bestsellers', '/shop-all', '/all', '/product-category'];

async function firecrawlHtml(url: string, key?: string): Promise<string | null> {
  if (!key) return null;
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

async function getHtml(url: string, key?: string): Promise<string> {
  let html = '';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(18000) });
    html = await r.text();
  } catch { /* ignore */ }
  return html;
}

const bareHost = (h: string) => h.replace(/^www\./i, '');
function findListingUrls(html: string, baseHref: string, host: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"'#\s]+)["']/gi)) {
    let u = m[1];
    if (u.startsWith('//')) u = 'https:' + u;
    else if (!/^https?:\/\//i.test(u)) { try { u = new URL(u, baseHref).href; } catch { continue; } }
    let p: URL; try { p = new URL(u); } catch { continue; }
    if (bareHost(p.host) !== bareHost(host)) continue;
    if (LISTING_HINT.test(p.pathname)) out.add(p.origin + p.pathname);
  }
  return [...out].slice(0, 8);
}

export async function POST(req: NextRequest) {
  if (!(await checkAppAuth(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  let input: string = (body?.url || '').trim();
  if (!input) return NextResponse.json({ error: 'a domain or listing URL is required' }, { status: 400 });
  if (!/^https?:\/\//i.test(input)) input = 'https://' + input.replace(/^\/+/, '');

  const s = await resolveSettings(body?.settings);
  const limit = Math.min(Number(body?.limit) || 10, 20);
  const started = Date.now();
  const timeLeft = () => Date.now() - started < TIME_BUDGET_MS;

  let target: URL;
  try { target = assertPublicUrl(input); } catch (e: any) { return NextResponse.json({ error: String(e?.message) }, { status: 400 }); }
  const host = target.host;
  const warnings: string[] = [];
  const products = new Set<string>();
  const add = (arr: string[]) => { for (const u of arr) { products.add(u); if (products.size >= limit) break; } };

  const scan = async (url: string) => {
    let html = await getHtml(url, s.firecrawlKey);
    let found = html ? collectProductLinks(html, url, limit) : [];
    if (found.length < 3 && s.firecrawlKey && timeLeft()) {
      const rendered = await firecrawlHtml(url, s.firecrawlKey);
      if (rendered) { html = rendered; found = collectProductLinks(rendered, url, limit); }
    }
    add(found.filter((u) => u.replace(/[?#].*$/, '').replace(/\/+$/, '') !== url.replace(/[?#].*$/, '').replace(/\/+$/, '')));
    return html;
  };

  // 1) scan the given page directly (works if it's already a listing)
  const homeHtml = await scan(target.href);

  // 2) not enough? discover listing/shop pages and scan them
  if (products.size < limit && timeLeft()) {
    const listings = [
      ...findListingUrls(homeHtml, target.href, host),
      ...COMMON_PATHS.map((p) => `${target.origin}${p}`),
    ];
    const seen = new Set<string>([target.href.replace(/\/+$/, '')]);
    for (const lu of listings) {
      if (products.size >= limit || !timeLeft()) break;
      const norm = lu.replace(/\/+$/, '');
      if (seen.has(norm)) continue;
      seen.add(norm);
      await scan(lu);
    }
  }

  const list = [...products].slice(0, limit);
  if (!list.length) warnings.push(s.firecrawlKey ? 'ما لقيت منتجات — جرّب رابط صفحة متجر/تصنيف مباشرة.' : 'ما لقيت منتجات وما في مفتاح Firecrawl للمواقع الديناميكية.');
  return NextResponse.json({ productUrls: list, count: list.length, warnings });
}
