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

  // A product with NO reviewed price must never go live at ₪0 — import it INACTIVE
  // so the operator prices it in the store before it's visible.
  const hasPrice = typeof m.price.amount === 'number' && m.price.amount > 0;
  const payload = {
    name_en: m.name.en || m.pageTitle || 'Imported product',
    name_ar: m.name.ar || '',
    name_he: m.name.he || '',
    description_en: m.description.en || '',
    description_ar: m.description.ar || '',
    description_he: m.description.he || '',
    category: m.category || s.category || 'toys',
    tags: m.tags,
    price_ils: hasPrice ? Math.round(m.price.amount! * 100) : 0, // agorot
    is_active: s.publish !== false && hasPrice,
    source_url: m.sourceUrl,
    video_url: m.video?.url || (m.videos || []).find((v) => v.keep !== false)?.url || undefined,
    // kept videos (≤2): the STORE downloads these server-side into its own R2 —
    // bytes never transit this tool (Vercel body limits make base64 video impossible)
    videos: (m.videos || []).filter((v) => v.keep !== false).slice(0, 2).map((v) => ({
      url: v.url, poster_url: v.poster, width: v.width, height: v.height, bytes: v.bytes, content_type: v.contentType,
    })),
    // review metadata: provenance flags (watermark_removed, ai_output_unparseable, …)
    // travel WITH the product instead of dying at this boundary
    warnings: [...new Set([...(m.warnings || []), ...m.images.flatMap((i) => i.warnings || [])])].slice(0, 20),
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
      // the store now downloads product videos server-side during import — give it room
      signal: AbortSignal.timeout(280000),
    });
    const d = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || !d.ok) return { ok: false, error: d.error || `store responded ${r.status}` };
    return { ok: true, productId: d.product_id, productUrl: d.product_url };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
