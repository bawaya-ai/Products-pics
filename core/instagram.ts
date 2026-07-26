// ── Instagram: public post/reel media extraction ────────────────────────────
// Fetch ladder per post (cheapest first): direct fetch → /embed/captioned (usually
// served without login) → Firecrawl render (last resort, costs a credit).
// Harvests display_url images AND reel videos (video_url / video_versions[0]) from
// the embedded JSON, plus the caption (og:title) so the AI curation can judge
// relevance. Every fetch passes the SSRF guard; only Instagram-CDN media survives.

import type { Settings } from './settings';
import { collectImageUrls, assertPublicUrl } from './extract';

export const IG_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface IgMedia {
  images: string[];
  videos: { url: string; poster?: string }[];
  caption?: string;
}

/** STRICT host check (parsed hostname — `evil.tld/instagram.com/p/x` must fail) + post paths. */
export function isIgPostUrl(u: string): boolean {
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:') return false;
    if (p.hostname !== 'instagram.com' && !p.hostname.endsWith('.instagram.com')) return false;
    return /^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\//.test(p.pathname);
  } catch { return false; }
}

/** Media of ONE public post/reel. Escalates: direct fetch → embed page → Firecrawl. */
export async function igPostMedia(postUrl: string, s: Settings): Promise<IgMedia> {
  const plainHtml = async (u: string): Promise<string> => {
    try {
      assertPublicUrl(u); // every externally-sourced URL passes the SSRF guard before fetch
      const r = await fetch(u, {
        headers: { 'User-Agent': IG_UA, Accept: 'text/html,*/*', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(10000),
      });
      return r.ok ? await r.text() : '';
    } catch { return ''; }
  };
  let media = igHarvest(await plainHtml(postUrl), postUrl);
  if (!media.images.length && !media.videos.length) {
    media = igHarvest(await plainHtml(postUrl.replace(/\/+$/, '') + '/embed/captioned/'), postUrl);
  }
  if (!media.images.length && !media.videos.length && s.firecrawlKey) {
    try {
      const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.firecrawlKey}` },
        body: JSON.stringify({ url: postUrl, formats: ['html'], waitFor: 2500, timeout: 20000 }),
        signal: AbortSignal.timeout(25000),
      });
      if (r.ok) { const d = (await r.json()) as any; media = igHarvest(d?.data?.html || d?.data?.rawHtml || '', postUrl); }
    } catch { /* post stays empty */ }
  }
  return media;
}

/** Harvest Instagram-CDN media from post HTML (og tags, <img>, embedded JSON). */
function igHarvest(html: string, base: string): IgMedia {
  const out: IgMedia = { images: [], videos: [] };
  if (!html) return out;
  // un-escape JSON blobs so display_url / video_url / signed query strings survive intact
  const clean = html.replace(/\\u0026/gi, '&').replace(/\\\//g, '/');
  const isIgCdn = (u: string) => /(?:cdninstagram|fbcdn)\./i.test(u) && !/s150x150|profile_pic/i.test(u);

  const imgs = new Set<string>();
  for (const m of clean.matchAll(/"(?:display_url|display_src|thumbnail_src)"\s*:\s*"(https:[^"\\]+)"/g)) imgs.add(m[1]);
  for (const u of collectImageUrls(clean, base, 10)) imgs.add(u);
  out.images = [...imgs].filter(isIgCdn);

  // reels: video_url, or video_versions[0].url (IG lists highest quality first)
  const vids = new Set<string>();
  for (const m of clean.matchAll(/"video_url"\s*:\s*"(https:[^"\\]+)"/g)) vids.add(m[1]);
  for (const m of clean.matchAll(/"video_versions"\s*:\s*\[\s*\{[^\]]*?"url"\s*:\s*"(https:[^"\\]+)"/g)) vids.add(m[1]);
  for (const m of clean.matchAll(/<meta[^>]+property=["']og:video(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/gi)) vids.add(m[1]);
  const poster = out.images[0];
  out.videos = [...vids].filter(isIgCdn).map((url) => ({ url, poster }));

  // caption via og:title ('User on Instagram: "…"') — fed to the AI as UNTRUSTED context
  const cap = clean.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{5,300})/i)?.[1];
  if (cap) out.caption = cap;
  return out;
}
