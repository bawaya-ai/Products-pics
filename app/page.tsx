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
interface CrawlItem { manifest: Manifest; saved?: string; savedLink?: string; saving?: boolean; skipped?: boolean }
interface StoreRow { id: number; name: string; base_url: string; category_default: string; is_default: boolean; has_token: boolean }
interface StoreForm { id?: number; name: string; base_url: string; token: string; category_default: string; is_default: boolean }
type CfgState = { providers: Record<string, { set: boolean; source: string }>; dbConfigured: boolean; appPasswordRequired: boolean };

// Destination <select> — hoisted to module scope so its element type is STABLE across Home
// re-renders (a component defined inside Home would remount the <select> on every render,
// dropping focus/open state mid-crawl).
function DestPicker({ destStore, setDestStore, cfg, stores }: { destStore: string; setDestStore: (v: string) => void; cfg: CfgState | null; stores: StoreRow[] }) {
  return (
    <select value={destStore} onChange={(e) => setDestStore(e.target.value)} title="وين ينحفظ؟" style={{ maxWidth: 220 }}>
      <option value="">🏪 الوجهة الافتراضية</option>
      {cfg?.providers?.store?.set && <option value="env">المتجر الأساسي (إعدادات)</option>}
      {stores.map((st) => <option key={st.id} value={String(st.id)}>{st.is_default ? '⭐ ' : ''}{st.name}{!st.has_token ? ' (بدون توكن)' : ''}</option>)}
    </select>
  );
}
const CATEGORIES = ['toys', 'lingerie', 'couples', 'oils-care', 'gifts', 'offers'];
const LS_KEY = 'scraper-pro-settings-v1';
const RESULTS_KEY = 'results-v1';

