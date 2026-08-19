import { CONFIG, branchById } from './config.js';

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

// What a payment is CALLED in Stripe.
//
// The branch reads these lines in the Stripe phone app, and the question they were asking of
// them — "is this the full treatment or only part of it?" — is unanswerable from a pound
// figure, because the pounds were never the price. So the cedi amount, the treatment it is
// paying towards, and whether it settles the lot go into the description itself. The answer
// belongs where the question is being asked, not only in a report they have to go and open.
function describe({ amountGHS, metadata }) {
  const ghs = Math.round((Number(amountGHS) || 0) * 100) / 100;
  const price = Math.round((Number(metadata?.priceGHS) || 0) * 100) / 100;
  const branch = metadata?.branchId ? (branchById(metadata.branchId)?.name || metadata.branchId) : '';
  const who = metadata?.customerName || metadata?.buyerName || '';

  if (metadata?.type === 'giftcard') {
    return {
      dashboard: `Niobe gift card — GHS ${ghs}${who ? ` — bought by ${who}` : ''}`,
      customer: `Niobe Beauty gift card (GHS ${ghs})`,
    };
  }
  // Only claim "full" or "part" when the treatment price is actually known. Guessing here would
  // put a wrong answer in front of the branch with Stripe's authority behind it, which is worse
  // than the silence it replaces.
  const settles = price > 0
    ? (ghs >= price - 0.001 ? `FULL PAYMENT — GHS ${ghs}` : `PART PAYMENT — GHS ${ghs} of GHS ${price}, GHS ${Math.round((price - ghs) * 100) / 100} still to collect`)
    : `GHS ${ghs}`;
  return {
    dashboard: `${settles}${who ? ` — ${who}` : ''}${branch ? ` — ${branch}` : ''}`,
    customer: price > 0 && ghs < price - 0.001
      ? `Niobe Beauty — deposit of GHS ${ghs} towards GHS ${price}`
      : `Niobe Beauty — payment in full (GHS ${ghs})`,
  };
}

// Create a Stripe Checkout Session in the foreign currency and return the hosted pay link.
// In demo mode this points at our own simulated checkout so the full journey (including the
// cedi-equivalent display) can be exercised without live keys.
export async function initializeTransaction({ email, amount, reference, chargeAmount, chargeCurrency, metadata, callbackUrl }) {
  if (CONFIG.paymentDemo) {
    const url = `${CONFIG.publicUrl}/demo/checkout?reference=${encodeURIComponent(reference)}`;
    return { authorization_url: url, reference, demo: true };
  }
  if (!CONFIG.stripeUkSecret) throw new Error('International (Stripe UK) secret key not configured');

  const currency = String(chargeCurrency || CONFIG.intlCurrency || 'GBP').toLowerCase();
  // Stripe amounts are in the smallest currency unit (pence for GBP).
  const unitAmount = Math.round(Number(chargeAmount) * 100);
  if (!(unitAmount > 0)) throw new Error('Invalid international charge amount');

  const desc = describe({ amountGHS: amount, metadata });
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
      'line_items[0][price_data][product_data][name]': desc.customer,
      'metadata[reference]': reference,
      'metadata[bookingId]': metadata?.bookingId || '',
      'metadata[branchId]': metadata?.branchId || '',
      'payment_intent_data[description]': `${desc.dashboard} (${reference})`,
      // Also as structured metadata, so the cedi figures are filterable in the Stripe dashboard
      // and readable by anything else that looks at this account later.
      'metadata[amountGHS]': amount != null ? String(amount) : '',
      'metadata[priceGHS]': metadata?.priceGHS != null ? String(metadata.priceGHS) : '',
      'metadata[customerName]': metadata?.customerName || metadata?.buyerName || '',
      'metadata[paymentType]': metadata?.type || '',
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

// Find the Checkout Session for one of our references.
//
// The map above lives in memory only, so a restart between the customer opening the Stripe page
// and returning from it leaves no session id for a payment that has genuinely been made — and
// this service restarts on every deploy, while a Stripe checkout stays open for 24 hours. That
// window used to end with a customer who has paid being told the payment could not be verified.
// Stripe knows perfectly well which session carries our reference: ask it, rather than treating
// our own forgetfulness as evidence that no money arrived.
async function findSessionId(reference) {
  const known = sessionByRef.get(reference);
  if (known) return known;
  let startingAfter = null;
  for (let page = 0; page < 3; page += 1) {
    const qs = new URLSearchParams({ limit: '100' });
    if (startingAfter) qs.set('starting_after', startingAfter);
    const res = await fetch(`${STRIPE_API}/checkout/sessions?${qs}`, { headers: { Authorization: stripeAuth() } });
    const body = await res.json();
    if (!res.ok || !body.data?.length) return null;
    for (const s of body.data) {
      const ref = s.client_reference_id || s.metadata?.reference;
      if (ref) sessionByRef.set(ref, s.id);   // warm the cache while we are here
    }
    const hit = body.data.find((s) => (s.client_reference_id || s.metadata?.reference) === reference);
    if (hit) return hit.id;
    if (!body.has_more) return null;
    startingAfter = body.data[body.data.length - 1].id;
  }
  return null;
}

// Confirm the payment actually completed by retrieving the Checkout Session from Stripe.
// This is the source of truth — the browser return and any webhook are only triggers.
export async function verifyTransaction(reference) {
  if (CONFIG.paymentDemo) return { success: true, reference, amount: null, demo: true };
  const sessionId = await findSessionId(reference);
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
