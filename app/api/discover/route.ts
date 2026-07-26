// ── POST /api/discover — find product-page URLs from a DOMAIN or listing page ──
// Give it a bare domain (lelo.com), a homepage, or a listing/category page.
// It fetches the page, collects product links; if not enough, it discovers the
// shop/products/store/collection/category pages and harvests products from those.
// Returns up to `limit` product URLs. Uses Firecrawl render for JS-heavy sites.

import { NextRequest, NextResponse } from 'next/server';
import { resolveSettings } from '@/core/settings';
import { requireRole } from '@/core/auth';
import { bumpCounter, dbConfigured } from '@/core/db';
import { assertPublicUrl, collectProductLinks } from '@/core/extract';
import { searchProductPages } from '@/core/websearch';

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
    assertPublicUrl(url); // seeds come from search providers — untrusted, guard every fetch
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(18000) });
    html = await r.text();
  } catch { /* ignore */ }
  return html;
}

const bareHost = (h: string) => h.replace(/^www\./i, '');

// ── Sitemap-first product discovery: Shopify publishes /sitemap_products_1.xml and Woo
// lists product URLs in child sitemaps — one or two cheap fetches beat every HTML
// heuristic on recall. Best-effort: any failure returns [] and the HTML path runs. ──
const PRODUCT_PATH = /\/(products?|item|p)\//i;
async function sitemapProducts(origin: string, want: number): Promise<string[]> {
  const out: string[] = [];
  const fetchText = async (u: string): Promise<string> => {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,*/*' }, signal: AbortSignal.timeout(8000) });
      return r.ok ? await r.text() : '';
    } catch { return ''; }
  };
  const idx = await fetchText(`${origin}/sitemap.xml`);
  if (!idx) return out;
  const locs = [...idx.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  const childMaps = locs.filter((u) => /sitemap[^<]*\.xml/i.test(u));
  const productMaps = childMaps.filter((u) => /product/i.test(u));
  const maps = productMaps.length ? productMaps.slice(0, 3) : childMaps.slice(0, 3);
  const xmls = maps.length ? await Promise.all(maps.map(fetchText)) : [idx];
  for (const xml of xmls) {
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const u = m[1];
      if (/\.xml(\?|$)/i.test(u)) continue;
      if (PRODUCT_PATH.test(u)) { out.push(u); if (out.length >= want * 2) return out; }
    }
  }
  return out;
}
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
  const g = requireRole(req); if ('error' in g) return g.error;
  // safety cap — one discover fans out into many paid calls; bound it per user per day
  if (dbConfigured()) {
    const cap = Math.max(1, Number(process.env.DAILY_DISCOVER_CAP) || 150);
    const n = await bumpCounter(`discover:${g.session.uid}`).catch(() => 0);
    if (n > cap) return NextResponse.json({ error: `وصلت سقف الأمان اليومي للاكتشاف (${cap}). ارفع DAILY_DISCOVER_CAP إذا مقصود.` }, { status: 429 });
  }
  const body = await req.json().catch(() => null);
  const s = await resolveSettings(body?.settings);
  const limit = Math.min(Number(body?.limit) || 10, 20);

  const started = Date.now();
  const timeLeft = () => Date.now() - started < TIME_BUDGET_MS;
  const warnings: string[] = [];
  const products = new Set<string>();
  const add = (arr: string[]) => { for (const u of arr) { products.add(u); if (products.size >= limit) break; } };

  // Harvest individual product links from a page (listing → its products), with a render fallback.
  const scan = async (url: string): Promise<string> => {
    let html = await getHtml(url, s.firecrawlKey);
    let found = html ? collectProductLinks(html, url, limit) : [];
    if (found.length < 3 && s.firecrawlKey && timeLeft()) {
      const rendered = await firecrawlHtml(url, s.firecrawlKey);
      if (rendered) { html = rendered; found = collectProductLinks(rendered, url, limit); }
    }
    add(found.filter((u) => u.replace(/[?#].*$/, '').replace(/\/+$/, '') !== url.replace(/[?#].*$/, '').replace(/\/+$/, '')));
    return html;
  };

  // ── CATEGORY mode: search the web for the type → decide per result: a page with MANY
  //    product links is a listing (harvest its products); a page with few/none is a
  //    product page itself (add the page). Decided on links FOUND, not the net set delta,
  //    so a product page's "related items" strip doesn't drop the actual product. ──
  const norm = (u: string) => u.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const query = (body?.query || '').trim();
  if (query) {
    const res = await searchProductPages(query, body?.site ? String(body.site) : undefined, Math.min(limit + 2, 20), s, () => {});
    warnings.push(...res.warnings);
    for (const seed of res.urls) {
      if (products.size >= limit || !timeLeft()) break;
      let html = await getHtml(seed, s.firecrawlKey);
      let links = html ? collectProductLinks(html, seed, limit) : [];
      if (links.length < 3 && s.firecrawlKey && timeLeft()) {
        const rendered = await firecrawlHtml(seed, s.firecrawlKey);
        if (rendered) links = collectProductLinks(rendered, seed, limit);
      }
      links = links.filter((u) => norm(u) !== norm(seed));
      if (links.length >= 4) add(links);    // a listing/category page → its products
      else products.add(seed);               // a product page (or article) → the page itself
    }
    const clist = [...products].slice(0, limit);
    if (!clist.length) warnings.push('ما لقيت منتجات بهالفئة — جرّب صياغة تانية أو حدّد موقع.');
    return NextResponse.json({ productUrls: clist, count: clist.length, warnings });
  }

  // ── DOMAIN mode: a bare domain / listing URL → discover product links on the site. ──
  let input: string = (body?.url || '').trim();
  if (!input) return NextResponse.json({ error: 'a domain or listing URL is required' }, { status: 400 });
  if (!/^https?:\/\//i.test(input)) input = 'https://' + input.replace(/^\/+/, '');

  let target: URL;
  try { target = assertPublicUrl(input); } catch (e: any) { return NextResponse.json({ error: String(e?.message) }, { status: 400 }); }
  const host = target.host;

  // 0) sitemap-first — highest recall for the cheapest possible calls
  if (timeLeft()) {
    const sm = await sitemapProducts(target.origin, limit);
    if (sm.length) { add(sm); warnings.push(`sitemap: لقينا ${Math.min(sm.length, limit)} منتج من خريطة الموقع مباشرة`); }
  }

  // 1) scan the given page directly (works if it's already a listing)
  let homeHtml = '';
  if (products.size < limit && timeLeft()) homeHtml = await scan(target.href);

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
