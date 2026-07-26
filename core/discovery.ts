// ── Google Vertex AI Search (Discovery Engine) provider ────────────────────
// The modern replacement for the (org-blocked, deprecated) Custom Search JSON API.
// A Website (Basic) blended search app over shopping sites. The `:search` response
// returns web results under document.derivedStructData:
//   .link                          → product/listing PAGE url
//   .pagemap.cse_image[0].src      → page's og:image-ish image (best-effort; sometimes a logo)
//   .pagemap.cse_thumbnail[0].src  → Google cached thumbnail (more reliably a real image, lower-res)
// Site scoping is done with a search operator in the query itself (e.g. "site:amazon.com airpods").
// Verified against the live v1 endpoint. Uses v1 (stable), not v1alpha.

import type { Settings } from './settings';
import { getGoogleAccessToken } from './googleauth';

export interface DiscoveryResult { pageUrls: string[]; imageUrls: string[] }

const DEF_PROJECT = '601004755002';
const DEF_ENGINE = 'product-image-search_1785023650361';
const DEF_LOCATION = 'global';

function searchUrl(s: Settings): string {
  const project = (s.discoveryProject || DEF_PROJECT).trim();
  const location = (s.discoveryLocation || DEF_LOCATION).trim();
  const engine = (s.discoveryEngine || DEF_ENGINE).trim();
  return `https://discoveryengine.googleapis.com/v1/projects/${project}/locations/${location}` +
    `/collections/default_collection/engines/${engine}/servingConfigs/default_search:search`;
}

const isHttp = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u);

/** Run a query against the engine. `site` (bare host) scopes via the `site:` operator. */
export async function discoverySearch(
  query: string,
  opts: { pageSize?: number; site?: string },
  s: Settings,
  log: (m: string) => void,
): Promise<DiscoveryResult> {
  if (!s.googleSaKey) throw new Error('no service-account key (add GOOGLE_SA_KEY or set it in the admin panel)');
  const token = await getGoogleAccessToken(s.googleSaKey);
  const site = opts.site?.trim();
  const q = `${site ? `site:${site.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '')} ` : ''}${query}`.trim().slice(0, 400);
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 10, 1), 25);

  const r = await fetch(searchUrl(s), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, pageSize }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`discovery ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const d = (await r.json()) as any;
  const results: any[] = Array.isArray(d.results) ? d.results : [];

  const pageUrls: string[] = [];
  const imageUrls: string[] = [];
  const seenP = new Set<string>();
  const seenI = new Set<string>();
  for (const res of results) {
    const dsd = res?.document?.derivedStructData || {};
    const link: string = dsd.link || dsd.formattedUrl || '';
    if (isHttp(link)) { const n = link.split('#')[0]; if (!seenP.has(n)) { seenP.add(n); pageUrls.push(link); } }
    const pm = dsd.pagemap || {};
    // cse_image first (usually higher-res), then the cached thumbnail as a fallback candidate
    for (const arr of [pm.cse_image, pm.cse_thumbnail]) {
      const src = Array.isArray(arr) ? arr[0]?.src : undefined;
      if (isHttp(src) && !seenI.has(src)) { seenI.add(src); imageUrls.push(src); }
    }
  }
  log(`Discovery: ${pageUrls.length} pages · ${imageUrls.length} pagemap images for "${q}"`);
  return { pageUrls, imageUrls };
}
