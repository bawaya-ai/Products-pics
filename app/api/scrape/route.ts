// ── POST /api/scrape — the core pipeline, streamed as NDJSON progress ──────
// { url, settings } → extract → per-image (fetch → bg-remove → unify) → AI enrich
// → { type:'result', manifest }

import { NextRequest } from 'next/server';
import { resolveSettings } from '@/core/settings';
import { requireRole } from '@/core/auth';
import { bumpCounter, dbConfigured } from '@/core/db';
import { extractMedia } from '@/core/extract';
import { searchImages } from '@/core/websearch';
import { selectPool, poolThumb } from '@/core/select';
import { processImage } from '@/core/process';
import { enrich } from '@/core/enrich';
import { toILS, normalizeCurrency, candidateAmounts } from '@/core/currency';
import { probeVideos, type VideoCandidate } from '@/core/video';
import type { Manifest, ManifestVideo, ProcessedImage, ProgressEvent } from '@/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const TIME_BUDGET_MS = 280_000; // stop early; leave headroom for the fast bg-off fallback + flush under the 300s Vercel kill

export async function POST(req: NextRequest) {
  const g = requireRole(req); if ('error' in g) return g.error;

  // SAFETY CAP (not thrift): a per-user daily run ceiling so a bug, a runaway loop, or a
  // stolen session can't drain the provider accounts. Raise via DAILY_RUN_CAP when needed.
  if (dbConfigured()) {
    const cap = Math.max(1, Number(process.env.DAILY_RUN_CAP) || 400);
    const n = await bumpCounter(`scrape:${g.session.uid}`).catch(() => 0);
    if (n > cap) {
      return new Response(JSON.stringify({ error: `وصلت سقف الأمان اليومي (${cap} عملية سحب). إذا هاد مقصود، ارفع DAILY_RUN_CAP بالإعدادات.` }), { status: 429 });
    }
  }

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
  const deadlineAt = started + TIME_BUDGET_MS; // threaded into every provider call (enforced budget)
  // Client-disconnect handling: an abandoned tab must stop the paid provider spending.
  let aborted = false;
  try { req.signal.addEventListener('abort', () => { aborted = true; }); } catch { /* no signal in tests */ }
  const stream = new ReadableStream({
    cancel() { aborted = true; },
    async start(controller) {
      const send = (e: ProgressEvent) => {
        if (aborted) return;
        try { controller.enqueue(enc.encode(JSON.stringify(e) + '\n')); } catch { aborted = true; }
      };
      const log = (m: string) => send({ type: 'stage', stage: 'log', detail: m });
      // MEASURED spend — streamed the moment a paid provider call actually happens
      const cost = (label: string, usd: number, detail?: string) => send({ type: 'cost', label, usd, detail });
      try {
        // ── SOURCE: a product URL (extract from the page) OR a text query (web search) ──
        let candidateUrls: string[] = [];
        let pageTitle = '';
        let pageText = '';
        let srcWarnings: string[] = [];
        let videoUrls: string[] = [];
        let videoCandidates: VideoCandidate[] = [];
        let ldPrice: { amount: number; currency: string } | undefined;

        if (isUrl) {
          if (/\b(search_result|search_key|\/search|category|list\.html|goods_list)\b/i.test(url)) {
            send({ type: 'warn', message: 'هذا رابط بحث/تصنيف — بيسحب صور منتجات مخلوطة. الأفضل رابط منتج واحد (goods.html / -g-رقم).' });
          }
          send({ type: 'stage', stage: 'extract', detail: 'استخراج الصور من الصفحة…' });
          const ex = await extractMedia(url, s, log);
          candidateUrls = ex.imageUrls; pageTitle = ex.pageTitle; pageText = ex.pageText; srcWarnings = ex.warnings; videoUrls = ex.videoUrls; ldPrice = ex.ldPrice;
          videoCandidates = ex.videos;
          if (videoCandidates.length) send({ type: 'warn', message: `🎬 لقيت فيديو للمنتج — رح يظهر بالمعاينة.` });
        } else {
          send({ type: 'stage', stage: 'search', detail: `بحث عن صور: "${url}"…` });
          send({ type: 'warn', message: '🔎 بحث ويب — الصور من مصادر عامة (حقوقها مجهولة). راجعها قبل الحفظ.' });
          const ws = await searchImages(url, s, log);
          candidateUrls = ws.imageUrls; pageTitle = url; pageText = `Product search query: ${url}`; srcWarnings = ws.warnings;
          if (ws.videos?.length) {
            videoCandidates = ws.videos.map((v) => ({ url: v.url, poster: v.poster, source: 'instagram' as const }));
            send({ type: 'warn', message: `🎬 لقيت ${videoCandidates.length} فيديو (ريلز) — رح يظهروا بالمعاينة.` });
          }
          // captions ride into the AI prompt as extra (fenced/untrusted) context
          if (ws.igCaptions?.length) pageText += `\nINSTAGRAM CAPTIONS: ${ws.igCaptions.join(' | ')}`;
        }

        srcWarnings.forEach((w) => send({ type: 'warn', message: w }));
        if (candidateUrls.length === 0) {
          send({ type: 'error', message: isUrl
            ? 'ما لقيت ولا صورة بالصفحة — جرّب رابط فيه top_gallery_url أو فعّل Firecrawl بالإعدادات.'
            : 'ما لقيت صور بالبحث — تأكد من مفتاح Google CSE (key+cx) أو Firecrawl بالإعدادات.' });
          controller.close(); return;
        }
        const ex = { pageTitle, pageText, warnings: srcWarnings };

        // ── VIDEO PROBE: pure I/O, runs CONCURRENTLY with the image pool download —
        //    it hides entirely inside that window and never eats the image budget ──
        const videoTask: Promise<ManifestVideo[]> = (s.includeVideos !== false && videoCandidates.length)
          ? probeVideos(videoCandidates, s, 8000, log).catch(() => [] as ManifestVideo[])
          : Promise.resolve([] as ManifestVideo[]);

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
          ai = await enrich(ex.pageTitle, ex.pageText, poolThumbs, s, log, deadlineAt, cost);
          const kept = ai.imageRoles.filter((r) => r.role !== 'skip' && pool[r.index]);
          // exactly ONE main — demote any extra 'main' the model returned to 'angle'
          let seenMain = false;
          for (const k of kept) { if (k.role === 'main') { if (seenMain) k.role = 'angle'; else seenMain = true; } }
          if (kept.length) {
            // main first, then as the AI ordered them
            keepOrder = kept.sort((a, b) => (a.role === 'main' ? -1 : b.role === 'main' ? 1 : 0)).slice(0, s.maxImages);
            log(`AI kept ${keepOrder.length}/${pool.length}, skipped ${pool.length - keepOrder.length}`);
          }
        } else {
          keepOrder = keepOrder.slice(0, s.maxImages);
        }
        if (!keepOrder.some((k) => k.role === 'main') && keepOrder[0]) keepOrder[0].role = 'main';

        // ── PRICE CROSS-CHECK: the AI's amount must exist in the page's own evidence.
        //    A price in neither the mined candidates nor the raw text = hallucinated or
        //    injected by a hostile page → drop it loudly instead of trusting it. ──
        if (ai.price.amount) {
          const cands = candidateAmounts(pageText);
          const amtStr = String(ai.price.amount);
          const inCands = cands.some((a) => Math.abs(a - ai.price.amount!) < 0.005);
          const matchesLd = ldPrice && Math.abs(ldPrice.amount - ai.price.amount) < 0.005;
          if (!matchesLd && cands.length && !inCands && !pageText.includes(amtStr)) {
            send({ type: 'warn', message: `السعر ${amtStr} اللي رجّعه الذكاء ما ظهر بالصفحة نفسها — تجاهلناه، راجع السعر يدويًا.` });
            ai.price.amount = null;
          }
        }
        // JSON-LD is authoritative structured data: fill a missing AI price from it
        if (!ai.price.amount && ldPrice) {
          ai.price = { amount: ldPrice.amount, currency: ldPrice.currency };
          log(`price from JSON-LD: ${ldPrice.amount} ${ldPrice.currency}`);
        }
        // confidence: 'high' only when the AI and the structured markup AGREE
        const priceConfidence: 'high' | 'low' =
          ldPrice && ai.price.amount && Math.abs(ldPrice.amount - ai.price.amount) < 0.005 ? 'high' : 'low';

        // ── PROCESS: background-remove + unify only the chosen winners ──
        const images: ProcessedImage[] = [];
        for (let n = 0; n < keepOrder.length; n++) {
          if (aborted) { log('client disconnected — stopping paid work'); break; }
          if (Date.now() - started > TIME_BUDGET_MS) {
            send({ type: 'warn', message: `الوقت خلص — تم تخطّي ${keepOrder.length - n} صورة.` });
            break;
          }
          const { index, role } = keepOrder[n];
          const c = pool[index];
          send({ type: 'image', index: n, total: keepOrder.length, status: 'processing', detail: `${c.width}×${c.height}` });
          try {
            // watermark removal (slow/costly) only on the MAIN image, never the whole set
            const imgS = { ...s, removeWatermark: s.removeWatermark && role === 'main' };
            const out = await processImage(c.buf, c.contentType, imgS, log, deadlineAt, cost);
            images.push({
              id: `im_${n}_${Math.random().toString(36).slice(2, 8)}`,
              sourceUrl: c.sourceUrl, role, order: n,
              dataUrl: `data:${out.contentType};base64,${out.buf.toString('base64')}`,
              width: out.width, height: out.height, bytes: out.bytes,
              hasAlpha: out.hasAlpha, bgProvider: out.bgProvider, warnings: out.warnings,
              variants: out.variants.slice(1).map((v) => ({ format: v.format, dataUrl: `data:${v.contentType};base64,${v.buf.toString('base64')}`, bytes: v.bytes })),
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
            // emergency path: no bg removal AND no watermark inpaint — this runs exactly
            // when time ran out, so never spend it on the slowest optional step
            const out = await processImage(c.buf, c.contentType, { ...s, bgMode: 'off', removeWatermark: false }, log, deadlineAt + 10_000);
            images.push({
              id: 'im_fallback', sourceUrl: c.sourceUrl, role: 'main', order: 0,
              dataUrl: `data:${out.contentType};base64,${out.buf.toString('base64')}`,
              width: out.width, height: out.height, bytes: out.bytes,
              hasAlpha: false, bgProvider: 'none', warnings: ['bg_skipped_time'],
              variants: out.variants.slice(1).map((v) => ({ format: v.format, dataUrl: `data:${v.contentType};base64,${v.buf.toString('base64')}`, bytes: v.bytes })),
            });
            send({ type: 'warn', message: 'الوقت ضاق — رجّعت الصورة الرئيسية بدون إزالة خلفية. للخلفية النظيفة جرّب رابط منتج مباشر أو مفتاح Replicate.' });
          } catch { /* fall through to error */ }
        }
        if (images.length === 0) { send({ type: 'error', message: 'كل الصور فشلت بالمعالجة.' }); controller.close(); return; }
        if (!images.some((i) => i.role === 'main')) images[0].role = 'main';

        // ── PRICE: convert the detected amount → ILS (unless disabled or already ILS) ──
        let price: Manifest['price'] = { amount: null, currency: 'ILS', confidence: 'none' };
        let priceWarn: string | null = null;
        if (ai.price.amount && !ai.price.currency) {
          // an amount with NO visible currency — never assert it as ₪ (a missed $ symbol
          // would show a ~4x-wrong shekel price); surface the number for manual review instead
          priceWarn = `لقيت سعر ${ai.price.amount} بدون عملة واضحة — ما افترضناه ₪، حطّه يدويًا`;
        } else if (ai.price.amount && ai.price.currency) {
          const norm = normalizeCurrency(ai.price.currency);
          if (s.convertCurrency === false || norm === 'ILS') {
            price = { amount: ai.price.amount, currency: 'ILS', confidence: priceConfidence };
          } else {
            const conv = await toILS(ai.price.amount, ai.price.currency).catch(() => null);
            if (conv) {
              price = { amount: conv.ils, currency: 'ILS', confidence: priceConfidence, original: { amount: ai.price.amount, currency: norm || ai.price.currency } };
              log(`price ${ai.price.amount} ${ai.price.currency} → ₪${conv.ils} (${conv.source})`);
            } else {
              // unknown/unconvertible currency — never present a foreign number under the ₪ label
              price = { amount: null, currency: 'ILS', confidence: 'none' };
              priceWarn = `تعذّر تحويل العملة "${ai.price.currency}" — احسب السعر يدويًا`;
            }
          }
        }

        const videos = await videoTask;
        const manifest: Manifest = {
          sourceUrl: url,
          pageTitle: ex.pageTitle,
          name: ai.name, description: ai.description,
          price,
          tags: ai.tags, category: s.category || 'toys',
          images,
          videos: videos.length ? videos : undefined,
          video: videos[0] ? { url: videos[0].url, poster: videos[0].poster } : (videoUrls[0] ? { url: videoUrls[0] } : undefined),
          warnings: [...ex.warnings,
            ...(ai.provider === 'none' && s.aiEnabled
              ? [(ai as any).failReason === 'unparseable' ? 'ai_output_unparseable — الموديل ردّ بس ردّه ما انفهم؛ راجع الاسم والوصف يدويًا' : 'ai_enrichment_unavailable']
              : []),
            ...(priceWarn ? [priceWarn] : []), 'price_requires_review'],
          createdAt: new Date().toISOString(),
        };
        send({ type: 'result', manifest });
      } catch (e: any) {
        send({ type: 'error', message: String(e?.message || e).slice(0, 300) });
      }
      try { controller.close(); } catch { /* already cancelled */ }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
