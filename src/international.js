import { CONFIG } from './config.js';

// International rail (Option A) — for customers paying from abroad. Charges the deposit in a
// foreign currency (default GBP) via Stripe Checkout that settles into Niobe's UK account;
// funds are then moved to Ghana as cedis. The customer is shown the GHS (cedi) value of their
// deposit for assurance. Same interface as the other adapters (Hubtel/expressPay), so the rest
// of the flow (bookings.js / gateway.js / server.js) is unchanged.
//
// Zero-dependency: talks to Stripe's REST API directly (form-encoded, Bearer auth) — no SDK.
export const displayName = 'International Card';

const STRIPE_API = 'https://api.stripe.com/v1';

// Stripe Checkout Sessions can only be retrieved by their session id, and Stripe has no lookup
// by client_reference_id. We keep a small reference -> session-id map so verifyTransaction can
// re-check the payment against Stripe (the source of truth). This mirrors the in-memory payment
// record the rest of the flow already relies on during a live payment window.
const sessionByRef = new Map();

function stripeAuth() {
  return `Bearer ${CONFIG.stripeUkSecret}`;
}

// Stripe expects application/x-www-form-urlencoded with bracketed nested keys.
function formEncode(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// Create a Stripe Checkout Session in the foreign currency and return the hosted pay link.
// In demo mode this points at our own simulated checkout so the full journey (including the
// cedi-equivalent display) can be exercised without live keys.
export async function initializeTransaction({ email, reference, chargeAmount, chargeCurrency, metadata, callbackUrl }) {
  if (CONFIG.paymentDemo) {
    const url = `${CONFIG.publicUrl}/demo/checkout?reference=${encodeURIComponent(reference)}`;
    return { authorization_url: url, reference, demo: true };
  }
  if (!CONFIG.stripeUkSecret) throw new Error('International (Stripe UK) secret key not configured');

  const currency = String(chargeCurrency || CONFIG.intlCurrency || 'GBP').toLowerCase();
  // Stripe amounts are in the smallest currency unit (pence for GBP).
  const unitAmount = Math.round(Number(chargeAmount) * 100);
  if (!(unitAmount > 0)) throw new Error('Invalid international charge amount');

  const desc = `Niobe Beauty deposit${metadata?.branchId ? ` — ${metadata.branchId}` : ''}`;
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: { 'Authorization': stripeAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode({
      mode: 'payment',
      // Stripe returns the browser here after paying; finalizeDeposit re-verifies via the API.
      success_url: callbackUrl,
      cancel_url: CONFIG.publicUrl,
      client_reference_id: reference,
      customer_email: email || undefined,
      'line_items[0][quantity]': 1,
      'line_items[0][price_data][currency]': currency,
      'line_items[0][price_data][unit_amount]': unitAmount,
      'line_items[0][price_data][product_data][name]': desc,
      'metadata[reference]': reference,
      'metadata[bookingId]': metadata?.bookingId || '',
      'metadata[branchId]': metadata?.branchId || '',
      'payment_intent_data[description]': `${desc} (${reference})`,
      'payment_intent_data[metadata][reference]': reference,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.url) {
    throw new Error(json?.error?.message || 'Stripe checkout session create failed');
  }
  sessionByRef.set(reference, json.id);
  return { authorization_url: json.url, reference, sessionId: json.id };
}

// Confirm the payment actually completed by retrieving the Checkout Session from Stripe.
// This is the source of truth — the browser return and any webhook are only triggers.
export async function verifyTransaction(reference) {
  if (CONFIG.paymentDemo) return { success: true, reference, amount: null, demo: true };
  const sessionId = sessionByRef.get(reference);
  if (!sessionId) return { success: false, reference, amount: null, reason: 'no_session_for_reference' };

  const res = await fetch(`${STRIPE_API}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { 'Authorization': stripeAuth() },
  });
  const s = await res.json();
  if (!res.ok) throw new Error(s?.error?.message || 'Stripe session retrieve failed');
  return {
    success: s.payment_status === 'paid' || (s.status === 'complete' && s.payment_status !== 'unpaid'),
    reference: s.client_reference_id || reference,
    amount: s.amount_total != null ? Number(s.amount_total) / 100 : null,
    currency: (s.currency || '').toUpperCase() || undefined,
    raw: s,
  };
}

// Stripe signs webhooks, but our security model (like Hubtel) is to always re-verify the payment
// against Stripe's API in verifyTransaction() before confirming anything — so a forged webhook
// can never confirm an unpaid booking. We accept the notification and let verifyTransaction judge.
export function verifyWebhookSignature() {
  return true;
}

export function parseWebhookEvent(rawBody) {
  let e = {};
  try { e = JSON.parse(rawBody || '{}'); } catch { /* ignore */ }
  const obj = e?.data?.object || {};
  const reference = obj.client_reference_id || obj?.metadata?.reference || e?.data?.reference;
  // Learn the session id from the event so a webhook-driven verify works even if this process
  // didn't create the session (e.g. after a restart). Only Checkout Session events carry it.
  if (reference && obj.id && String(obj.object) === 'checkout.session') sessionByRef.set(reference, obj.id);
  return {
    reference,
    isPaymentSuccess: e?.type === 'checkout.session.completed'
      && (obj.payment_status === 'paid' || obj.payment_status == null),
  };
}
