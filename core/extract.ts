// ── Extraction: page URL -> candidate media URLs + page context ────────────
// Sources, in priority order:
//   0. image links embedded in the page URL's own query params (Temu top_gallery_url)
//   1. og:image / twitter:image
//   2. <img src|data-src|data-lazy|data-original> + srcset
//   3. image URLs inside inline JSON/scripts (Temu/AliExpress galleries)
//   4. optional Firecrawl rendered fetch (JS-heavy pages) when a key is set

import type { Settings } from './settings';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const IMG_RE = /https?:\/\/[^\s"'\\<>()]+?\.(?:jpg|jpeg|png|webp|avif)(?:\?[^\s"'\\<>()]*)?/gi;
const JUNK =
  /(sprite|icon|logo|favicon|placeholder|avatar|flag|emoji|loading|blank|1x1|pixel|\/ui\/|\/static\/|badge|rating|star|captcha|qrcode|payment|visa|mastercard|paypal)/i;

export interface Extraction {
  imageUrls: string[];
  pageTitle: string;
  pageText: string;   // trimmed visible-ish text for AI enrichment
  usedFirecrawl: boolean;
  warnings: string[];
}

function decode(u: string): string {
  return u.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\"/g, '');
}
function baseKey(u: string): string {
  return u.split('?')[0].replace(/(_\d{2,4}x\d{2,4}|-\d{2,4}x\d{2,4}|_\d{2,4}w)?\.(jpg|jpeg|png|webp|avif)$/i, '');
}

// ── SSRF guard: refuse private/internal targets unless explicitly allowed ──
export function assertPublicUrl(raw: string): URL {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http/https URLs allowed');
  if (process.env.SCRAPER_ALLOW_PRIVATE === '1') return u;
  const h = u.hostname.toLowerCase();
  if (
    h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '0.0.0.0' || h === '[::1]' || h === '169.254.169.254'
  ) throw new Error('private/internal hosts are not allowed');
  return u;
}

function harvest(html: string, add: (u: string) => void) {
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]+content=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<img[^>]+(?:src|data-src|data-lazy|data-original)=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/srcset=["']([^"']+)["']/gi)) for (const part of m[1].split(',')) add(part.trim().split(/\s+/)[0]);
  for (const m of html.matchAll(IMG_RE)) add(m[0]);
}

function pageTextFrom(html: string): { title: string; text: string } {
  const title =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<title[^>]*>([^<]{2,200})<\/title>/i)?.[1] || '';
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3500);
  return { title: title.trim(), text };
}

async function firecrawlHtml(pageUrl: string, key: string): Promise<string | null> {
  try {
    const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url: pageUrl, formats: ['html'], waitFor: 3500, timeout: 30000 }),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as any;
    return d?.data?.html || d?.html || null;
  } catch { return null; }
}

export async function extractMedia(
  pageUrl: string,
  s: Settings,
  log: (m: string) => void,
): Promise<Extraction> {
  const warnings: string[] = [];
  const found = new Map<string, string>();
  const ordered: string[] = [];
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const u = decode(raw);
    if (!/^https?:\/\//i.test(u) || JUNK.test(u)) return;
    const b = baseKey(u);
    const prev = found.get(b);
    if (!prev) { found.set(b, u); ordered.push(b); }
    else if (u.length > prev.length) found.set(b, u);
  };

  const target = assertPublicUrl(pageUrl);

  // 0) URL-param embedded images (Temu carries the main gallery image here)
  for (const [, v] of target.searchParams) {
    let dec = v; try { dec = decodeURIComponent(v); } catch {}
    for (const m of dec.matchAll(IMG_RE)) add(m[0]);
  }
  if (ordered.length) log(`URL-param images: ${ordered.length}`);

  // 1-3) plain fetch of the page
  let html = '';
  try {
    const res = await fetch(target.href, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en,ar;q=0.8' },
      signal: AbortSignal.timeout(20000),
    });
    html = await res.text();
    log(`page fetch: HTTP ${res.status} (${Math.round(html.length / 1024)}KB)`);
  } catch (e: any) {
    warnings.push(`page fetch failed: ${e?.message}`);
  }
  if (html) harvest(html, add);

  // 4) Firecrawl rendered fetch when page is JS-heavy and a key exists
  let usedFirecrawl = false;
  if (found.size < 3 && s.firecrawlKey) {
    log('few images in raw HTML — trying Firecrawl rendered fetch…');
    const rendered = await firecrawlHtml(target.href, s.firecrawlKey);
    if (rendered) { usedFirecrawl = true; harvest(rendered, add); if (!html) html = rendered; }
    else warnings.push('firecrawl fetch failed');
  } else if (found.size < 2 && !s.firecrawlKey) {
    warnings.push('JS-rendered page and no FIRECRAWL key — only URL-param/OG images available');
  }

  const { title, text } = pageTextFrom(html);
  const imageUrls = ordered.map((b) => found.get(b)!).slice(0, s.maxImages);
  log(`candidates: ${found.size}, keeping ${imageUrls.length}`);
  return { imageUrls, pageTitle: title, pageText: text, usedFirecrawl, warnings };
}

/** Fetch one image with safety caps. Returns null on failure. */
export async function fetchImage(url: string): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    assertPublicUrl(url);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ct.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 1000 || buf.byteLength > 15 * 1024 * 1024) return null;
    return { buf, contentType: ct };
  } catch { return null; }
}
