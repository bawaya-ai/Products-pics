// ── Web image search — find product images by a text query ─────────────────
// Two providers, best-first:
//   google  → Google Programmable Search (Custom Search JSON API) in IMAGE mode.
//             Returns direct image URLs — cleanest. Free up to 100 queries/day.
//   firecrawl → Firecrawl /search with html scrape of the top results, then
//             harvest product images from those pages. No image API needed.
// Copyright note: general web images are of unknown provenance — the UI warns.

import type { Settings } from './settings';
import { collectImageUrls, fetchImage } from './extract';
import sharp from 'sharp';

export interface WebSearchResult { imageUrls: string[]; provider: string; warnings: string[] }
export interface ProductSearchResult { urls: string[]; provider: string; warnings: string[] }

// bare host from a domain/url (for `site:` scoping)
function bareSite(input: string): string {
  return input.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '');
}

/** SPECIFIC-PRODUCT search: a query (product name) → best candidate image URLs. Honors searchProvider. */
export async function searchImages(
  query: string,
  s: Settings,
  log: (m: string) => void,
): Promise<WebSearchResult> {
  const warnings: string[] = [];
  const q = query.trim().slice(0, 200);
  const provider = s.searchProvider || 'auto';

  // 1) Google CSE image search (direct image URLs) — unless the user forced Firecrawl
  if ((provider === 'auto' || provider === 'google') && s.googleCseKey && s.googleCseCx) {
    try {
      const urls = await googleImageSearch(q, s.googleCseKey, s.googleCseCx);
      if (urls.length) { log(`Google CSE: ${urls.length} image results`); return { imageUrls: urls, provider: 'google', warnings }; }
      warnings.push('google_cse_no_results');
    } catch (e: any) { warnings.push(`google_cse_failed: ${String(e?.message).slice(0, 80)}`); }
  }

  // 2) Firecrawl search → scrape top result pages → harvest images
  if ((provider === 'auto' || provider === 'firecrawl') && s.firecrawlKey) {
    try {
      const urls = await firecrawlSearchImages(q, s.firecrawlKey, log);
      if (urls.length) { log(`Firecrawl search: ${urls.length} images from result pages`); return { imageUrls: urls, provider: 'firecrawl', warnings }; }
      warnings.push('firecrawl_search_no_images');
    } catch (e: any) { warnings.push(`firecrawl_search_failed: ${String(e?.message).slice(0, 80)}`); }
  }

  warnings.push(provider === 'google'
    ? 'google_cse_only_but_unavailable — Google CSE مش شغّال (محجوب)، غيّر المزوّد لـ Firecrawl'
    : 'no_search_provider — أضف مفتاح Firecrawl (أو Google CSE) بالإعدادات');
  return { imageUrls: [], provider: 'none', warnings };
}

/** CATEGORY search: a type/category query → a list of distinct product-PAGE URLs (each scraped
 *  separately by the caller). Optional `site` scopes the search to one shop. Firecrawl-only. */
export async function searchProductPages(
  query: string,
  site: string | undefined,
  limit: number,
  s: Settings,
  log: (m: string) => void,
): Promise<ProductSearchResult> {
  const warnings: string[] = [];
  const cap = Math.min(Math.max(Number(limit) || 10, 1), 20);
  let q = query.trim().slice(0, 200);
  if (site && site.trim()) q = `${q} site:${bareSite(site)}`;
  if (!s.firecrawlKey) { warnings.push('no_firecrawl_key — بحث الفئات يحتاج مفتاح Firecrawl'); return { urls: [], provider: 'none', warnings }; }
  try {
    const r = await fetch('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.firecrawlKey}` },
      body: JSON.stringify({ query: q, limit: cap }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) { warnings.push(`firecrawl_search_${r.status}`); return { urls: [], provider: 'firecrawl', warnings }; }
    const d = (await r.json()) as any;
    const results: any[] = d.data || [];
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const x of results) {
      const u: string = x?.url || x?.metadata?.sourceURL || '';
      if (!/^https?:\/\//i.test(u)) continue;
      const norm = u.split('#')[0];
      if (seen.has(norm)) continue;
      seen.add(norm); urls.push(u);
      if (urls.length >= cap) break;
    }
    log(`Firecrawl: ${urls.length} product pages for "${query}"${site ? ` @${bareSite(site)}` : ''}`);
    return { urls, provider: 'firecrawl', warnings };
  } catch (e: any) { warnings.push(`firecrawl_search_failed: ${String(e?.message).slice(0, 80)}`); return { urls: [], provider: 'firecrawl', warnings }; }
}

async function googleImageSearch(q: string, key: string, cx: string): Promise<string[]> {
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&searchType=image&num=10&safe=off&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`CSE ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const d = (await r.json()) as any;
  const items: any[] = d.items || [];
  // Prefer larger results (CSE gives image.width/height); sort desc.
  return items
    .filter((it) => it.link && /^https?:\/\//i.test(it.link))
    .sort((a, b) => (b.image?.width || 0) * (b.image?.height || 0) - (a.image?.width || 0) * (a.image?.height || 0))
    .map((it) => it.link as string)
    .slice(0, 10);
}

async function firecrawlSearchImages(q: string, key: string, log: (m: string) => void): Promise<string[]> {
  const r = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, limit: 4, scrapeOptions: { formats: ['html'] } }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`search ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const d = (await r.json()) as any;
  const results: any[] = d.data || [];
  const all: string[] = [];
  for (const res of results.slice(0, 4)) {
    const html: string = res.html || res.rawHtml || '';
    const base: string = res.url || res.metadata?.sourceURL || 'https://example.com';
    if (html) all.push(...collectImageUrls(html, base, 6));
    if (all.length >= 18) break;
  }
  // de-dupe by base and keep the first ~14
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of all) { const b = u.split('?')[0]; if (!seen.has(b)) { seen.add(b); out.push(u); } }
  log(`firecrawl scanned ${results.length} pages`);
  return out.slice(0, 14);
}

/** Verify a URL is a fetchable, non-tiny image (cheap pre-filter before the pool). */
export async function isUsableImage(url: string): Promise<boolean> {
  const got = await fetchImage(url);
  if (!got) return false;
  try {
    const m = await sharp(got.buf).metadata();
    return (m.width ?? 0) >= 200 && (m.height ?? 0) >= 200;
  } catch { return false; }
}
