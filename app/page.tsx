'use client';

// ── Scraper Pro UI — paste URL → process → preview/edit → save ─────────────

import { useEffect, useRef, useState } from 'react';
import type { Manifest, MediaRole, ProgressEvent } from '@/core/types';

interface ClientSettings {
  size: number; quality: number; format: 'webp' | 'png'; maxImages: number;
  bgMode: string; replicateKey: string; removebgKey: string;
  aiEnabled: boolean; anthropicKey: string; openaiKey: string; anthropicModel: string;
  firecrawlKey: string; googleCseKey: string; googleCseCx: string;
  storeBase: string; storeToken: string; category: string; publish: boolean;
  appPassword: string;
}
const DEFAULT_SETTINGS: ClientSettings = {
  size: 1024, quality: 88, format: 'webp', maxImages: 8,
  bgMode: 'auto', replicateKey: '', removebgKey: '',
  aiEnabled: true, anthropicKey: '', openaiKey: '', anthropicModel: 'claude-opus-4-8',
  firecrawlKey: '', googleCseKey: '', googleCseCx: '',
  storeBase: '', storeToken: '', category: 'toys', publish: true,
  appPassword: '',
};
const CATEGORIES = ['toys', 'lingerie', 'couples', 'oils-care', 'gifts', 'offers'];
const LS_KEY = 'scraper-pro-settings-v1';

