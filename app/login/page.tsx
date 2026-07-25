'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'login' | 'forgot'>('login');

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setMsg(''); setBusy(true);
    try {
      if (mode === 'forgot') {
        await fetch('/api/auth/request-reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        setMsg('إذا الإيميل مسجّل، رح يوصلك رابط إعادة التعيين خلال دقائق.');
        setBusy(false); return;
      }
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error || 'فشل الدخول'); setBusy(false); return; }
      const raw = new URLSearchParams(location.search).get('next') || '/';
      // only same-origin paths — reject protocol-relative ('//evil') and backslash tricks ('/\evil')
      const next = raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : '/';
      location.href = next;
    } catch (e: any) { setErr(String(e?.message)); setBusy(false); }
  }

  return (
    <div className="authwrap">
      <form className="authcard" onSubmit={submit}>
        <h1>🛒 Scraper <em>Pro</em></h1>
        <p className="hint">{mode === 'login' ? 'سجّل دخولك للمتابعة' : 'اكتب إيميلك لإرسال رابط إعادة التعيين'}</p>
        <label className="f">الإيميل</label>
        <input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        {mode === 'login' && (<>
          <label className="f">كلمة المرور</label>
          <input type="password" dir="ltr" value={pw} onChange={(e) => setPw(e.target.value)} required />
        </>)}
        {err && <div className="result-err">{err}</div>}
        {msg && <div className="result-ok">{msg}</div>}
        <button className="btn-gold" type="submit" disabled={busy} style={{ width: '100%', marginTop: 12 }}>{busy ? '…' : mode === 'login' ? 'دخول' : 'إرسال الرابط'}</button>
        <button type="button" className="linkbtn" onClick={() => { setMode(mode === 'login' ? 'forgot' : 'login'); setErr(''); setMsg(''); }}>
          {mode === 'login' ? 'نسيت كلمة المرور؟' : '← رجوع لتسجيل الدخول'}
        </button>
      </form>
    </div>
  );
}
