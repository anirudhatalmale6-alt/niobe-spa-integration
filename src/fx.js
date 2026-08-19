import { CONFIG } from './config.js';

// Indicative FX so a customer paying from abroad sees the cedi (GHS) value of their deposit
// alongside the amount charged to their card — for assurance. Prices stay defined in GHS
// (the source of truth); this only converts for display + the foreign-currency charge.
// A small buffer covers rate movement between display and settlement so Niobe isn't left short.
const DEMO_RATES = { GBP: 19.0, USD: 15.0, EUR: 17.5 }; // indicative GHS per 1 unit

// GHS per 1 unit of `currency`.
export async function ghsPerUnit(currency) {
  if (!currency || currency === 'GHS') return 1;
  if (CONFIG.paymentDemo) return DEMO_RATES[currency] || 1;
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(currency)}`);
    const json = await res.json();
    if (json?.rates?.GHS) return Number(json.rates.GHS);
  } catch { /* fall back to indicative */ }
  return DEMO_RATES[currency] || 1;
}

// Convert a GHS amount into `currency`, applying the configured buffer. Returns the charge
// amount, the currency, and the rate used (so it can be shown/logged).
export async function convertFromGHS(amountGHS, currency, bufferPct = CONFIG.fxBufferPct) {
  if (!currency || currency === 'GHS') return { amount: Number(amountGHS), currency: 'GHS', rate: 1 };
  const rate = await ghsPerUnit(currency);
  const raw = Number(amountGHS) / rate;
  const buffered = raw * (1 + (Number(bufferPct) || 0) / 100);
  // A percentage buffer cannot cover a FIXED cost. Stripe charges a percentage PLUS 20p per
  // payment, and on a small payment those 20p are a large share of it — at a 7% buffer a
  // GHS 105 gift card keeps only 0.7% for the transfer home, while a GHS 500 deposit keeps
  // 2.9%. FX_FIXED_UPLIFT adds a flat amount in the charge currency so the percentage is left
  // doing only the job it can actually do. Defaults to 0: nothing changes unless it is set.
  const withFixed = buffered + (Number(CONFIG.fxFixedUplift) || 0);
  return {
    amount: Math.ceil(withFixed * 100) / 100,
    currency,
    rate,
    bufferPct: Number(bufferPct) || 0,
    fixedUplift: Number(CONFIG.fxFixedUplift) || 0,
  };
}
