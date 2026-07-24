// ── POST /api/test — live-test each configured key (real connectivity ping) ──
// Uses merged settings (env wins over the browser-provided values). Returns a
// per-provider status: ok | fail | skip (not configured). No values echoed.

import { NextRequest, NextResponse } from 'next/server';
import { resolveSettings, checkAppAuth } from '@/core/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Row = { provider: string; label: string; status: 'ok' | 'fail' | 'skip'; detail: string };

async function withTimeout<T>(p: Promise<T>, ms = 12000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}
const ok = (provider: string, label: string, detail = ''): Row => ({ provider, label, status: 'ok', detail });
const fail = (provider: string, label: string, detail: string): Row => ({ provider, label, status: 'fail', detail: detail.slice(0, 120) });
const skip = (provider: string, label: string): Row => ({ provider, label, status: 'skip', detail: 'غير مضبوط' });

export async function POST(req: NextRequest) {
  if (!checkAppAuth(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  const s = resolveSettings(body?.settings);
  const rows: Row[] = [];

  // Anthropic — 1-token message
  if (s.anthropicKey) {
    try {
      const r = await withTimeout(fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': s.anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: s.anthropicModel || 'claude-opus-4-8', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      }));
      rows.push(r.ok ? ok('anthropic', 'Anthropic (اسم/وصف)') : fail('anthropic', 'Anthropic (اسم/وصف)', `HTTP ${r.status}`));
    } catch (e: any) { rows.push(fail('anthropic', 'Anthropic (اسم/وصف)', String(e?.message))); }
  } else rows.push(skip('anthropic', 'Anthropic (اسم/وصف)'));

  // OpenAI — models list
  if (s.openaiKey) {
    try {
      const r = await withTimeout(fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${s.openaiKey}` } }));
      rows.push(r.ok ? ok('openai', 'OpenAI (بديل)') : fail('openai', 'OpenAI (بديل)', `HTTP ${r.status}`));
    } catch (e: any) { rows.push(fail('openai', 'OpenAI (بديل)', String(e?.message))); }
  } else rows.push(skip('openai', 'OpenAI (بديل)'));

  // remove.bg — account endpoint
  if (s.removebgKey) {
    try {
      const r = await withTimeout(fetch('https://api.remove.bg/v1.0/account', { headers: { 'X-Api-Key': s.removebgKey } }));
      rows.push(r.ok ? ok('removebg', 'remove.bg (خلفية)') : fail('removebg', 'remove.bg (خلفية)', `HTTP ${r.status}`));
    } catch (e: any) { rows.push(fail('removebg', 'remove.bg (خلفية)', String(e?.message))); }
  } else rows.push(skip('removebg', 'remove.bg (خلفية)'));

  // Replicate — account
  if (s.replicateKey) {
    try {
      const r = await withTimeout(fetch('https://api.replicate.com/v1/account', { headers: { Authorization: `Bearer ${s.replicateKey}` } }));
      rows.push(r.ok ? ok('replicate', 'Replicate (خلفية+)') : fail('replicate', 'Replicate (خلفية+)', `HTTP ${r.status}`));
    } catch (e: any) { rows.push(fail('replicate', 'Replicate (خلفية+)', String(e?.message))); }
  } else rows.push(skip('replicate', 'Replicate (خلفية+)'));

  // Firecrawl — minimal search
  if (s.firecrawlKey) {
    try {
      const r = await withTimeout(fetch('https://api.firecrawl.dev/v1/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.firecrawlKey}` },
        body: JSON.stringify({ query: 'test', limit: 1 }),
      }));
      rows.push(r.ok ? ok('firecrawl', 'Firecrawl (بحث/رندرة)') : fail('firecrawl', 'Firecrawl (بحث/رندرة)', `HTTP ${r.status}`));
    } catch (e: any) { rows.push(fail('firecrawl', 'Firecrawl (بحث/رندرة)', String(e?.message))); }
  } else rows.push(skip('firecrawl', 'Firecrawl (بحث/رندرة)'));

  // Google CSE — 1-result image query
  if (s.googleCseKey && s.googleCseCx) {
    try {
      const u = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(s.googleCseKey)}&cx=${encodeURIComponent(s.googleCseCx)}&searchType=image&num=1&q=test`;
      const r = await withTimeout(fetch(u));
      rows.push(r.ok ? ok('googleCse', 'Google CSE (بحث صور)') : fail('googleCse', 'Google CSE (بحث صور)', `HTTP ${r.status}`));
    } catch (e: any) { rows.push(fail('googleCse', 'Google CSE (بحث صور)', String(e?.message))); }
  } else rows.push(skip('googleCse', 'Google CSE (بحث صور)'));

  // Store — POST import with the token + empty images: 400 = token accepted, 401 = bad token
  if (s.storeBase && s.storeToken) {
    try {
      const r = await withTimeout(fetch(`${s.storeBase.replace(/\/+$/, '')}/api/scraper/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scraper-Token': s.storeToken },
        body: JSON.stringify({ images: [], name_en: '' }),
      }));
      if (r.status === 401) rows.push(fail('store', 'المتجر (حفظ)', 'التوكن غير صحيح (401)'));
      else if (r.status === 503) rows.push(fail('store', 'المتجر (حفظ)', 'الاستيراد مطفي بالمتجر (503)'));
      else rows.push(ok('store', 'المتجر (حفظ)', 'التوكن مقبول'));
    } catch (e: any) { rows.push(fail('store', 'المتجر (حفظ)', String(e?.message))); }
  } else rows.push(skip('store', 'المتجر (حفظ)'));

  return NextResponse.json({ rows });
}
