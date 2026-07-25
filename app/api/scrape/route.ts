// ── POST /api/scrape — the core pipeline, streamed as NDJSON progress ──────
// { url, settings } → extract → per-image (fetch → bg-remove → unify) → AI enrich
// → { type:'result', manifest }

import { NextRequest } from 'next/server';
import { resolveSettings } from '@/core/settings';
import { requireRole } from '@/core/auth';
import { extractMedia } from '@/core/extract';
import { searchImages } from '@/core/websearch';
import { selectPool, poolThumb } from '@/core/select';
import { processImage } from '@/core/process';
import { enrich } from '@/core/enrich';
import { toILS, normalizeCurrency } from '@/core/currency';
import type { Manifest, ProcessedImage, ProgressEvent } from '@/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TIME_BUDGET_MS = 46_000; // stop early; leave headroom for the fast bg-off fallback + flush under the 60s Vercel kill

export async function POST(req: NextRequest) {
  const g = requireRole(req); if ('error' in g) return g.error;

  const body = await req.json().catch(() => null);
  const input: string | undefined = body?.url;
  if (!input || typeof input !== 'string') {
    return new Response(JSON.stringify({ error: 'url or search query required' }), { status: 400 });
  }
  const url = input.trim();
  const isUrl = /^https?:\/\//i.test(url);
  const s = await resolveSettings(body?.settings);

  const enc = new TextEncoder();
  const started = Date.now();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ProgressEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + '\n'));
      const log = (m: string) => send({ type: 'stage', stage: 'log', detail: m });
      try {
        // ── SOURCE: a product URL (extract from the page) OR a text query (web search) ──
        let candidateUrls: string[] = [];
        let pageTitle = '';
        let pageText = '';
        let srcWarnings: string[] = [];

        if (isUrl) {
          if (/\b(search_result|search_key|\/search|category|list\.html|goods_list)\b/i.test(url)) {
            send({ type: 'warn', message: 'هذا رابط بحث/تصنيف — بيسحب صور منتجات مخلوطة. الأفضل رابط منتج واحد (goods.html / -g-رقم).' });
          }
          send({ type: 'stage', stage: 'extract', detail: 'استخراج الصور من الصفحة…' });
          const ex = await extractMedia(url, s, log);
          candidateUrls = ex.imageUrls; pageTitle = ex.pageTitle; pageText = ex.pageText; srcWarnings = ex.warnings;
        } else {
          send({ type: 'stage', stage: 'search', detail: `بحث عن صور: "${url}"…` });
          send({ type: 'warn', message: '🔎 بحث ويب — الصور من مصادر عامة (حقوقها مجهولة). راجعها قبل الحفظ.' });
          const ws = await searchImages(url, s, log);
          candidateUrls = ws.imageUrls; pageTitle = url; pageText = `Product search query: ${url}`; srcWarnings = ws.warnings;
        }

        srcWarnings.forEach((w) => send({ type: 'warn', message: w }));
        if (candidateUrls.length === 0) {
          send({ type: 'error', message: isUrl
            ? 'ما لقيت ولا صورة بالصفحة — جرّب رابط فيه top_gallery_url أو فعّل Firecrawl بالإعدادات.'
            : 'ما لقيت صور بالبحث — تأكد من مفتاح Google CSE (key+cx) أو Firecrawl بالإعدادات.' });
          controller.close(); return;
        }
        const ex = { pageTitle, pageText, warnings: srcWarnings };

        // ── SELECT: download pool, measure real resolution, drop tiny/duplicates, rank ──
        send({ type: 'stage', stage: 'select', detail: 'قياس الدقّة واختيار الأفضل…' });
        const pool = await selectPool(candidateUrls, s, log);
        if (pool.length === 0) { send({ type: 'error', message: 'ما في صور بدقّة كافية (كلها صغيرة/مكرّرة).' }); controller.close(); return; }

        // ── AI CURATE: pick the best shots (roles, drop junk) + write the copy, one call ──
        let ai = { name: { en: '', ar: '', he: '' }, description: { en: '', ar: '', he: '' }, tags: [] as string[], price: { amount: null as number | null, currency: null as string | null }, imageRoles: [] as { index: number; role: any }[], provider: 'none' };
        let keepOrder = pool.map((_, i) => ({ index: i, role: (i === 0 ? 'main' : 'angle') as any }));
        if (s.aiEnabled) {
          send({ type: 'stage', stage: 'curate', detail: 'الذكاء يختار الأفضل ويكتب الوصف…' });
          const poolThumbs = await Promise.all(pool.map((c) => poolThumb(c.buf)));
          ai = await enrich(ex.pageTitle, ex.pageText, poolThumbs, s, log);
          const kept = ai.imageRoles.filter((r) => r.role !== 'skip' && pool[r.index]);
          if (kept.length) {
            // main first, then as the AI ordered them
            keepOrder = kept.sort((a, b) => (a.role === 'main' ? -1 : b.role === 'main' ? 1 : 0)).slice(0, s.maxImages);
            log(`AI kept ${keepOrder.length}/${pool.length}, skipped ${pool.length - keepOrder.length}`);
          }
        } else {
          keepOrder = keepOrder.slice(0, s.maxImages);
        }
        if (!keepOrder.some((k) => k.role === 'main') && keepOrder[0]) keepOrder[0].role = 'main';

        // ── PROCESS: background-remove + unify only the chosen winners ──
        const images: ProcessedImage[] = [];
        for (let n = 0; n < keepOrder.length; n++) {
          if (Date.now() - started > TIME_BUDGET_MS) {
            send({ type: 'warn', message: `الوقت خلص — تم تخطّي ${keepOrder.length - n} صورة.` });
            break;
          }
          const { index, role } = keepOrder[n];
          const c = pool[index];
          send({ type: 'image', index: n, total: keepOrder.length, status: 'processing', detail: `${c.width}×${c.height}` });
          try {
            const out = await processImage(c.buf, c.contentType, s, log);
            images.push({
              id: `im_${n}_${Math.random().toString(36).slice(2, 8)}`,
              sourceUrl: c.sourceUrl, role, order: n,
              dataUrl: `data:${out.contentType};base64,${out.buf.toString('base64')}`,
              width: out.width, height: out.height, bytes: out.bytes,
              hasAlpha: out.hasAlpha, bgProvider: out.bgProvider, warnings: out.warnings,
            });
            send({ type: 'image', index: n, total: keepOrder.length, status: 'done', detail: `${out.width}×${out.height} · ${(out.bytes / 1024).toFixed(0)}KB · bg:${out.bgProvider}` });
          } catch (e: any) {
            send({ type: 'image', index: n, total: keepOrder.length, status: 'failed', detail: String(e?.message).slice(0, 120) });
          }
        }

        // Guaranteed-result fallback: if nothing got processed (slow search + slow
        // cold-start bg model ate the budget), return the top image WITHOUT bg removal
        // so the user always gets something usable.
        if (images.length === 0 && keepOrder[0] && pool[keepOrder[0].index] && s.bgMode !== 'off') {
          try {
            const c = pool[keepOrder[0].index];
            const out = await processImage(c.buf, c.contentType, { ...s, bgMode: 'off' }, log);
            images.push({
              id: 'im_fallback', sourceUrl: c.sourceUrl, role: 'main', order: 0,
              dataUrl: `data:${out.contentType};base64,${out.buf.toString('base64')}`,
              width: out.width, height: out.height, bytes: out.bytes,
              hasAlpha: false, bgProvider: 'none', warnings: ['bg_skipped_time'],
            });
            send({ type: 'warn', message: 'الوقت ضاق — رجّعت الصورة الرئيسية بدون إزالة خلفية. للخلفية النظيفة جرّب رابط منتج مباشر أو مفتاح Replicate.' });
          } catch { /* fall through to error */ }
        }
        if (images.length === 0) { send({ type: 'error', message: 'كل الصور فشلت بالمعالجة.' }); controller.close(); return; }
        if (!images.some((i) => i.role === 'main')) images[0].role = 'main';

        // ── PRICE: convert the detected amount → ILS (unless disabled or already ILS) ──
        let price: Manifest['price'] = { amount: ai.price.amount, currency: 'ILS', confidence: ai.price.amount ? 'low' : 'none' };
        let priceWarn: string | null = null;
        if (ai.price.amount && ai.price.currency) {
          const norm = normalizeCurrency(ai.price.currency);
          if (s.convertCurrency === false || norm === 'ILS') {
            price = { amount: ai.price.amount, currency: 'ILS', confidence: 'low' };
          } else {
            const conv = await toILS(ai.price.amount, ai.price.currency).catch(() => null);
            if (conv) {
              price = { amount: conv.ils, currency: 'ILS', confidence: 'low', original: { amount: ai.price.amount, currency: norm || ai.price.currency } };
              log(`price ${ai.price.amount} ${ai.price.currency} → ₪${conv.ils} (${conv.source})`);
            } else {
              // unknown/unconvertible currency — never present a foreign number under the ₪ label
              price = { amount: null, currency: 'ILS', confidence: 'none' };
              priceWarn = `تعذّر تحويل العملة "${ai.price.currency}" — احسب السعر يدويًا`;
            }
          }
        }

        const manifest: Manifest = {
          sourceUrl: url,
          pageTitle: ex.pageTitle,
          name: ai.name, description: ai.description,
          price,
          tags: ai.tags, category: s.category || 'toys',
          images,
          warnings: [...ex.warnings, ...(ai.provider === 'none' && s.aiEnabled ? ['ai_enrichment_unavailable'] : []), ...(priceWarn ? [priceWarn] : []), 'price_requires_review'],
          createdAt: new Date().toISOString(),
        };
        send({ type: 'result', manifest });
      } catch (e: any) {
        send({ type: 'error', message: String(e?.message || e).slice(0, 300) });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
