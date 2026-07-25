// ── Currency → ILS conversion ──────────────────────────────────────────────
// Live rates from open.er-api.com (no key), cached per warm lambda; falls back to
// static approximate rates if the API is unreachable, so a price is always usable.

const FALLBACK: Record<string, number> = { // <cur> → ILS multiplier (approx)
  USD: 3.7, EUR: 4.0, GBP: 4.7, ILS: 1, SAR: 0.99, AED: 1.01, JOD: 5.2, EGP: 0.075, TRY: 0.11, KWD: 12, CAD: 2.7, AUD: 2.4,
};
const SYMBOLS: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₪': 'ILS', '₺': 'TRY', 'C$': 'CAD', 'A$': 'AUD' };

let cache: { rates: Record<string, number>; at: number } | null = null;
const TTL = 1000 * 60 * 60 * 6; // 6h

/** Normalize a symbol or code → ISO code (USD/EUR/…), or null if unknown. */
export function normalizeCurrency(c: string | null | undefined): string | null {
  if (!c) return null;
  const raw = c.trim();
  if (SYMBOLS[raw]) return SYMBOLS[raw];
  const up = raw.toUpperCase();
  if (/^[A-Z]{3}$/.test(up)) return up;
  return null;
}

async function liveRates(): Promise<Record<string, number> | null> {
  if (cache && Date.now() - cache.at < TTL) return cache.rates;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/ILS', { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const d = (await r.json()) as any;
      if (d?.rates && typeof d.rates.USD === 'number') { cache = { rates: d.rates, at: Date.now() }; return d.rates; }
    }
  } catch { /* fall back */ }
  return null;
}

/** Convert `amount` in `currency` → ILS. Returns { ils, rate, source } or null if unknown currency. */
export async function toILS(amount: number, currency: string): Promise<{ ils: number; rate: number; source: 'live' | 'fallback' } | null> {
  const cur = normalizeCurrency(currency);
  if (!cur || !Number.isFinite(amount) || amount <= 0) return null;
  if (cur === 'ILS') return { ils: Math.round(amount * 100) / 100, rate: 1, source: 'live' };

  const rr = await liveRates();
  if (rr && typeof rr[cur] === 'number' && rr[cur] > 0) {
    // base=ILS → rr[cur] = units of <cur> per 1 ILS, so <cur>→ILS = amount / rr[cur]
    const rate = 1 / rr[cur];
    return { ils: Math.round(amount * rate * 100) / 100, rate, source: 'live' };
  }
  const f = FALLBACK[cur];
  if (f) return { ils: Math.round(amount * f * 100) / 100, rate: f, source: 'fallback' };
  return null;
}
