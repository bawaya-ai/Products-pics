'use client';

import { useEffect, useState } from 'react';

export default function ResetPage() {
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    setToken(q.get('token') || ''); setEmail(q.get('email') || '');
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    if (pw.length < 8) { setErr('٨ أحرف على الأقل'); return; }
    if (pw !== pw2) { setErr('كلمتا المرور غير متطابقتين'); return; }
    setBusy(true);
    const r = await fetch('/api/auth/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: pw }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(d.error || 'فشل'); return; }
    setDone(true);
  }

  return (
    <div className="authwrap">
      <form className="authcard" onSubmit={submit}>
        <h1>🔑 كلمة مرور جديدة</h1>
        {email && <p className="hint" dir="ltr">{email}</p>}
        {done ? (
          <>
            <div className="result-ok">✓ تم تعيين كلمة المرور. تقدر تسجّل دخولك.</div>
            <a className="btn-gold" href="/login" style={{ display: 'block', textAlign: 'center', marginTop: 12 }}>تسجيل الدخول</a>
          </>
        ) : (
          <>
            {!token && <div className="result-err">الرابط ناقص التوكن.</div>}
            <label className="f">كلمة المرور الجديدة</label>
            <input type="password" dir="ltr" value={pw} onChange={(e) => setPw(e.target.value)} required />
            <label className="f">تأكيد كلمة المرور</label>
            <input type="password" dir="ltr" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
            {err && <div className="result-err">{err}</div>}
            <button className="btn-gold" type="submit" disabled={busy || !token} style={{ width: '100%', marginTop: 12 }}>{busy ? '…' : 'حفظ كلمة المرور'}</button>
          </>
        )}
      </form>
    </div>
  );
}
