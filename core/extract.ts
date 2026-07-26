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
// protocol optional: catches both https://… and protocol-relative //host/…img.jpg
// (Samsung & many sites put gallery URLs as "image":"//images.samsung.com/…jpg" in inline JSON).
// add() normalizes a leading // to https:.
const IMG_RE = /(?:https?:)?\/\/[^\s"'\\<>()]+?\.(?:jpg|jpeg|png|webp|avif)(?:\?[^\s"'\\<>()]*)?/gi;
// only progressive formats a bare <video src> can play natively (no HLS/QuickTime)
const VID_RE = /(?:https?:)?\/\/[^\s"'\\<>()]+?\.(?:mp4|webm)(?:\?[^\s"'\\<>()]*)?/gi;
const JUNK =
  /(sprite|icon|logo|favicon|placeholder|avatar|flag|emoji|loading|blank|1x1|pixel|\/ui\/|\/static\/|badge|rating|star|captcha|qrcode|payment|visa|mastercard|paypal|\/wiki\/|[?&/]file:|\.html\b)/i;

export interface Extraction {
  imageUrls: string[];
  videoUrls: string[];
  pageTitle: string;
  pageText: string;   // trimmed visible-ish text for AI enrichment
  usedFirecrawl: boolean;
  warnings: string[];
  /** authoritative price from JSON-LD Product/Offer markup (when present) */
  ldPrice?: { amount: number; currency: string };
  /** video candidates with provenance + poster (videoUrls kept as the flat legacy view) */
  videos: { url: string; poster?: string; source: 'og' | 'tag' | 'json' | 'raw' | 'instagram' }[];
}

function decode(u: string): string {
  // & matters: Instagram/JSON-embedded SIGNED urls carry escaped `&` between query
  // params — without unescaping, the signature params are lost and the url 403s
  return u.replace(/\\u002F/gi, '/').replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\"/g, '');
}

// AliExpress/Alibaba CDN (alicdn.com, aliexpress-media.com) serves every product photo
// under /kf/<hash> at whatever resolution the URL asks for — but AliExpress's newer
// client-side-rendered PDP only leaks THUMBNAIL urls into the raw (pre-JS) HTML, e.g.
//   kf/<hash>/-.jpg_80x80.jpg          (list/related-item thumbnail shape)
//   kf/<hash>.jpg_220x220q75.jpg       (gallery-strip thumbnail shape)
// Stripping the resize suffix back to the bare kf/<hash>.jpg returns the FULL-resolution
// original (verified live: 80x80 icons → 100-500KB real photos) — no JS render needed.
function upgradeAliExpressImage(u: string): string {
  try {
    const p = new URL(u);
    if (!/(?:^|\.)alicdn\.com$/i.test(p.hostname) && !/(?:^|\.)aliexpress-media\.com$/i.test(p.hostname)) return u;
    if (!/\/kf\//i.test(p.pathname)) return u;
    let path = p.pathname
      .replace(/\/-\.(jpg|jpeg|png|webp)_\d{2,4}x\d{2,4}(?:q\d{1,3})?\.(?:jpg|jpeg|png|webp)$/i, '.$1')
      .replace(/(\.(?:jpg|jpeg|png|webp))_\d{2,4}x\d{2,4}(?:q\d{1,3})?\.(?:jpg|jpeg|png|webp)$/i, '$1');
    if (path === p.pathname) return u; // no known thumbnail suffix — leave untouched
    p.pathname = path;
    p.search = '';
    return p.href;
  } catch { return u; }
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

// Product videos: og:video, <video>/<source> (extension NOT required when the tag itself
// declares video — Cloudinary/Mux-style urls are extensionless), JSON video fields, and
// raw .mp4/.webm URLs. HLS (.m3u8) is detection-only: no ffmpeg in this stack to remux it.
export type VideoSource = 'og' | 'tag' | 'json' | 'raw';
function harvestVideos(html: string, add: (u: string, source: VideoSource) => void) {
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["']og:video(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/gi)) add(m[1], 'og');
  for (const m of html.matchAll(/<video[^>]+(?:src|data-src)=["']([^"']+)["']/gi)) add(m[1], 'tag');
  for (const m of html.matchAll(/<source[^>]+src=["']([^"']+)["'][^>]*type=["']video\//gi)) add(m[1], 'tag');
  for (const m of html.matchAll(/<source[^>]+src=["']([^"']+\.(?:mp4|webm)[^"']*)["']/gi)) add(m[1], 'tag');
  for (const m of html.matchAll(/["'](?:video_?url|videoUrl|hdVideoUrl|mp4Url|videoUrlHigh)["']\s*:\s*["']([^"']+)["']/gi)) add(m[1], 'json');
  for (const m of html.matchAll(VID_RE)) add(m[0], 'raw');
}
/** True when the page carries an HLS stream (we can't store those — warn, don't fail). */
function hasHls(html: string): boolean { return /\.m3u8\b/i.test(html); }

/** Standalone image-URL harvester (used by web-search result pages). Resolves
 *  relative/protocol-relative URLs against baseHref, drops junk, dedupes by base. */
export function collectImageUrls(html: string, baseHref: string, limit = 12): string[] {
  const found = new Map<string, string>();
  const order: string[] = [];
  const add = (raw?: string) => {
    if (!raw) return;
    let u = decode(raw).trim();
    if (u.startsWith('//')) u = 'https:' + u;
    else if (!/^https?:\/\//i.test(u)) { try { u = new URL(u, baseHref).href; } catch { return; } }
    if (!/^https?:\/\//i.test(u) || JUNK.test(u)) return;
    u = upgradeAliExpressImage(u);
    const b = baseKey(u);
    if (!found.has(b)) { found.set(b, u); order.push(b); }
    else if (u.length > found.get(b)!.length) found.set(b, u);
  };
  harvest(html, add);
  return order.map((b) => found.get(b)!).slice(0, limit);
}

/** Parse application/ld+json Product/Offer blocks — the authoritative structured source
 *  (present on virtually every Shopify/Woo store): official image array + price/currency. */
export function parseJsonLd(html: string): { images: string[]; price?: { amount: number; currency: string }; title?: string } {
  const out: { images: string[]; price?: { amount: number; currency: string }; title?: string } = { images: [] };
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const nodes: any[] = [];
      const push = (x: any) => { if (!x) return; if (Array.isArray(x)) x.forEach(push); else { nodes.push(x); if (x['@graph']) push(x['@graph']); } };
      push(JSON.parse(m[1].trim()));
      for (const n of nodes) {
        if (!/Product/i.test(String(n['@type'] || ''))) continue;
        if (!out.title && typeof n.name === 'string') out.title = n.name.slice(0, 200);
        const imgs = n.image;
        if (typeof imgs === 'string') out.images.push(imgs);
        else if (Array.isArray(imgs)) for (const i of imgs) { if (typeof i === 'string') out.images.push(i); else if (i?.url) out.images.push(String(i.url)); }
        else if (imgs?.url) out.images.push(String(imgs.url));
        const offers = Array.isArray(n.offers) ? n.offers[0] : n.offers;
        if (!out.price && offers) {
          const amt = parseFloat(String(offers.price ?? offers.lowPrice ?? ''));
          const cur = String(offers.priceCurrency || '').trim();
          if (Number.isFinite(amt) && amt > 0 && cur) out.price = { amount: amt, currency: cur.slice(0, 8) };
        }
      }
    } catch { /* malformed block — skip */ }
  }
  return out;
}

/** Pull likely price strings from HTML: currency symbols, JSON price fields, meta tags. */
function extractPriceCandidates(html: string): string[] {
  const found = new Map<string, number>();
  const bump = (v: string) => found.set(v, (found.get(v) || 0) + 1);
  // currency symbol/code + amount (both orders) — incl. Asia/Gulf currencies this
  // scraper's actual sources (Temu/AliExpress/Gulf shops) price in
  for (const m of html.matchAll(/(?:USD|EUR|GBP|ILS|NIS|SAR|AED|CNY|JPY|TRY|₪|\$|£|€|¥|₺|ر\.س|د\.إ)\s?\d{1,5}(?:[.,]\d{2})?|\d{1,5}(?:[.,]\d{2})?\s?(?:USD|EUR|GBP|ILS|NIS|SAR|AED|CNY|JPY|TRY|₪|\$|£|€|¥|₺|ر\.س|د\.إ)/gi)) bump(m[0].replace(/\s+/g, ''));
  // JSON price fields + itemprop/meta price
  for (const m of html.matchAll(/"(?:price|amount|current_?price|sale_?price)"\s*:\s*"?(\d{1,6}(?:\.\d{2})?)"?/gi)) bump(m[1]);
  for (const m of html.matchAll(/itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/gi)) bump(m[1]);
  for (const m of html.matchAll(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([\d.,]+)["']/gi)) bump(m[1]);
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v).slice(0, 6);
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
    let u = decode(raw).trim();
    if (u.startsWith('//')) u = 'https:' + u;                 // protocol-relative → https
    else if (!/^https?:\/\//i.test(u)) {
      try { u = new URL(u, target.href).href; } catch { return; } // relative → absolute (against page URL)
    }
    if (!/^https?:\/\//i.test(u) || JUNK.test(u)) return;
    u = upgradeAliExpressImage(u);
    const b = baseKey(u);
    const prev = found.get(b);
    if (!prev) { found.set(b, u); ordered.push(b); }
    else if (u.length > prev.length) found.set(b, u);
  };

  const videos = new Map<string, { url: string; source: VideoSource | 'instagram' }>();
  const vOrder: string[] = [];
  const vPoster = new Map<string, string>(); // base-url → poster (Instagram carries its own)
  const addV = (raw: string | undefined, source: VideoSource | 'instagram' = 'raw') => {
    if (!raw) return;
    let u = decode(raw).trim();
    if (u.startsWith('//')) u = 'https:' + u;
    else if (!/^https?:\/\//i.test(u)) { try { u = new URL(u, target.href).href; } catch { return; } }
    if (!/^https?:\/\//i.test(u) || JUNK.test(u)) return; // skip ad/banner/sprite/logo clips
    if (/\.m3u8(\?|$)/i.test(u)) return;                  // HLS — detection-only (warned below)
    const b = u.split('?')[0];
    if (!videos.has(b)) { videos.set(b, { url: u, source }); vOrder.push(b); }
  };

  const target = assertPublicUrl(pageUrl);

  // Instagram post/reel pasted directly: the generic fetch hits a login wall — use the
  // dedicated ladder (direct → embed → Firecrawl) and take its media as first-class.
  const ig = await import('./instagram');
  if (ig.isIgPostUrl(target.href)) {
    const media = await ig.igPostMedia(target.href, s);
    media.images.forEach(add);
    for (const v of media.videos) {
      addV(v.url, 'instagram');
      if (v.poster) vPoster.set(v.url.split('?')[0], v.poster);
    }
    if (media.images.length || media.videos.length) log(`Instagram post: ${media.images.length} images, ${media.videos.length} videos`);
  }

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
    // bot-wall detection: a 403/429/503, or a small page carrying challenge markers, is
    // NOT product data — discard it so the Firecrawl escalation below actually fires
    const botWall = !res.ok || (html.length < 15000 && /captcha|punish|verify (?:you are|that you'?re) human|just a moment/i.test(html));
    log(`page fetch: HTTP ${res.status} (${Math.round(html.length / 1024)}KB)${botWall ? ' — bot wall suspected' : ''}`);
    if (botWall) { warnings.push(`bot_wall_http_${res.status} — صفحة تحقق مش منتج؛ جرّبنا Firecrawl`); html = ''; }
  } catch (e: any) {
    warnings.push(`page fetch failed: ${e?.message}`);
  }

  // JSON-LD Product markup FIRST — its image array is the official product gallery
  let ld = html ? parseJsonLd(html) : { images: [] as string[] };
  ld.images.forEach(add);
  if (ld.images.length) log(`JSON-LD: ${ld.images.length} official gallery images${ld.price ? ` · price ${ld.price.amount} ${ld.price.currency}` : ''}`);

  if (html) { harvest(html, add); harvestVideos(html, addV); }

  // 4) Firecrawl rendered fetch when page is JS-heavy/bot-walled and a key exists
  let usedFirecrawl = false;
  if (found.size < 3 && s.firecrawlKey) {
    log('few images in raw HTML — trying Firecrawl rendered fetch…');
    const rendered = await firecrawlHtml(target.href, s.firecrawlKey);
    if (rendered) {
      usedFirecrawl = true;
      const ld2 = parseJsonLd(rendered);
      ld2.images.forEach(add);
      if (!ld.price && ld2.price) ld = { ...ld, price: ld2.price };
      harvest(rendered, add); harvestVideos(rendered, addV);
      if (!html) html = rendered;
    }
    else warnings.push('firecrawl fetch failed');
  } else if (found.size < 2 && !s.firecrawlKey) {
    warnings.push('JS-rendered page and no FIRECRAWL key — only URL-param/OG images available');
  }

  const { title, text } = pageTextFrom(html);
  const prices = extractPriceCandidates(html);
  const pageText = (prices.length ? `PRICE CANDIDATES: ${prices.join(', ')}\n` : '') + text;
  // Return a POOL of candidates (bigger than maxImages) so the selection step can
  // rank by real resolution + AI quality and drop junk/dupes before processing.
  const poolSize = Math.min(28, Math.max(s.maxImages * 3, 14));
  const imageUrls = ordered.map((b) => found.get(b)!).slice(0, poolSize);
  // page-level poster fallback: og:image or an explicit <video poster="…">
  const posterFallback =
    html.match(/<meta[^>]+property=["']og:image[^>]*content=["']([^"']+)/i)?.[1] ||
    html.match(/<video[^>]+poster=["']([^"']+)["']/i)?.[1] || undefined;
  const videosOut = vOrder.slice(0, 6).map((b) => {
    const v = videos.get(b)!;
    return { url: v.url, source: v.source, poster: vPoster.get(b) || posterFallback };
  });
  if (!videosOut.length && html && hasHls(html)) {
    warnings.push('hls_only_video — الصفحة فيها فيديو ستريمنغ (HLS) وهاد النوع ما مننزّله؛ ما لقينا نسخة mp4');
  }
  const videoUrls = videosOut.slice(0, 3).map((v) => v.url);
  log(`candidates: ${found.size}, pool: ${imageUrls.length}${videosOut.length ? `, videos: ${videosOut.length}` : ''}${prices.length ? `, prices: ${prices.slice(0, 3).join('/')}` : ''}`);
  return { imageUrls, videoUrls, videos: videosOut, pageTitle: title || ld.title || '', pageText, usedFirecrawl, warnings, ldPrice: ld.price };
}

// ── Product-link discovery (for listing/category/bestsellers pages) ─────────
const LINK_JUNK =
  /(\/(about|affiliate|contact|policy|information|warranty|labels?|categor|deals?|careers?|press|blog|support|faq|privacy|terms|cookie|sitemap|stores?|company|account|login|register|cart|checkout|wishlist|help|shipping|returns?|gift-?card|newsletter|size-?guide|reviews?)\b|\/(pages?|blogs?|policies|collections)\/|#|javascript:|mailto:|tel:|\.pdf)/i;

/** Extract likely PRODUCT-PAGE urls from a listing page: anchors that wrap a
 *  product image, same-host, minus nav/category/policy links. Generic across stores. */
export function collectProductLinks(html: string, baseHref: string, limit = 24): string[] {
  const bare = (h: string) => h.replace(/^www\./i, '');
  let host = '';
  try { host = bare(new URL(baseHref).host); } catch {}
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    let u = raw.trim();
    if (u.startsWith('//')) u = 'https:' + u;
    else if (!/^https?:\/\//i.test(u)) { try { u = new URL(u, baseHref).href; } catch { return; } }
    let parsed: URL;
    try { parsed = new URL(u); } catch { return; }
    if (host && bare(parsed.host) !== host) return;        // same store only (www-insensitive)
    // Shopify: /collections/<col>/products/<handle> IS a product link — the most common
    // product-link shape on the most common platform. Normalize instead of junk-rejecting.
    const shopify = parsed.pathname.match(/^\/collections\/[^/]+(\/products\/.+)$/i);
    if (shopify) { try { parsed = new URL(parsed.origin + shopify[1] + parsed.search); } catch { return; } }
    if (LINK_JUNK.test(parsed.pathname)) return;
    const path = parsed.pathname.replace(/\/+$/, '');
    if (!path || path === '/' || path.split('/').filter(Boolean).length === 0) return; // homepage/nav
    const key = parsed.origin + path;                      // dedupe ignoring query
    if (seen.has(key)) return;
    seen.add(key); out.push(parsed.origin + parsed.pathname + parsed.search);
  };
  // A) product-card container markers → the first anchor inside (works on Lelo/Shopify/etc.)
  for (const m of html.matchAll(/(?:product[-_]?(?:card|tile|item|thumb|grid-item)|data-test=["']product|itemtype=["'][^"']*Product)[^>]*>[\s\S]{0,500}?<a\b[^>]*href=["']([^"'#\s]+)["']/gi)) add(m[1]);
  // B) anchors that wrap an <img> within a short span
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#\s]+)["'][^>]*>(?:(?!<\/a>)[\s\S]){0,700}?<img\b/gi)) add(m[1]);
  // C) hidden "Go to the … page" product links
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#\s]+)["'][^>]*>\s*(?:go to|view|shop)\b[^<]*\bpage\b/gi)) add(m[1]);
  // D) JSON-embedded product urls (SPA data blobs)
  for (const m of html.matchAll(/"(?:url|handle|productUrl|href|link)"\s*:\s*"((?:https?:\/\/[^"']+|\/)[a-z0-9][a-z0-9\-\/]{2,60})"/gi)) add(m[1]);
  // E) Shopify bare handles in JSON ("handle":"pink-vibe") → /products/<handle>.
  //    Gated on a Shopify signal so we don't invent dead links on other platforms.
  if (/cdn\.shopify|\/products\//i.test(html)) {
    for (const m of html.matchAll(/"handle"\s*:\s*"([a-z0-9][a-z0-9-_]{2,80})"/gi)) add('/products/' + m[1]);
  }
  return out.slice(0, limit);
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
