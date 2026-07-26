// ── Web image search — find product images by a text query ─────────────────
// Two providers, best-first:
//   google  → Google Programmable Search (Custom Search JSON API) in IMAGE mode.
//             Returns direct image URLs — cleanest. Free up to 100 queries/day.
//   firecrawl → Firecrawl /search with html scrape of the top results, then
//             harvest product images from those pages. No image API needed.
//   instagram → OPTIONAL extra source (OFF by default, toggled per-search):
//             find public posts via Firecrawl search scoped to instagram.com,
//             then harvest each post's CDN images. Unioned into the result.
// Copyright note: general web images are of unknown provenance — the UI warns.

import type { Settings } from './settings';
import { collectImageUrls, fetchImage, assertPublicUrl } from './extract';
import { discoverySearch } from './discovery';
import { igPostMedia, isIgPostUrl, IG_UA } from './instagram';
import sharp from 'sharp';

export interface WebSearchResult {
  imageUrls: string[];
  provider: string;
  warnings: string[];
  /** reel/post videos from the optional Instagram source */
  videos?: { url: string; poster?: string }[];
  /** post captions (UNTRUSTED) — extra context for the AI curation */
  igCaptions?: string[];
}
interface IgAgg { images: string[]; videos: { url: string; poster?: string }[]; captions: string[] }
export interface ProductSearchResult { urls: string[]; provider: string; warnings: string[] }

// bare host from a domain/url (for `site:` scoping)
function bareSite(input: string): string {
  return input.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '');
}

// warm-lambda search cache (1h): the same query re-run must not re-bill every provider
const searchCache = new Map<string, { at: number; res: WebSearchResult }>();
const SEARCH_CACHE_TTL = 60 * 60 * 1000;

/** SPECIFIC-PRODUCT search: a query (product name) → best candidate image URLs. Honors searchProvider. */
export async function searchImages(
  query: string,
  s: Settings,
  log: (m: string) => void,
): Promise<WebSearchResult> {
  const cacheKey = `${s.searchProvider || 'auto'}|${s.instagramSearch ? 1 : 0}|${query.trim().toLowerCase().slice(0, 200)}`;
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL) {
    log('نتيجة البحث من الكاش (ساعة) — بدون أي تكلفة مزوّدين');
    return hit.res;
  }
  const res = await searchImagesUncached(query, s, log);
  if (res.imageUrls.length) {
    searchCache.set(cacheKey, { at: Date.now(), res });
    if (searchCache.size > 50) { const oldest = searchCache.keys().next().value; if (oldest) searchCache.delete(oldest); }
  }
  return res;
}

