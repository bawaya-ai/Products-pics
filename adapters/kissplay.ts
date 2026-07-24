// ── Adapter: Kiss Play store ───────────────────────────────────────────────
// POSTs the manifest + processed image bytes to the store's dedicated import
// endpoint (guarded by a shared token). The STORE writes to its own R2 + D1 —
// this tool never needs the store's storage credentials.

import type { Manifest } from '../core/types';
import type { Settings } from '../core/settings';

export interface SaveResult { ok: boolean; productId?: string; productUrl?: string; error?: string }

export async function saveToKissPlay(m: Manifest, s: Settings): Promise<SaveResult> {
  if (!s.storeBase || !s.storeToken) return { ok: false, error: 'store base URL or import token missing (Settings)' };
  const base = s.storeBase.replace(/\/+$/, '');

  const kept = m.images
    .filter((i) => i.role !== 'skip')
    .sort((a, b) => (a.role === 'main' ? -1 : b.role === 'main' ? 1 : a.order - b.order));
  if (kept.length === 0) return { ok: false, error: 'no images kept' };

  const payload = {
    name_en: m.name.en || m.pageTitle || 'Imported product',
    name_ar: m.name.ar || '',
    name_he: m.name.he || '',
    description_en: m.description.en || '',
    description_ar: m.description.ar || '',
    description_he: m.description.he || '',
    category: m.category || s.category || 'toys',
    tags: m.tags,
    price_ils: m.price.amount ? Math.round(m.price.amount * 100) : 0, // agorot
    is_active: s.publish !== false,
    source_url: m.sourceUrl,
    images: kept.map((i, idx) => ({
      b64: i.dataUrl.split(',')[1],
      contentType: i.dataUrl.slice(5, i.dataUrl.indexOf(';')),
      role: i.role,
      order: idx,
    })),
  };

  try {
    const r = await fetch(`${base}/api/scraper/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scraper-Token': s.storeToken },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(55000),
    });
    const d = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || !d.ok) return { ok: false, error: d.error || `store responded ${r.status}` };
    return { ok: true, productId: d.product_id, productUrl: d.product_url };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