// ── IndexedDB kv — results can be several MB of base64 images (localStorage would
//    overflow), so persist them here so a page refresh NEVER loses unsaved results.
function idbOpen(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('scraper-pro', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k: string, v: any) {
  const db = await idbOpen();
  return new Promise<void>((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
async function idbGet<T = any>(k: string): Promise<T | null> {
  const db = await idbOpen();
  return new Promise((res) => { const tx = db.transaction('kv', 'readonly'); const rq = tx.objectStore('kv').get(k); rq.onsuccess = () => res(rq.result ?? null); rq.onerror = () => res(null); });
}
async function idbDel(k: string) {
  const db = await idbOpen();
  return new Promise<void>((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = () => res(); tx.onerror = () => res(); });
}

export default function Home() {
  const [settings, setSettings] = useState<ClientSettings>(DEFAULT_SETTINGS);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [logLines, setLogLines] = useState<{ t: string; c?: string }[]>([]);
  const [progress, setProgress] = useState(0);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [crawl, setCrawl] = useState(false);
  const [crawlLimit] = useState(10);
  const [products, setProducts] = useState<CrawlItem[]>([]);
  const [adapter, setAdapter] = useState<'kiss-play' | 'json'>('kiss-play');
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const [cfg, setCfg] = useState<CfgState | null>(null);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState(false);
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [storesErr, setStoresErr] = useState('');
  const [destStore, setDestStore] = useState<string>(''); // '' = default resolution · 'env' = legacy · String(id) = a DB store
  const [storeForm, setStoreForm] = useState<StoreForm>({ name: '', base_url: '', token: '', category_default: 'toys', is_default: false });
  const [savingStore, setSavingStore] = useState(false);
  const [testRows, setTestRows] = useState<Record<string, { status: string; detail: string; balance?: string }>>({});
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showInt, setShowInt] = useState(false);
  const [restored, setRestored] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const appPassHeader = (): Record<string, string> => (settings.appPassword ? { 'x-app-password': settings.appPassword } : {});
  function refreshCfg() {
    fetch('/api/config').then((r) => r.json()).then((d) => setCfg(d)).catch(() => {});
  }
  function refreshStores() {
    fetch('/api/stores').then((r) => r.json()).then((d) => {
      // An errored 200 ({stores:[], error}) means the DB read failed — do NOT wipe the list to
      // "zero stores" (that looks like everything was deleted and invites duplicate re-adds).
      if (d?.error) { setStoresErr('تعذّر تحميل الوجهات — خطأ بقاعدة البيانات. الوجهات المحفوظة لسا موجودة.'); return; }
      setStoresErr(''); setStores(Array.isArray(d?.stores) ? d.stores : []);
    }).catch(() => setStoresErr('تعذّر الاتصال بالسيرفر لتحميل الوجهات.'));
  }

  // ── store destinations (add / edit / default / delete) ──
  async function saveStore() {
    if (!storeForm.name.trim() || !storeForm.base_url.trim() || savingStore) return;
    setSavingStore(true);
    try {
      const r = await fetch('/api/stores', { method: 'POST', headers: { 'Content-Type': 'application/json', ...appPassHeader() }, body: JSON.stringify({ store: storeForm }) });
      if (r.status === 401) { setTestRows({ _auth: { status: 'fail', detail: 'كلمة سر الأداة غلط — ما قدرنا نحفظ المتجر' } }); setSavingStore(false); return; }
      if (!r.ok) { const e = await r.json().catch(() => ({})); setTestRows({ _err: { status: 'fail', detail: e.error || `HTTP ${r.status}` } }); setSavingStore(false); return; }
      setStoreForm({ name: '', base_url: '', token: '', category_default: 'toys', is_default: false });
      refreshStores();
    } catch (e: any) { setTestRows({ _err: { status: 'fail', detail: String(e?.message) } }); }
    setSavingStore(false);
  }
  const editStore = (st: StoreRow) => setStoreForm({ id: st.id, name: st.name, base_url: st.base_url, token: '', category_default: st.category_default, is_default: st.is_default });
  async function makeDefaultStore(st: StoreRow) {
    const r = await fetch('/api/stores', { method: 'POST', headers: { 'Content-Type': 'application/json', ...appPassHeader() }, body: JSON.stringify({ store: { id: st.id, name: st.name, base_url: st.base_url, category_default: st.category_default, is_default: true } }) }).catch(() => null);
    if (!r) { setTestRows({ _err: { status: 'fail', detail: 'تعذّر الاتصال بالسيرفر' } }); return; }
    if (r.status === 401) { setTestRows({ _auth: { status: 'fail', detail: 'كلمة سر الأداة غلط — ما قدرنا نغيّر الافتراضي' } }); return; }
    if (!r.ok) { const e = await r.json().catch(() => ({})); setTestRows({ _err: { status: 'fail', detail: e.error || `HTTP ${r.status}` } }); return; }
    refreshStores();
  }
  async function removeStore(st: StoreRow) {
    if (!window.confirm(`حذف المتجر "${st.name}"؟`)) return;
    const r = await fetch(`/api/stores?id=${st.id}`, { method: 'DELETE', headers: { ...appPassHeader() } });
    if (r.status === 401) { setTestRows({ _auth: { status: 'fail', detail: 'كلمة سر الأداة غلط' } }); return; }
    refreshStores();
    if (destStore === String(st.id)) setDestStore('');
  }
  // Save prefs to the browser AND push any newly-typed keys to the server (encrypted at rest).
  async function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch {}
    const keys: Record<string, string> = {};
    for (const [k, v] of Object.entries(keyDraft)) if (v && v.trim()) keys[k] = v.trim();
    if (Object.keys(keys).length) {
      setSavingKeys(true);
      try {
        const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', ...appPassHeader() }, body: JSON.stringify({ keys }) });
        if (r.status === 401) { setTestRows({ _auth: { status: 'fail', detail: 'كلمة سر الأداة غلط — ما قدرنا نحفظ على السيرفر' } }); setSavingKeys(false); return; }
        if (!r.ok) { const e = await r.json().catch(() => ({})); setTestRows({ _err: { status: 'fail', detail: e.error || `HTTP ${r.status}` } }); setSavingKeys(false); return; }
        setKeyDraft({}); refreshCfg();
      } catch (e: any) { setTestRows({ _err: { status: 'fail', detail: String(e?.message) } }); setSavingKeys(false); return; }
      setSavingKeys(false);
    }
    setSaved(true); setTimeout(() => setSaved(false), 2500);
  }

  useEffect(() => {
    try { const raw = localStorage.getItem(LS_KEY); if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) }); } catch {}
    refreshCfg();
    refreshStores();
    // restore unsaved results after a refresh (kept in IndexedDB)
    idbGet<any>(RESULTS_KEY).then((r) => {
      if (r && (r.manifest || (r.products && r.products.length))) {
        if (r.manifest) setManifest(r.manifest);
        if (r.products) setProducts(r.products);
        setRestored(true);
      }
    }).catch(() => {});
  }, []);

  // persist results so a refresh before saving never loses them
  useEffect(() => {
    if (manifest || products.length) idbSet(RESULTS_KEY, { manifest, products, ts: Date.now() }).catch(() => {});
    else idbDel(RESULTS_KEY).catch(() => {});
  }, [manifest, products]);
  function clearResults() { setManifest(null); setProducts([]); setRestored(false); idbDel(RESULTS_KEY).catch(() => {}); }

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
  // saved source per provider from the server config: 'db' (UI-editable) | 'env' (legacy) | 'none'
  const savedSource = (id: string): 'db' | 'env' | 'none' => {
    const st = cfg?.providers?.[id];
    return st?.set ? (st.source as 'db' | 'env') : 'none';
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
      const map: Record<string, { status: string; detail: string; balance?: string }> = {};
      for (const row of d.rows || []) map[row.provider] = { status: row.status, detail: row.detail, balance: row.balance };
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

  // Stream one /api/scrape call; push progress to the log; resolve with the manifest.
  async function scrapeUrl(u: string, tag = '', settingsOverride?: ClientSettings): Promise<Manifest | null> {
    let manifestOut: Manifest | null = null;
    const pre = tag ? `${tag} ` : '';
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(settings.appPassword ? { 'x-app-password': settings.appPassword } : {}) },
        body: JSON.stringify({ url: u, settings: settingsOverride || settings }),
      });
      if (!res.ok || !res.body) { pushLog(`${pre}HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`, 'err'); return null; }
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
          let e: ProgressEvent; try { e = JSON.parse(line); } catch { continue; }
          if (e.type === 'stage') { if (e.detail) pushLog(`${pre}— ${e.detail}`); if (e.stage === 'enrich' || e.stage === 'curate') setProgress(82); }
          else if (e.type === 'image') {
            setProgress(10 + Math.round(((e.index + (e.status === 'done' ? 1 : 0.4)) / e.total) * 65));
            if (e.status === 'done') pushLog(`${pre}✓ صورة ${e.index + 1}/${e.total} — ${e.detail}`, 'ok');
            else if (e.status === 'failed') pushLog(`${pre}✗ صورة ${e.index + 1}/${e.total} — ${e.detail}`, 'err');
          }
          else if (e.type === 'warn') pushLog(`${pre}⚠ ${e.message}`, 'warn');
          else if (e.type === 'error') { pushLog(`${pre}✗ ${e.message}`, 'err'); setProgress(0); }
          else if (e.type === 'result') { manifestOut = e.manifest; setProgress(100); }
        }
      }
    } catch (e: any) { pushLog(`${pre}✗ ${e?.message}`, 'err'); }
    return manifestOut;
  }

  async function run() {
    if (!url.trim() || busy) return;
    if (crawl) return runCrawl();
    setBusy(true); setManifest(null); setProducts([]); setSaveMsg(null); setLogLines([]); setProgress(4); setRestored(false);
    pushLog('▶ بدأنا…');
    const m = await scrapeUrl(url.trim());
    if (m) { setManifest(m); pushLog('✓ جاهز للمعاينة', 'ok'); }
    setBusy(false);
  }

  // Crawl a listing: discover product urls, then scrape each into a product list.
  async function runCrawl() {
    setBusy(true); setManifest(null); setProducts([]); setSaveMsg(null); setLogLines([]); setProgress(2); setRestored(false);
    pushLog('▶ زحف على القائمة — بكتشف روابط المنتجات…');
    try {
      const dres = await fetch('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(settings.appPassword ? { 'x-app-password': settings.appPassword } : {}) },
        body: JSON.stringify({ url: url.trim(), settings, limit: crawlLimit }),
      });
      if (dres.status === 401) { pushLog('كلمة سر الأداة غلط', 'err'); setBusy(false); return; }
      const d = await dres.json();
      (d.warnings || []).forEach((w: string) => pushLog(`⚠ ${w}`, 'warn'));
      const urls: string[] = (d.productUrls || []).slice(0, crawlLimit);
      if (!urls.length) { pushLog('✗ ما لقيت روابط منتجات بالصفحة — جرّب رابط قائمة/تصنيف فيه منتجات.', 'err'); setBusy(false); return; }
      pushLog(`🔎 لقيت ${urls.length} منتج — عم أسحبهن…`, 'ok');
      const acc: CrawlItem[] = [];
      for (let i = 0; i < urls.length; i++) {
        pushLog(`— (${i + 1}/${urls.length}) ${urls[i].replace(/^https?:\/\/[^/]+/, '')}`);
        const m = await scrapeUrl(urls[i], `[${i + 1}/${urls.length}]`, { ...settings, maxImages: Math.max(settings.maxImages || 8, 5) });
        if (m && m.images.length) {
          acc.push({ manifest: m }); setProducts([...acc]);
          if (m.images.filter((i2) => i2.role !== 'skip').length < 3) pushLog(`  ⚠ منتج ${i + 1} طلع بأقل من 3 صور (المصدر ما فيه أكتر)`, 'warn');
        }
      }
      pushLog(`✓ خلص — ${acc.length}/${urls.length} منتج جاهز.`, 'ok');
      setProgress(100);
    } catch (e: any) { pushLog(`✗ ${e?.message}`, 'err'); }
    setBusy(false);
  }

  const setRole = (id: string, role: MediaRole) =>
    setManifest((m) => m && { ...m, images: m.images.map((i) => (i.id === id ? { ...i, role } : role === 'main' && i.role === 'main' ? { ...i, role: 'angle' } : i)) });
  const setField = (path: 'name' | 'description', lang: 'en' | 'ar' | 'he', v: string) =>
    setManifest((m) => m && { ...m, [path]: { ...m[path], [lang]: v } });

  async function postSave(m: Manifest): Promise<{ ok: boolean; productId?: string; productUrl?: string; error?: string }> {
    const storeId = destStore === '' ? undefined : destStore === 'env' ? 'env' : Number(destStore);
    try {
      const r = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...appPassHeader() },
        body: JSON.stringify({ manifest: m, adapter: 'kiss-play', settings, storeId }),
      });
      return await r.json();
    } catch (e: any) { return { ok: false, error: e?.message }; }
  }

  async function save() {
    if (!manifest || busy) return;
    setBusy(true); setSaveMsg(null);
    if (adapter === 'json') { await downloadZip(manifest); setBusy(false); return; }
    const d = await postSave(manifest);
    setSaveMsg(d.ok ? { ok: true, text: `✓ انحفظ بالمتجر — ${d.productId}`, link: d.productUrl } : { ok: false, text: `فشل الحفظ: ${d.error || 'خطأ'}` });
    setBusy(false);
  }

  // ── Crawl-product edits + saves ──
  const patchProduct = (idx: number, fn: (m: Manifest) => Manifest) =>
    setProducts((ps) => ps.map((p, i) => (i === idx ? { ...p, manifest: fn(p.manifest) } : p)));
  const setPName = (idx: number, v: string) => patchProduct(idx, (m) => ({ ...m, name: { ...m.name, ar: v } }));
  const setPCat = (idx: number, v: string) => patchProduct(idx, (m) => ({ ...m, category: v }));
  const setPPrice = (idx: number, v: string) => patchProduct(idx, (m) => ({ ...m, price: { ...m.price, amount: v ? +v : null } }));
  const setPRole = (idx: number, imgId: string, role: MediaRole) =>
    patchProduct(idx, (m) => ({ ...m, images: m.images.map((i) => (i.id === imgId ? { ...i, role } : role === 'main' && i.role === 'main' ? { ...i, role: 'angle' } : i)) }));
  const skipProduct = (idx: number) => setProducts((ps) => ps.map((p, i) => (i === idx ? { ...p, skipped: !p.skipped } : p)));

  async function saveProduct(idx: number) {
    const p = products[idx];
    if (!p || p.saving || p.saved) return;
    setProducts((ps) => ps.map((x, i) => (i === idx ? { ...x, saving: true } : x)));
    const d = await postSave(p.manifest);
    setProducts((ps) => ps.map((x, i) => (i === idx ? { ...x, saving: false, saved: d.ok ? d.productId : undefined, savedLink: d.productUrl, ...(d.ok ? {} : {}) } : x)));
    if (!d.ok) pushLog(`✗ حفظ منتج ${idx + 1}: ${d.error || 'خطأ'}`, 'err');
  }

  async function saveAllProducts() {
    if (busy) return;
    setBusy(true);
    for (let i = 0; i < products.length; i++) {
      if (products[i].skipped || products[i].saved) continue;
      await saveProduct(i);
    }
    setBusy(false);
  }

  // slug for a clean folder name per product
  function slugify(s: string, fallback = 'product') {
    const base = (s || '').normalize('NFKD').replace(/[^\w؀-ۿ\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 50);
    return base || fallback;
  }
  function descriptionMd(m: Manifest): string {
    const t = m.tags?.length ? m.tags.join(' · ') : '—';
    const price = m.price.amount ? `₪${m.price.amount}` : '—';
    return [
      `# ${m.name.ar || m.name.en || m.pageTitle}`, '',
      `**Name (EN):** ${m.name.en || '—'}`,
      `**שם (HE):** ${m.name.he || '—'}`,
      `**السعر:** ${price}   ·   **القسم:** ${m.category}`,
      `**الوسوم:** ${t}`, '',
      '## الوصف (عربي)', m.description.ar || '—', '',
      '## Description (EN)', m.description.en || '—', '',
      '## תיאור (HE)', m.description.he || '—', '',
      '---', `المصدر: ${m.sourceUrl}`, `عدد الصور: ${m.images.filter((i) => i.role !== 'skip').length}`, '',
    ].join('\n');
  }
  // add one product as a tidy folder: main/angle/detail images + description.md + manifest.json
  function addProductFolder(zip: any, m: Manifest, folderName: string) {
    const f = zip.folder(folderName)!;
    const kept = m.images.filter((i) => i.role !== 'skip');
    let a = 0, d = 0;
    kept.forEach((img) => {
      const ext = img.dataUrl.includes('image/png') ? 'png' : 'webp';
      const name = img.role === 'main' ? `main.${ext}` : img.role === 'detail' ? `detail-${++d}.${ext}` : `angle-${++a}.${ext}`;
      f.file(name, img.dataUrl.split(',')[1], { base64: true });
    });
    f.file('description.md', descriptionMd(m));
    f.file('manifest.json', JSON.stringify({ ...m, images: kept.map(({ dataUrl, ...rest }) => rest) }, null, 2));
  }

  async function downloadZip(m: Manifest) {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    addProductFolder(zip, m, slugify(m.name.en || m.name.ar));
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slugify(m.name.en || m.name.ar)}.zip`;
    a.click();
    setSaveMsg({ ok: true, text: '✓ تنزّل مجلد المنتج (صور + description.md + manifest.json)' });
  }

  // one ZIP, a folder per crawled product
  async function downloadAllProducts() {
    const items = products.filter((p) => !p.skipped);
    if (!items.length) return;
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const used = new Set<string>();
    items.forEach((p, i) => {
      let name = slugify(p.manifest.name.en || p.manifest.name.ar, `product-${i + 1}`);
      while (used.has(name)) name = `${name}-${i + 1}`;
      used.add(name);
      addProductFolder(zip, p.manifest, name);
    });
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `products-${items.length}.zip`;
    a.click();
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
            {busy ? '… شغّال' : crawl && /^https?:\/\//i.test(url.trim()) ? '📑 اسحب كل المنتجات' : /^https?:\/\//i.test(url.trim()) ? '🚀 معالجة' : '🔎 بحث ومعالجة'}
          </button>
        </div>
        <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, cursor: 'pointer', color: crawl ? 'var(--gold)' : 'var(--muted)' }}>
            <input type="checkbox" checked={crawl} onChange={(e) => setCrawl(e.target.checked)} style={{ width: 'auto' }} />
            🌐 زحف على دومين: اعطِ دومين أو رابط متجر → تلاقي {crawlLimit} منتجات وتسحب كل واحد لحاله
          </label>
        </div>
        <div className="hint" style={{ marginTop: 4 }}>
          {crawl
            ? 'اعطِ دومين (lelo.com) أو رابط متجر/تصنيف — الأداة بتلاقي صفحات المنتجات لحالها، بتفتح كل منتج، وتسحب صوره (≥3) + الوصف + السعر بمجلد باسمه.'
            : 'الصق رابط منتج (تيمو/أي موقع)، أو اكتب اسم منتج للبحث بالصور، أو فعّل الزحف على دومين لسحب متجر كامل.'}
        </div>
        {(busy || progress > 0) && <div className="bar"><i style={{ width: `${progress}%` }} /></div>}
        {logLines.length > 0 && (
          <div className="log" ref={logRef}>
            {logLines.map((l, i) => <div key={i} className={l.c}>{l.t}</div>)}
          </div>
        )}
      </div>

      {/* ── Integrations panel ── */}
      <div className="card">
        <div className="ihead ihead-toggle" onClick={() => setShowInt((v) => !v)}>
          <strong>🧩 التكاملات <span className="imini">· {PROVIDERS.filter((p) => savedSource(p.id) !== 'none').length}/{PROVIDERS.length} مضبوطة</span></strong>
          <span className="itoggle">{showInt ? '▲ إخفاء' : '⚙️ إعداد'}</span>
        </div>
        {showInt && (<>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
          <button className="btn-ghost" onClick={testKeys} disabled={testing} style={{ padding: '8px 16px' }}>{testing ? '… يفحص' : '🔌 فحص + رصيد'}</button>
          <button className="btn-gold" onClick={saveSettings} disabled={savingKeys} style={{ padding: '8px 18px' }}>{savingKeys ? '… يحفظ' : '💾 حفظ على السيرفر'}</button>
        </div>
        {saved && <div className="result-ok">✓ انحفظ · المفاتيح تُخزَّن مشفّرة على السيرفر (DB) وما بتضيع بين الأجهزة/الجلسات.</div>}
        {cfg && !cfg.dbConfigured && <div className="result-err">⚠ تخزين السيرفر غير مفعّل (DATABASE_URL مفقود) — المفاتيح رح تبقى بالبيئة فقط.</div>}
        {(testRows._auth || testRows._err) && <div className="result-err">{testRows._auth?.detail || testRows._err?.detail}</div>}

        {[
          { title: '🔎 البحث عن الصور', rows: [
            { id: 'firecrawl', label: 'Firecrawl', fields: [{ k: 'firecrawlKey', ph: 'fc-…' }], hint: 'بحث بالاسم · معرض كامل · زحف على القوائم' },
            { id: 'googleCse', label: 'Google CSE', fields: [{ k: 'googleCseKey', ph: 'AIza…' }, { k: 'googleCseCx', ph: 'cx (معرّف المحرّك)', type: 'text' }], hint: 'بديل للبحث — محجوب على مؤسستك حاليًا' },
          ] },
          { title: '✂️ إزالة الخلفية', rows: [
            { id: 'replicate', label: 'Replicate', fields: [{ k: 'replicateKey', ph: 'r8_…' }], hint: 'أعلى جودة قصّ (اختياري)' },
            { id: 'removebg', label: 'remove.bg', fields: [{ k: 'removebgKey', ph: '…' }], hint: 'اختياري · المجاني المحلي شغّال بدون مفتاح' },
          ] },
          { title: '🧠 الذكاء — اسم/وصف/اختيار الصور', rows: [
            { id: 'anthropic', label: 'Anthropic · Claude', fields: [{ k: 'anthropicKey', ph: 'sk-ant-…' }], hint: 'الأساسي' },
            { id: 'openai', label: 'OpenAI', fields: [{ k: 'openaiKey', ph: 'sk-…' }], hint: 'بديل' },
          ] },
          { title: '🏪 المتجر — حفظ المنتجات', rows: [
            { id: 'store', label: 'المتجر', fields: [{ k: 'storeBase', ph: 'https://…workers.dev', type: 'text' }, { k: 'storeToken', ph: 'Import Token' }], hint: 'رابط الـAPI + توكن الاستيراد' },
          ] },
        ].map((g) => (
          <div key={g.title} className="igroup">
            <div className="igtitle">{g.title}</div>
            {g.rows.map((r) => {
              const src = savedSource(r.id);
              const hasDraft = r.fields.some((f: any) => ((keyDraft[f.k] || '').trim()));
              const t = testRows[r.id]?.status;
              const bal = testRows[r.id]?.balance;
              const cls = t === 'ok' ? 'ok' : t === 'fail' ? 'err' : src !== 'none' ? 'server' : hasDraft ? 'browser' : 'none';
              const mark = t === 'ok' ? '✓ فعّال' : t === 'fail' ? '✗ فشل'
                : src === 'db' ? '☁ سيرفر' : src === 'env' ? '☁ بيئة' : hasDraft ? '✎ غير محفوظ' : '— ناقص';
              return (
                <div key={r.id} className="irow">
                  <div className="ilabel">
                    <span>{r.label}</span>
                    <span className={`chip ${cls}`} title={testRows[r.id]?.detail || ''}>{mark}</span>
                    {bal ? <span className="chip bal" title="الرصيد المتبقّي">💳 {bal}</span> : null}
                  </div>
                  <div className="ifields">
                    {r.fields.map((f: any) => (
                      <input key={f.k} type={f.type === 'text' ? 'text' : 'password'} dir="ltr"
                        placeholder={src !== 'none' ? '•••••••• محفوظ — اكتب للتغيير' : f.ph}
                        value={keyDraft[f.k] ?? ''} onChange={(e) => setKeyDraft((d) => ({ ...d, [f.k]: e.target.value }))} />
                    ))}
                  </div>
                  <div className="hint">{r.hint}</div>
                </div>
              );
            })}
          </div>
        ))}

        {/* Multiple save destinations (stores) */}
        <div className="igroup">
          <div className="igtitle">🏬 وجهات الحفظ — متاجر متعددة</div>
          {storesErr && <div className="result-err">⚠ {storesErr}</div>}
          {stores.length > 0 && (
            <div className="storelist">
              {stores.map((st) => (
                <div key={st.id} className="storerow">
                  <div className="storemeta">
                    <strong>{st.is_default ? '⭐ ' : ''}{st.name}</strong>
                    <span className="hint" dir="ltr">{st.base_url}</span>
                    <span className={`chip ${st.has_token ? 'server' : 'none'}`}>{st.has_token ? '🔑 توكن محفوظ' : '— بدون توكن'}</span>
                  </div>
                  <div className="storeacts">
                    {!st.is_default && <button className="btn-ghost" onClick={() => makeDefaultStore(st)} title="اجعله الوجهة الافتراضية">⭐</button>}
                    <button className="btn-ghost" onClick={() => editStore(st)} title="تعديل">✏️</button>
                    <button className="btn-ghost" onClick={() => removeStore(st)} title="حذف">🗑</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="storeform">
            <div className="igtitle" style={{ fontSize: 13, marginTop: 8 }}>{storeForm.id ? '✏️ تعديل متجر' : '➕ إضافة متجر جديد'}</div>
            <div className="ifields">
              <input type="text" placeholder="اسم المتجر (مثلاً: Kiss Play)" value={storeForm.name} onChange={(e) => setStoreForm((f) => ({ ...f, name: e.target.value }))} />
              <input type="text" dir="ltr" placeholder="https://…workers.dev" value={storeForm.base_url} onChange={(e) => setStoreForm((f) => ({ ...f, base_url: e.target.value }))} />
              <input type="password" dir="ltr" placeholder={storeForm.id ? '•••• التوكن محفوظ — اكتب للتغيير' : 'Import Token'} value={storeForm.token} onChange={(e) => setStoreForm((f) => ({ ...f, token: e.target.value }))} />
            </div>
            <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
              <select value={storeForm.category_default} onChange={(e) => setStoreForm((f) => ({ ...f, category_default: e.target.value }))}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <label className="f" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                <input type="checkbox" checked={storeForm.is_default} onChange={(e) => setStoreForm((f) => ({ ...f, is_default: e.target.checked }))} /> الوجهة الافتراضية
              </label>
              <button className="btn-gold" onClick={saveStore} disabled={savingStore || !storeForm.name.trim() || !storeForm.base_url.trim()} style={{ padding: '8px 16px' }}>{savingStore ? '… يحفظ' : storeForm.id ? '💾 حدّث المتجر' : '➕ أضف المتجر'}</button>
              {storeForm.id && <button className="btn-ghost" onClick={() => setStoreForm({ name: '', base_url: '', token: '', category_default: 'toys', is_default: false })} style={{ padding: '8px 14px' }}>إلغاء</button>}
            </div>
            {cfg && !cfg.dbConfigured && <div className="hint">⚠ يلزم تخزين السيرفر (DATABASE_URL) لإدارة متاجر متعددة.</div>}
          </div>
        </div>

        <div className="igroup">
          <div className="igtitle">🎛️ الإخراج والخيارات</div>
          <div className="ioptions">
            <div><label className="f">إزالة الخلفية</label>
              <select value={settings.bgMode} onChange={(e) => upd({ bgMode: e.target.value })}>
                <option value="auto">تلقائي (الأفضل)</option><option value="local">مجاني محلي</option>
                <option value="replicate">Replicate</option><option value="removebg">remove.bg</option><option value="off">بدون</option>
              </select></div>
            <div><label className="f">حجم موحّد</label>
              <select value={settings.size} onChange={(e) => upd({ size: +e.target.value })}>{[800, 1024, 1500].map((v) => <option key={v} value={v}>{v}×{v}</option>)}</select></div>
            <div><label className="f">الصيغة</label>
              <select value={settings.format} onChange={(e) => upd({ format: e.target.value as any })}><option value="webp">WebP</option><option value="png">PNG</option></select></div>
            <div><label className="f">أقصى صور</label>
              <input type="number" min={1} max={12} value={settings.maxImages} onChange={(e) => upd({ maxImages: +e.target.value })} /></div>
            <div><label className="f">كلمة سر الأداة</label>
              <input type="password" dir="ltr" value={settings.appPassword} onChange={(e) => upd({ appPassword: e.target.value })} /></div>
          </div>
        </div>
        </>)}
      </div>

      {restored && (manifest || products.length > 0) && (
        <div className="card" style={{ borderColor: 'var(--gold)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <span style={{ color: 'var(--gold)', fontSize: 14 }}>↩ استرجعنا نتائج جلستك السابقة (ما ضاعت بالرفرش). احفظها للمتجر أو نزّلها قبل ما تبلّش جديد.</span>
          <button className="btn-ghost" onClick={clearResults} style={{ padding: '6px 14px' }}>🗑 امسح وابدأ جديد</button>
        </div>
      )}

      {/* Crawl results — one card per product */}
      {products.length > 0 && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <strong>🧺 منتجات مسحوبة: {products.length} {busy ? '(عم يكمّل…)' : ''}</strong>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-ghost" onClick={downloadAllProducts} disabled={products.every((p) => p.skipped)} style={{ padding: '9px 16px' }}>⬇️ تنزيل الكل (مجلدات)</button>
              <DestPicker destStore={destStore} setDestStore={setDestStore} cfg={cfg} stores={stores} />
              <button className="btn-gold" onClick={saveAllProducts} disabled={busy || products.every((p) => p.saved || p.skipped)} style={{ padding: '9px 18px' }}>💾 حفظ الكل بالمتجر</button>
            </div>
          </div>
          <div className="pgrid">
            {products.map((p, idx) => {
              const kept = p.manifest.images.filter((i) => i.role !== 'skip');
              return (
                <div key={idx} className="pcard" style={p.skipped ? { opacity: 0.4 } : {}}>
                  <div className="pthumbs">
                    {p.manifest.images.map((img) => (
                      <div key={img.id} className={`pt ${img.role === 'main' ? 'pt-main' : ''}`} style={img.role === 'skip' ? { opacity: 0.35 } : {}}>
                        <img src={img.dataUrl} alt="" />
                        <select value={img.role} onChange={(e) => setPRole(idx, img.id, e.target.value as MediaRole)}>
                          <option value="main">⭐</option><option value="angle">زاوية</option><option value="detail">تفصيل</option><option value="skip">🗑</option>
                        </select>
                      </div>
                    ))}
                  </div>
                  <input type="text" value={p.manifest.name.ar} onChange={(e) => setPName(idx, e.target.value)} placeholder="اسم المنتج" style={{ marginTop: 6 }} />
                  <div className="row" style={{ marginTop: 6 }}>
                    <input type="number" value={p.manifest.price.amount ?? ''} onChange={(e) => setPPrice(idx, e.target.value)} placeholder="₪ سعر" style={{ width: 90 }} />
                    <select value={p.manifest.category} onChange={(e) => setPCat(idx, e.target.value)} style={{ flex: 1 }}>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="row" style={{ marginTop: 7 }}>
                    {p.saved ? (
                      <span className="chip ok" style={{ flex: 1 }}>✓ محفوظ {p.savedLink && <a href={p.savedLink} target="_blank" rel="noreferrer">فتح ↗</a>}</span>
                    ) : (
                      <>
                        <button className="btn-primary" onClick={() => saveProduct(idx)} disabled={p.saving || p.skipped} style={{ flex: 1, padding: '8px' }}>{p.saving ? '…' : '💾 حفظ'}</button>
                        <button className="btn-ghost" onClick={() => skipProduct(idx)} style={{ padding: '8px 12px' }}>{p.skipped ? '↩' : '🗑'}</button>
                      </>
                    )}
                  </div>
                  <div className="hint" style={{ marginTop: 4, direction: 'ltr', textAlign: 'left' }}>{kept.length} صورة · {kept[0] ? kept[0].bgProvider : ''}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Preview + edit (single) */}
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
              <select style={{ width: 200 }} value={adapter} onChange={(e) => setAdapter(e.target.value as any)}>
                <option value="kiss-play">💾 حفظ لمتجر</option>
                <option value="json">⬇️ تنزيل ZIP (لأي مشروع)</option>
              </select>
              {adapter === 'kiss-play' && <DestPicker destStore={destStore} setDestStore={setDestStore} cfg={cfg} stores={stores} />}
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