async function searchImagesUncached(
  query: string,
  s: Settings,
  log: (m: string) => void,
): Promise<WebSearchResult> {
  const warnings: string[] = [];
  const q = query.trim().slice(0, 200);
  const provider = s.searchProvider || 'auto';

  // Instagram — optional EXTRA source (OFF by default). Runs in parallel with whichever
  // provider answers below; withIg() unions its media into the returned result.
  const EMPTY_IG: IgAgg = { images: [], videos: [], captions: [] };
  let igTimer: ReturnType<typeof setTimeout> | undefined;
  const igTask: Promise<IgAgg> | null = s.instagramSearch
    ? Promise.race([
        instagramMedia(q, s, log).catch((e) => { warnings.push(`instagram_failed: ${String(e?.message).slice(0, 80)}`); return EMPTY_IG; }),
        new Promise<IgAgg>((resolve) => { igTimer = setTimeout(() => { warnings.push('instagram_timeout — كمّلنا بدون انستجرام'); resolve(EMPTY_IG); }, 30000); }),
      ]).then((r) => { if (igTimer) clearTimeout(igTimer); return r; }) // no stray timer, no post-response warning writes
    : null;
  const withIg = async (r: WebSearchResult): Promise<WebSearchResult> => {
    if (!igTask) return r;
    const ig = await igTask;
    if (!ig.images.length && !ig.videos.length) return r;
    const merged = [...new Set([...r.imageUrls, ...ig.images])];
    log(`Instagram: +${ig.images.length} صورة${ig.videos.length ? ` +${ig.videos.length} فيديو` : ''} من بوستات عامة`);
    return {
      ...r,
      imageUrls: merged,
      provider: r.imageUrls.length ? `${r.provider}+instagram` : 'instagram',
      videos: [...(r.videos || []), ...ig.videos],
      igCaptions: ig.captions.slice(0, 4),
    };
  };

  // 0) Google Vertex AI Search (Discovery Engine) — the WORKING Google product search.
  //    Discovery finds product PAGES; Firecrawl scrapes the top ones for high-res images
  //    (best-effort pagemap images as fallback). See discoveryImages().
  //    QUALITY GATE: an early return of nothing but low-res gstatic thumbnails would
  //    skip better providers — keep those only as a last-resort fallback.
  let weakDiscovery: string[] = [];
  if ((provider === 'auto' || provider === 'discovery') && s.googleSaKey) {
    try {
      const imgs = await discoveryImages(q, s, log);
      const strong = imgs.filter((u) => !/gstatic\.com|googleusercontent\.com|encrypted-tbn/i.test(u));
      if (strong.length >= 3) { log(`Discovery: ${imgs.length} candidate images`); return withIg({ imageUrls: imgs, provider: 'discovery', warnings }); }
      if (imgs.length) { weakDiscovery = imgs; log(`Discovery: only ${imgs.length} low-res thumbnails — continuing the provider ladder`); }
      else warnings.push('discovery_no_images');
    } catch (e: any) { warnings.push(`discovery_failed: ${String(e?.message).slice(0, 80)}`); }
  }

  // MERGE: run Discovery AND Firecrawl INDEPENDENTLY (in parallel) and union all candidate
  //        images — maximum coverage; the resolution filter + AI curation pick the best.
  if (provider === 'merge') {
    const tasks: Promise<string[]>[] = [];
    if (s.googleSaKey) tasks.push(discoveryImages(q, s, log).catch((e) => { warnings.push(`discovery_failed: ${String(e?.message).slice(0, 60)}`); return []; }));
    if (s.firecrawlKey) tasks.push(firecrawlSearchImages(q, s.firecrawlKey, log).catch((e) => { warnings.push(`firecrawl_failed: ${String(e?.message).slice(0, 60)}`); return []; }));
    const merged = [...new Set((await Promise.all(tasks)).flat())];
    if (merged.length) { log(`Merge: ${merged.length} images from ${tasks.length} provider(s)`); return withIg({ imageUrls: merged, provider: 'merge', warnings }); }
    warnings.push('merge_no_images');
  }

  // 1) Google CSE image search (direct image URLs) — unless the user forced Firecrawl
  if ((provider === 'auto' || provider === 'google') && s.googleCseKey && s.googleCseCx) {
    try {
      const urls = await googleImageSearch(q, s.googleCseKey, s.googleCseCx);
      if (urls.length) { log(`Google CSE: ${urls.length} image results`); return withIg({ imageUrls: urls, provider: 'google', warnings }); }
      warnings.push('google_cse_no_results');
    } catch (e: any) { warnings.push(`google_cse_failed: ${String(e?.message).slice(0, 80)}`); }
  }

  // 2) Firecrawl search → scrape top result pages → harvest images
  if ((provider === 'auto' || provider === 'firecrawl') && s.firecrawlKey) {
    try {
      const urls = await firecrawlSearchImages(q, s.firecrawlKey, log);
      if (urls.length) { log(`Firecrawl search: ${urls.length} images from result pages`); return withIg({ imageUrls: urls, provider: 'firecrawl', warnings }); }
      warnings.push('firecrawl_search_no_images');
    } catch (e: any) { warnings.push(`firecrawl_search_failed: ${String(e?.message).slice(0, 80)}`); }
  }

  // Better providers came up empty — the weak (thumbnail-only) Discovery set is still
  // better than nothing; the resolution filter + AI curation downstream will judge it.
  if (weakDiscovery.length) {
    log(`falling back to ${weakDiscovery.length} low-res Discovery images`);
    return withIg({ imageUrls: weakDiscovery, provider: 'discovery', warnings });
  }

  // No provider produced images — Instagram (if enabled) may still have some.
  const igOnly = await withIg({ imageUrls: [], provider: 'none', warnings });
  if (igOnly.imageUrls.length) return igOnly;
  warnings.push(
    provider === 'discovery' ? 'discovery_only_but_no_results — Google Vertex ما رجّع صور؛ تأكد من مفتاح الخدمة أو جرّب Firecrawl'
    : provider === 'merge' ? 'merge_no_results — الاثنين ما رجّعوا صور؛ تأكد من المفاتيح'
    : provider === 'google' ? 'google_cse_only_but_unavailable — Google CSE محجوب، غيّر المزوّد لـ Firecrawl أو Google (Vertex)'
    : 'no_search_provider — أضف مفتاح Firecrawl أو Google (Vertex) بالإعدادات');
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
  const provider = s.searchProvider || 'auto';

  // Discovery Engine returns product PAGE urls directly, with `site:` scoping baked into the query.
  if ((provider === 'auto' || provider === 'discovery' || provider === 'merge') && s.googleSaKey) {
    try {
      const dr = await discoverySearch(query, { pageSize: cap, site }, s, log);
      if (dr.pageUrls.length) { log(`Discovery: ${dr.pageUrls.length} product pages for "${query}"`); return { urls: dr.pageUrls.slice(0, cap), provider: 'discovery', warnings }; }
      warnings.push('discovery_no_pages');
    } catch (e: any) { warnings.push(`discovery_failed: ${String(e?.message).slice(0, 80)}`); }
  }

  let q = query.trim().slice(0, 200);
  if (site && site.trim()) q = `${q} site:${bareSite(site)}`;
  if (!s.firecrawlKey) { warnings.push('no_search_provider — بحث الفئات يحتاج Firecrawl أو Google (Vertex)'); return { urls: [], provider: 'none', warnings }; }
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

/** Discovery finds product pages; Firecrawl scrapes the top ones for high-res images
 *  (Discovery's own best-effort pagemap images are added as fallback candidates). */
async function discoveryImages(q: string, s: Settings, log: (m: string) => void): Promise<string[]> {
  const dr = await discoverySearch(q, { pageSize: 10 }, s, log);
  let scraped: string[] = [];
  if (s.firecrawlKey && dr.pageUrls.length) scraped = await firecrawlScrapeUrlsImages(dr.pageUrls, s.firecrawlKey, log);
  return [...new Set([...scraped, ...dr.imageUrls])];
}

/** Scrape a few specific product pages (from Discovery) via Firecrawl → harvest high-res images. */
async function firecrawlScrapeUrlsImages(urls: string[], key: string, log: (m: string) => void): Promise<string[]> {
  const top = urls.slice(0, 3);
  const harvested: string[] = [];
  await Promise.all(top.map(async (u) => {
    try {
      const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ url: u, formats: ['html'] }),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) return;
      const d = (await r.json()) as any;
      const html: string = d?.data?.html || d?.data?.rawHtml || '';
      if (html) harvested.push(...collectImageUrls(html, u, 6));
    } catch { /* skip this page */ }
  }));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of harvested) { const b = u.split('?')[0]; if (!seen.has(b)) { seen.add(b); out.push(u); } }
  log(`firecrawl scraped ${top.length} discovery pages → ${out.length} images`);
  return out.slice(0, 14);
}

