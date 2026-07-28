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
  return { amount: Math.ceil(buffered * 100) / 100, currency, rate };
}
