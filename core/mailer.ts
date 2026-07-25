// ── Mailer: transactional email via Resend (password reset) ────────────────
// Reads RESEND_API_KEY from env or the DB app_config (admin-editable). Sender
// domain is baw-ai.dev (RESEND_FROM overrides the default).

import { dbConfigured, getConfig } from './db';

async function resendKey(): Promise<string> {
  if (dbConfigured()) { const k = await getConfig('resendKey').catch(() => null); if (k) return k; }
  return process.env.RESEND_API_KEY || '';
}
async function resendFrom(): Promise<string> {
  if (dbConfigured()) { const f = await getConfig('resendFrom').catch(() => null); if (f) return f; }
  return process.env.RESEND_FROM || 'Scraper Pro <no-reply@baw-ai.dev>';
}

export async function sendResetEmail(to: string, resetUrl: string): Promise<{ ok: boolean; error?: string }> {
  const key = await resendKey();
  if (!key) return { ok: false, error: 'RESEND_API_KEY غير مضبوط' };
  const from = await resendFrom();
  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;direction:rtl;text-align:right">
      <h2 style="color:#c8a15a">إعادة تعيين كلمة المرور</h2>
      <p>وصلنا طلب لإعادة تعيين كلمة مرور حسابك في <strong>Scraper Pro</strong>.</p>
      <p>اضغط الزر لتعيين كلمة مرور جديدة (الرابط صالح 30 دقيقة):</p>
      <p><a href="${resetUrl}" style="display:inline-block;background:#c8a15a;color:#111;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">تعيين كلمة مرور جديدة</a></p>
      <p style="color:#888;font-size:13px">إذا ما طلبت هذا، تجاهل الرسالة — ما رح يتغيّر إشي.</p>
    </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from, to: [to], subject: 'إعادة تعيين كلمة المرور — Scraper Pro', html }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); return { ok: false, error: `resend ${r.status}: ${t.slice(0, 140)}` }; }
    return { ok: true };
  } catch (e: any) { return { ok: false, error: String(e?.message) }; }
}