// ── Instagram (optional extra source — OFF by default) ─────────────────────
// Post/reel URLs via Firecrawl search scoped to site:instagram.com; per-post media
// extraction lives in core/instagram.ts (direct fetch → embed → Firecrawl ladder).

async function instagramMedia(q: string, s: Settings, log: (m: string) => void): Promise<IgAgg> {
  if (!s.firecrawlKey) throw new Error('بحث انستجرام يحتاج مفتاح Firecrawl');
  const r = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.firecrawlKey}` },
    body: JSON.stringify({ query: `${q} site:instagram.com`, limit: 8 }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`search ${r.status}: ${(await r.text()).slice(0, 80)}`);
  const d = (await r.json()) as any;
  // isIgPostUrl = STRICT parsed-hostname check — search results are untrusted input
  const posts = [...new Set(((d.data || []) as any[])
    .map((x) => String(x?.url || x?.metadata?.sourceURL || ''))
    .filter(isIgPostUrl)
    .map((u) => u.split('?')[0]))].slice(0, 4);
  if (!posts.length) { log('Instagram: ما لقيت بوستات عامة للبحث'); return { images: [], videos: [], captions: [] }; }
  const all = await Promise.all(posts.map((p) => igPostMedia(p, s).catch(() => ({ images: [], videos: [] } as { images: string[]; videos: { url: string; poster?: string }[]; caption?: string }))));
  const images = [...new Set(all.flatMap((m) => m.images))].slice(0, 12);
  const videos = all.flatMap((m) => m.videos).slice(0, 4);
  const captions = all.map((m) => m.caption).filter((c): c is string => Boolean(c));
  log(`Instagram: ${posts.length} بوست → ${images.length} صورة، ${videos.length} فيديو`);
  return { images, videos, captions };
}

/** Verify a URL is a fetchable, non-tiny image (cheap pre-filter before the pool).
 *  Range-probes the first 64KB — jpeg/png/webp dimensions live in the header, so there
 *  is no reason to download up to 15MB just to measure a candidate. */
export async function isUsableImage(url: string): Promise<boolean> {
  try {
    assertPublicUrl(url);
    const r = await fetch(url, {
      headers: { Range: 'bytes=0-65535', 'User-Agent': IG_UA, Accept: 'image/*,*/*' },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok || r.status === 206) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength >= 500) {
        const m = await sharp(buf).metadata();
        return (m.width ?? 0) >= 200 && (m.height ?? 0) >= 200;
      }
    }
  } catch { /* header probe failed (exotic format / picky server) — fall through */ }
  const got = await fetchImage(url);
  if (!got) return false;
  try {
    const m = await sharp(got.buf).metadata();
    return (m.width ?? 0) >= 200 && (m.height ?? 0) >= 200;
  } catch { return false; }
}
