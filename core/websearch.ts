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

export async function searchImages(
  query: string,
  s: Settings,
  log: (m: string) => void,
): Promise<WebSearchResult> {
  const warnings: string[] = [];
  const q = query.trim().slice(0, 200);

  // 1) Google CSE image search (direct image URLs)
  if (s.googleCseKey && s.googleCseCx) {
    try {
      const urls = await googleImageSearch(q, s.googleCseKey, s.googleCseCx);
      if (urls.length) { log(`Google CSE: ${urls.length} image results`); return { imageUrls: urls, provider: 'google', warnings }; }
      warnings.push('google_cse_no_results');
    } catch (e: any) { warnings.push(`google_cse_failed: ${String(e?.message).slice(0, 80)}`); }
  }

  // 2) Firecrawl search → scrape top result pages → harvest images
  if (s.firecrawlKey) {
    try {
      const urls = await firecrawlSearchImages(q, s.firecrawlKey, log);
      if (urls.length) { log(`Firecrawl search: ${urls.length} images from result pages`); return { imageUrls: urls, provider: 'firecrawl', warnings }; }
      warnings.push('firecrawl_search_no_images');
    } catch (e: any) { warnings.push(`firecrawl_search_failed: ${String(e?.message).slice(0, 80)}`); }
  }

  warnings.push('no_search_provider — add a Google CSE key (key+cx) or a Firecrawl key in Settings');
  return { imageUrls: [], provider: 'none', warnings };
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