export default function Home() {
  const [settings, setSettings] = useState<ClientSettings>(DEFAULT_SETTINGS);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [logLines, setLogLines] = useState<{ t: string; c?: string }[]>([]);
  const [progress, setProgress] = useState(0);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [adapter, setAdapter] = useState<'kiss-play' | 'json'>('kiss-play');
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const [envStatus, setEnvStatus] = useState<Record<string, boolean> | null>(null);
  const [testRows, setTestRows] = useState<Record<string, { status: string; detail: string }>>({});
  const [testing, setTesting] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { const raw = localStorage.getItem(LS_KEY); if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) }); } catch {}
    fetch('/api/status').then((r) => r.json()).then((d) => setEnvStatus(d.env)).catch(() => {});
  }, []);

  // provider registry for the status strip + test button
  const PROVIDERS: { id: string; label: string; filled: (s: ClientSettings) => boolean }[] = [
    { id: 'anthropic', label: 'Anthropic', filled: (s) => !!s.anthropicKey },
    { id: 'removebg', label: 'remove.bg', filled: (s) => !!s.removebgKey },
    { id: 'replicate', label: 'Replicate', filled: (s) => !!s.replicateKey },
    { id: 'firecrawl', label: 'Firecrawl', filled: (s) => !!s.firecrawlKey },
    { id: 'googleCse', label: 'Google CSE', filled: (s) => !!(s.googleCseKey && s.googleCseCx) },
    { id: 'openai', label: 'OpenAI', filled: (s) => !!s.openaiKey },
    { id: 'store', label: 'المتجر', filled: (s) => !!s.storeToken },
  ];
  // saved source per provider: 'server' (env) | 'browser' (UI) | 'none'
  const savedSource = (id: string): 'server' | 'browser' | 'none' => {
    const envKey = id === 'store' ? 'storeToken' : id; // status reports the store token, not "store"
    if (envStatus?.[envKey]) return 'server';
    if (PROVIDERS.find((p) => p.id === id)?.filled(settings)) return 'browser';
    return 'none';
  };

  async function testKeys() {
    if (testing) return;
    setTesting(true); setTestRows({});
    try {
      const r = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(settings.appPassword ? { 'x-app-password': settings.appPassword } : {}) },
        body: JSON.stringify({ settings }),
      });
      if (r.status === 401) { setTestRows({ _auth: { status: 'fail', detail: 'كلمة سر الأداة غلط' } }); setTesting(false); return; }
      const d = await r.json();
      const map: Record<string, { status: string; detail: string }> = {};
      for (const row of d.rows || []) map[row.provider] = { status: row.status, detail: row.detail };
      setTestRows(map);
    } catch (e: any) { setTestRows({ _err: { status: 'fail', detail: String(e?.message) } }); }
    setTesting(false);
  }
  const upd = (patch: Partial<ClientSettings>) => {
    setSettings((s) => { const n = { ...s, ...patch }; try { localStorage.setItem(LS_KEY, JSON.stringify(n)); } catch {} return n; });
  };
  const pushLog = (t: string, c?: string) => {
    setLogLines((l) => [...l.slice(-200), { t, c }]);
    setTimeout(() => logRef.current?.scrollTo(0, 1e6), 30);
  };

  async function run() {
    if (!url.trim() || busy) return;
    setBusy(true); setManifest(null); setSaveMsg(null); setLogLines([]); setProgress(4);
    pushLog('▶ starting…');
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(settings.appPassword ? { 'x-app-password': settings.appPassword } : {}) },
        body: JSON.stringify({ url: url.trim(), settings }),
      });
      if (!res.ok || !res.body) { pushLog(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, 'err'); setBusy(false); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          try { handleEvent(JSON.parse(line) as ProgressEvent); } catch {}
        }
      }
    } catch (e: any) { pushLog(`✗ ${e?.message}`, 'err'); }
    setBusy(false);
  }

  function handleEvent(e: ProgressEvent) {
    if (e.type === 'stage') { pushLog(e.detail ? `— ${e.detail}` : `— ${e.stage}`); if (e.stage === 'enrich') setProgress(82); }
    else if (e.type === 'image') {
      const pct = 10 + Math.round(((e.index + (e.status === 'done' ? 1 : 0.4)) / e.total) * 65);
      setProgress(pct);
      if (e.status === 'done') pushLog(`✓ صورة ${e.index + 1}/${e.total} — ${e.detail}`, 'ok');
      else if (e.status === 'failed') pushLog(`✗ صورة ${e.index + 1}/${e.total} — ${e.detail}`, 'err');
    }
    else if (e.type === 'warn') pushLog(`⚠ ${e.message}`, 'warn');
    else if (e.type === 'error') { pushLog(`✗ ${e.message}`, 'err'); setProgress(0); }
    else if (e.type === 'result') { setManifest(e.manifest); setProgress(100); pushLog('✓ جاهز للمعاينة', 'ok'); }
  }

  const setRole = (id: string, role: MediaRole) =>
    setManifest((m) => m && { ...m, images: m.images.map((i) => (i.id === id ? { ...i, role } : role === 'main' && i.role === 'main' ? { ...i, role: 'angle' } : i)) });
  const setField = (path: 'name' | 'description', lang: 'en' | 'ar' | 'he', v: string) =>
    setManifest((m) => m && { ...m, [path]: { ...m[path], [lang]: v } });

  async function save() {
    if (!manifest || busy) return;
    setBusy(true); setSaveMsg(null);
    if (adapter === 'json') { await downloadZip(manifest); setBusy(false); return; }
    try {
      const r = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(settings.appPassword ? { 'x-app-password': settings.appPassword } : {}) },
        body: JSON.stringify({ manifest, adapter, settings }),
      });
      const d = await r.json();
      if (d.ok) setSaveMsg({ ok: true, text: `✓ انحفظ بالمتجر — ${d.productId}`, link: d.productUrl });
      else setSaveMsg({ ok: false, text: `فشل الحفظ: ${d.error || r.status}` });
    } catch (e: any) { setSaveMsg({ ok: false, text: `فشل الحفظ: ${e?.message}` }); }
    setBusy(false);
  }

  async function downloadZip(m: Manifest) {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const kept = m.images.filter((i) => i.role !== 'skip');
    kept.forEach((img, idx) => {
      const ext = img.dataUrl.includes('image/png') ? 'png' : 'webp';
      const name = img.role === 'main' ? `main.${ext}` : `${img.role}-${idx}.${ext}`;
      zip.file(name, img.dataUrl.split(',')[1], { base64: true });
    });
    zip.file('manifest.json', JSON.stringify({ ...m, images: kept.map(({ dataUrl, ...rest }) => rest) }, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `product-${Date.now()}.zip`;
    a.click();
    setSaveMsg({ ok: true, text: '✓ تنزّل ZIP (صور + manifest.json)' });
  }

  return (
    <div className="wrap">
      <header className="hero">
        <h1>🛒 Scraper <em>Pro</em></h1>
        <p>رابط منتج → صور بدون خلفية · حجم موحّد · جودة عالية → متجرك</p>
      </header>

      {/* URL + run */}
      <div className="card">
        <div className="row">
          <input className="grow" type="text" dir="ltr" placeholder="رابط منتج  أو  اكتب اسم منتج للبحث بالصور 🔎"
            value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
          <button className="btn-primary" onClick={run} disabled={busy || !url.trim()}>
            {busy ? '… شغّال' : /^https?:\/\//i.test(url.trim()) ? '🚀 معالجة' : '🔎 بحث ومعالجة'}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>الصق <b>رابط منتج</b> (تيمو/أي موقع)، أو اكتب <b>اسم منتج</b> ليبحث بالصور على الويب (يحتاج مفتاح Google CSE أو Firecrawl).</div>
        {(busy || progress > 0) && <div className="bar"><i style={{ width: `${progress}%` }} /></div>}
        {logLines.length > 0 && (
          <div className="log" ref={logRef}>
            {logLines.map((l, i) => <div key={i} className={l.c}>{l.t}</div>)}
          </div>
        )}
      </div>

      {/* Settings */}
      <div className="card">
        {/* ── Keys status strip + test button ── */}
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="chips">
            {PROVIDERS.map((p) => {
              const src = savedSource(p.id);
              const t = testRows[p.id]?.status;
              const cls = t === 'ok' ? 'ok' : t === 'fail' ? 'err' : src === 'server' ? 'server' : src === 'browser' ? 'browser' : 'none';
              const mark = t === 'ok' ? '✓' : t === 'fail' ? '✗' : src === 'server' ? '☁' : src === 'browser' ? '💾' : '—';
              return <span key={p.id} className={`chip ${cls}`} title={testRows[p.id]?.detail || (src === 'server' ? 'محفوظ على السيرفر' : src === 'browser' ? 'محفوظ بالمتصفح' : 'غير مضبوط')}>{mark} {p.label}</span>;
            })}
          </div>
          <button className="btn-ghost" onClick={testKeys} disabled={testing} style={{ padding: '8px 16px' }}>{testing ? '… يفحص' : '🔌 فحص المفاتيح'}</button>
        </div>
        {(testRows._auth || testRows._err) && <div className="result-err">{testRows._auth?.detail || testRows._err?.detail}</div>}

        <details className="settings">
          <summary>⚙️ الإعدادات (مفاتيح، جودة، المتجر) — ☁ سيرفر · 💾 متصفح</summary>
          <div className="set-grid">
            <div><label className="f">حجم موحّد (px)</label>
              <select value={settings.size} onChange={(e) => upd({ size: +e.target.value })}>
                {[800, 1024, 1500].map((v) => <option key={v} value={v}>{v}×{v}</option>)}
              </select></div>
            <div><label className="f">الصيغة</label>
              <select value={settings.format} onChange={(e) => upd({ format: e.target.value as any })}>
                <option value="webp">WebP (أخف)</option><option value="png">PNG (توافق أعلى)</option>
              </select></div>
            <div><label className="f">أقصى عدد صور</label>
              <input type="number" min={1} max={12} value={settings.maxImages} onChange={(e) => upd({ maxImages: +e.target.value })} /></div>
            <div><label className="f">إزالة الخلفية</label>
              <select value={settings.bgMode} onChange={(e) => upd({ bgMode: e.target.value })}>
                <option value="auto">تلقائي (الأفضل المتاح)</option>
                <option value="local">مجاني محلي (U²-Net)</option>
                <option value="replicate">Replicate (أعلى جودة)</option>
                <option value="removebg">remove.bg</option>
                <option value="off">بدون إزالة</option>
              </select>
              <div className="hint">مجاني مدمج · Replicate أدق (بمفتاح)</div></div>
            <div><label className="f">Replicate API Key (اختياري)</label>
              <input type="password" dir="ltr" value={settings.replicateKey} onChange={(e) => upd({ replicateKey: e.target.value })} /></div>
            <div><label className="f">remove.bg Key (اختياري)</label>
              <input type="password" dir="ltr" value={settings.removebgKey} onChange={(e) => upd({ removebgKey: e.target.value })} /></div>
            <div><label className="f">Anthropic Key — للاسم/الوصف/التصنيف</label>
              <input type="password" dir="ltr" value={settings.anthropicKey} onChange={(e) => upd({ anthropicKey: e.target.value })} /></div>
            <div><label className="f">OpenAI Key (بديل)</label>
              <input type="password" dir="ltr" value={settings.openaiKey} onChange={(e) => upd({ openaiKey: e.target.value })} /></div>
            <div><label className="f">Firecrawl Key — معرض كامل + بحث ويب</label>
              <input type="password" dir="ltr" value={settings.firecrawlKey} onChange={(e) => upd({ firecrawlKey: e.target.value })} /></div>
            <div><label className="f">Google CSE Key — بحث صور بالويب</label>
              <input type="password" dir="ltr" value={settings.googleCseKey} onChange={(e) => upd({ googleCseKey: e.target.value })} /></div>
            <div><label className="f">Google CSE cx (معرّف المحرّك)</label>
              <input type="text" dir="ltr" value={settings.googleCseCx} onChange={(e) => upd({ googleCseCx: e.target.value })} /></div>
            <div><label className="f">رابط متجر Kiss Play (API)</label>
              <input type="text" dir="ltr" placeholder="https://adult-store-api…workers.dev" value={settings.storeBase} onChange={(e) => upd({ storeBase: e.target.value })} /></div>
            <div><label className="f">Import Token تبع المتجر</label>
              <input type="password" dir="ltr" value={settings.storeToken} onChange={(e) => upd({ storeToken: e.target.value })} /></div>
            <div><label className="f">كلمة سر الأداة (لو مفعّلة)</label>
              <input type="password" dir="ltr" value={settings.appPassword} onChange={(e) => upd({ appPassword: e.target.value })} /></div>
          </div>
        </details>
      </div>

      {/* Preview + edit */}
      {manifest && (
        <>
          <div className="card">
            <strong>📸 الصور ({manifest.images.filter((i) => i.role !== 'skip').length} محفوظة)</strong>
            <div className="grid">
              {manifest.images.map((img) => (
                <div key={img.id} className={`thumb ${img.role === 'main' ? 'main-img' : ''}`} style={img.role === 'skip' ? { opacity: 0.35 } : {}}>
                  <img src={img.dataUrl} alt="" />
                  <div className="meta">
                    {img.width}×{img.height} · {(img.bytes / 1024).toFixed(0)}KB
                    <span className={`badge ${img.hasAlpha ? 'alpha' : 'noalpha'}`}>{img.hasAlpha ? 'بدون خلفية ✓' : 'مع خلفية'}</span>
                  </div>
                  <select value={img.role} onChange={(e) => setRole(img.id, e.target.value as MediaRole)}>
                    <option value="main">⭐ رئيسية</option><option value="angle">زاوية</option>
                    <option value="detail">تفاصيل</option><option value="skip">🗑 استبعاد</option>
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <strong>✏️ بيانات المنتج</strong>
            <div className="langs">
              <div><label className="f">الاسم (عربي)</label><input type="text" value={manifest.name.ar} onChange={(e) => setField('name', 'ar', e.target.value)} /></div>
              <div><label className="f">Name (EN)</label><input type="text" dir="ltr" value={manifest.name.en} onChange={(e) => setField('name', 'en', e.target.value)} /></div>
              <div><label className="f">שם (HE)</label><input type="text" dir="rtl" value={manifest.name.he} onChange={(e) => setField('name', 'he', e.target.value)} /></div>
            </div>
            <div className="langs" style={{ marginTop: 8 }}>
              <div><label className="f">الوصف (عربي)</label><textarea value={manifest.description.ar} onChange={(e) => setField('description', 'ar', e.target.value)} /></div>
              <div><label className="f">Description (EN)</label><textarea dir="ltr" value={manifest.description.en} onChange={(e) => setField('description', 'en', e.target.value)} /></div>
              <div><label className="f">תיאור (HE)</label><textarea dir="rtl" value={manifest.description.he} onChange={(e) => setField('description', 'he', e.target.value)} /></div>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <div><label className="f">السعر ₪ (راجعه يدويًا)</label>
                <input type="number" min={0} style={{ width: 130 }} value={manifest.price.amount ?? ''} placeholder="0"
                  onChange={(e) => setManifest((m) => m && { ...m, price: { ...m.price, amount: e.target.value ? +e.target.value : null } })} /></div>
              <div><label className="f">القسم</label>
                <select style={{ width: 150 }} value={manifest.category} onChange={(e) => setManifest((m) => m && { ...m, category: e.target.value })}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select></div>
              <div><label className="f">نشر فوري؟</label>
                <select style={{ width: 120 }} value={settings.publish ? '1' : '0'} onChange={(e) => upd({ publish: e.target.value === '1' })}>
                  <option value="1">نعم — فعّال</option><option value="0">مسودة</option>
                </select></div>
            </div>
          </div>

          <div className="card">
            <div className="row">
              <select style={{ width: 240 }} value={adapter} onChange={(e) => setAdapter(e.target.value as any)}>
                <option value="kiss-play">💾 حفظ لمتجر Kiss Play</option>
                <option value="json">⬇️ تنزيل ZIP (لأي مشروع)</option>
              </select>
              <button className="btn-gold" onClick={save} disabled={busy}>{busy ? '…' : adapter === 'json' ? '⬇️ تنزيل' : '💾 حفظ للمتجر'}</button>
            </div>
            {saveMsg && (
              <div className={saveMsg.ok ? 'result-ok' : 'result-err'}>
                {saveMsg.text} {saveMsg.link && <a href={saveMsg.link} target="_blank" rel="noreferrer">فتح المنتج ↗</a>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
