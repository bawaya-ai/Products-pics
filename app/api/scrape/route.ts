// ── POST /api/scrape — the core pipeline, streamed as NDJSON progress ──────
// { url, settings } → extract → per-image (fetch → bg-remove → unify) → AI enrich
// → { type:'result', manifest }

import { NextRequest } from 'next/server';
import { resolveSettings, checkAppAuth, type Settings } from '@/core/settings';
import { extractMedia, fetchImage } from '@/core/extract';
import { processImage, thumbnailJpeg } from '@/core/process';
import { enrich } from '@/core/enrich';
import type { Manifest, ProcessedImage, ProgressEvent } from '@/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TIME_BUDGET_MS = 40_000; // stop early; leave headroom for AI enrich + flush under the 60s Vercel kill

export async function POST(req: NextRequest) {
  if (!checkAppAuth(req)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  const body = await req.json().catch(() => null);
  const url: string | undefined = body?.url;
  if (!url || typeof url !== 'string') {
    return new Response(JSON.stringify({ error: 'url required' }), { status: 400 });
  }
  const s = resolveSettings(body?.settings);

  const enc = new TextEncoder();
  const started = Date.now();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ProgressEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + '\n'));
      const log = (m: string) => send({ type: 'stage', stage: 'log', detail: m });
      try {
        // Warn early on search/listing/category pages — they yield mixed thumbnails, not one product.
        if (/\b(search_result|search_key|\/search|category|list\.html|goods_list)\b/i.test(url)) {
          send({ type: 'warn', message: 'هذا رابط بحث/تصنيف — بيسحب صور منتجات مخلوطة. الأفضل رابط منتج واحد (goods.html / -g-رقم).' });
        }

        send({ type: 'stage', stage: 'extract', detail: 'استخراج الصور من الصفحة…' });
        const ex = await extractMedia(url, s, log);
        ex.warnings.forEach((w) => send({ type: 'warn', message: w }));
        if (ex.imageUrls.length === 0) {
          send({ type: 'error', message: 'ما لقيت ولا صورة بالصفحة — جرّب رابط فيه top_gallery_url أو فعّل Firecrawl بالإعدادات.' });
          controller.close(); return;
        }

        const images: ProcessedImage[] = [];
        const thumbs: string[] = [];
        for (let i = 0; i < ex.imageUrls.length; i++) {
          if (Date.now() - started > TIME_BUDGET_MS) {
            send({ type: 'warn', message: `time budget reached — skipped ${ex.imageUrls.length - i} remaining image(s)` });
            break;
          }
          const src = ex.imageUrls[i];
          send({ type: 'image', index: i, total: ex.imageUrls.length, status: 'processing' });
          const fetched = await fetchImage(src);
          if (!fetched) { send({ type: 'image', index: i, total: ex.imageUrls.length, status: 'failed', detail: 'fetch failed' }); continue; }
          try {
            const out = await processImage(fetched.buf, fetched.contentType, s, log);
            const id = `im_${i}_${Math.random().toString(36).slice(2, 8)}`;
            images.push({
              id, sourceUrl: src, role: i === 0 ? 'main' : 'angle', order: i,
              dataUrl: `data:${out.contentType};base64,${out.buf.toString('base64')}`,
              width: out.width, height: out.height, bytes: out.bytes,
              hasAlpha: out.hasAlpha, bgProvider: out.bgProvider, warnings: out.warnings,
            });
            thumbs.push((await thumbnailJpeg(out.buf)).toString('base64'));
            send({ type: 'image', index: i, total: ex.imageUrls.length, status: 'done', detail: `${out.width}×${out.height} · ${(out.bytes / 1024).toFixed(0)}KB · bg:${out.bgProvider}` });
          } catch (e: any) {
            send({ type: 'image', index: i, total: ex.imageUrls.length, status: 'failed', detail: String(e?.message).slice(0, 120) });
          }
        }
        if (images.length === 0) { send({ type: 'error', message: 'كل الصور فشلت بالمعالجة.' }); controller.close(); return; }

        // AI enrichment (skip when out of time — images still returned)
        let ai = { name: { en: '', ar: '', he: '' }, description: { en: '', ar: '', he: '' }, tags: [] as string[], price_ils: null as number | null, imageRoles: [] as { index: number; role: any }[], provider: 'none' };
        if (s.aiEnabled && Date.now() - started < TIME_BUDGET_MS - 8000) {
          send({ type: 'stage', stage: 'enrich', detail: 'تحليل بالذكاء الاصطناعي (اسم/وصف/تصنيف)…' });
          ai = await enrich(ex.pageTitle, ex.pageText, thumbs, s, log);
          for (const r of ai.imageRoles) if (images[r.index]) images[r.index].role = r.role;
          if (!images.some((i) => i.role === 'main')) images[0].role = 'main';
        }

        const manifest: Manifest = {
          sourceUrl: url,
          pageTitle: ex.pageTitle,
          name: ai.name, description: ai.description,
          price: { amount: ai.price_ils, currency: 'ILS', confidence: ai.price_ils ? 'low' : 'none' },
          tags: ai.tags, category: s.category || 'toys',
          images,
          warnings: [...ex.warnings, ...(ai.provider === 'none' && s.aiEnabled ? ['ai_enrichment_unavailable'] : []), 'price_requires_review'],
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
