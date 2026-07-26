// ── POST /api/test — live-test each configured key (real connectivity ping) ──
// Uses merged settings (env wins over the browser-provided values). Returns a
// per-provider status: ok | fail | skip (not configured). No values echoed.
// All probes run in PARALLEL (worst case = the slowest single probe, not the sum)
// with real AbortSignal timeouts, so a hung provider can't kill the whole run.

import { NextRequest, NextResponse } from 'next/server';
import { resolveSettings } from '@/core/settings';
import { requireRoleFresh } from '@/core/auth';
import { discoverySearch } from '@/core/discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Row = { provider: string; label: string; status: 'ok' | 'fail' | 'skip'; detail: string; balance?: string };

const T = (ms = 12000) => AbortSignal.timeout(ms);
const ok = (provider: string, label: string, detail = ''): Row => ({ provider, label, status: 'ok', detail });
const fail = (provider: string, label: string, detail: string): Row => ({ provider, label, status: 'fail', detail: detail.slice(0, 120) });
const skip = (provider: string, label: string): Row => ({ provider, label, status: 'skip', detail: 'غير مضبوط' });

export async function POST(req: NextRequest) {
  const g = await requireRoleFresh(req, 'admin'); if ('error' in g) return g.error;
  const body = await req.json().catch(() => null);
  const s = await resolveSettings(body?.settings);

  const probes: Promise<Row>[] = [
    // Anthropic — 1-token message (doubles as model-ID validation: a bad ID 404s)
    (async (): Promise<Row> => {
      const L = 'Anthropic (اسم/وصف)';
      if (!s.anthropicKey) return skip('anthropic', L);
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': s.anthropicKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: s.anthropicModel || 'claude-opus-4-8', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
          signal: T(),
        });
        return r.ok ? ok('anthropic', L) : fail('anthropic', L, `HTTP ${r.status}`);
      } catch (e: any) { return fail('anthropic', L, String(e?.message)); }
    })(),

    // OpenAI — models list
    (async (): Promise<Row> => {
      const L = 'OpenAI (بديل)';
      if (!s.openaiKey) return skip('openai', L);
      try {
        const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${s.openaiKey}` }, signal: T() });
        return r.ok ? ok('openai', L) : fail('openai', L, `HTTP ${r.status}`);
      } catch (e: any) { return fail('openai', L, String(e?.message)); }
    })(),

    // remove.bg — account endpoint (also carries the credit balance)
    (async (): Promise<Row> => {
      const L = 'remove.bg (خلفية)';
      if (!s.removebgKey) return skip('removebg', L);
      try {
        const r = await fetch('https://api.remove.bg/v1.0/account', { headers: { 'X-Api-Key': s.removebgKey }, signal: T() });
        if (!r.ok) return fail('removebg', L, `HTTP ${r.status}`);
        const d = (await r.json().catch(() => null)) as any;
        const total = d?.data?.attributes?.credits?.total;
        const free = d?.data?.attributes?.api?.free_calls;
        return { ...ok('removebg', L), balance: total != null ? `${total} كريدت` : free != null ? `${free} مجاني/شهر` : '' };
      } catch (e: any) { return fail('removebg', L, String(e?.message)); }
    })(),

    // Replicate — account
    (async (): Promise<Row> => {
      const L = 'Replicate (خلفية+)';
      if (!s.replicateKey) return skip('replicate', L);
      try {
        const r = await fetch('https://api.replicate.com/v1/account', { headers: { Authorization: `Bearer ${s.replicateKey}` }, signal: T() });
        return r.ok ? ok('replicate', L) : fail('replicate', L, `HTTP ${r.status}`);
      } catch (e: any) { return fail('replicate', L, String(e?.message)); }
    })(),

    // Firecrawl — minimal search + credit balance
    (async (): Promise<Row> => {
      const L = 'Firecrawl (بحث/رندرة)';
      if (!s.firecrawlKey) return skip('firecrawl', L);
      try {
        const r = await fetch('https://api.firecrawl.dev/v1/search', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.firecrawlKey}` },
          body: JSON.stringify({ query: 'test', limit: 1 }),
          signal: T(),
        });
        if (!r.ok) return fail('firecrawl', L, `HTTP ${r.status}`);
        let bal = '';
        try {
          const cu = await fetch('https://api.firecrawl.dev/v1/team/credit-usage', { headers: { Authorization: `Bearer ${s.firecrawlKey}` }, signal: T(8000) });
          if (cu.ok) { const d = (await cu.json().catch(() => null)) as any; const rem = d?.data?.remaining_credits ?? d?.data?.remainingCredits; if (rem != null) bal = `${rem} كريدت`; }
        } catch { /* balance is best-effort */ }
        return { ...ok('firecrawl', L), balance: bal };
      } catch (e: any) { return fail('firecrawl', L, String(e?.message)); }
    })(),

    // Google CSE — 1-result image query
    (async (): Promise<Row> => {
      const L = 'Google CSE (بحث صور)';
      if (!s.googleCseKey || !s.googleCseCx) return skip('googleCse', L);
      try {
        const u = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(s.googleCseKey)}&cx=${encodeURIComponent(s.googleCseCx)}&searchType=image&num=1&q=test`;
        const r = await fetch(u, { signal: T() });
        return r.ok ? ok('googleCse', L) : fail('googleCse', L, `HTTP ${r.status}`);
      } catch (e: any) { return fail('googleCse', L, String(e?.message)); }
    })(),

    // Google Vertex AI Search (Discovery Engine) — SA token + tiny 1-result search
    (async (): Promise<Row> => {
      const L = 'Google Vertex (بحث)';
      if (!s.googleSaKey) return skip('googleVertex', L);
      try {
        const dr = await discoverySearch('airpods', { pageSize: 1 }, s, () => {});
        return { ...ok('googleVertex', L), balance: `${dr.pageUrls.length} نتيجة` };
      } catch (e: any) { return fail('googleVertex', L, String(e?.message)); }
    })(),

    // Resend — list domains validates a full-access key; sending-only key = 401 "restricted" (still valid)
    (async (): Promise<Row> => {
      const L = 'Resend (إيميل)';
      if (!s.resendKey) return skip('resend', L);
      try {
        const r = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${s.resendKey}` }, signal: T() });
        if (r.ok) return ok('resend', L);
        const t = (await r.text().catch(() => '')).toLowerCase();
        if (r.status === 401 && /restrict|only send|sending/.test(t)) return ok('resend', L, 'مفتاح إرسال صالح');
        return fail('resend', L, r.status === 401 ? 'مفتاح غير صحيح (401)' : `HTTP ${r.status}`);
      } catch (e: any) { return fail('resend', L, String(e?.message)); }
    })(),

    // Store — POST import with the token + empty payload. ONLY the protocol's own answers
    // count as token-accepted (400 validation / 2xx); 404/405 = WRONG BASE URL, 5xx = store error.
    (async (): Promise<Row> => {
      const L = 'المتجر (حفظ)';
      if (!s.storeBase || !s.storeToken) return skip('store', L);
      try {
        const r = await fetch(`${s.storeBase.replace(/\/+$/, '')}/api/scraper/import`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scraper-Token': s.storeToken },
          body: JSON.stringify({ images: [], name_en: '' }),
          signal: T(),
        });
        if (r.status === 401) return fail('store', L, 'التوكن غير صحيح (401)');
        if (r.status === 503) return fail('store', L, 'الاستيراد مطفي بالمتجر (503)');
        if (r.status === 404 || r.status === 405) return fail('store', L, `رابط المتجر غلط — ما في /api/scraper/import (HTTP ${r.status})`);
        if (r.status >= 500) return fail('store', L, `خطأ عند المتجر (HTTP ${r.status})`);
        if (r.status === 400 || r.ok) return ok('store', L, 'التوكن مقبول');
        return fail('store', L, `رد غير متوقع (HTTP ${r.status})`);
      } catch (e: any) { return fail('store', L, String(e?.message)); }
    })(),
  ];

  const settled = await Promise.allSettled(probes);
  const rows: Row[] = settled.map((p) => (p.status === 'fulfilled' ? p.value : fail('unknown', 'فحص', String(p.reason).slice(0, 80))));
  return NextResponse.json({ rows });
}
