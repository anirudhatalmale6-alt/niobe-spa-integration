import { CONFIG } from './config.js';

// International rail (Option A) — for customers paying from abroad. Charges the deposit in a
// foreign currency (default GBP) via a UK card checkout that settles into Niobe's UK company
// account; funds are then moved to Ghana as cedis (e.g. via Wise). The customer is shown the
// GHS (cedi) value of their deposit for assurance. Same interface as the other adapters.
//
// Live implementation target: Stripe (UK) Checkout Session in GBP -> UK account. Pending keys,
// the demo simulator exercises the full journey (including the cedi-equivalent display).
export const displayName = 'International Card';

export async function initializeTransaction({ reference }) {
  if (CONFIG.paymentDemo) {
    const url = `${CONFIG.publicUrl}/demo/checkout?reference=${encodeURIComponent(reference)}`;
    return { authorization_url: url, reference, demo: true };
  }
  // TODO(go-live): create a Stripe UK Checkout Session (GBP) with client_reference_id=reference
  // and success_url=callbackUrl; return session.url as authorization_url.
  throw new Error('International (Stripe UK) live keys not configured yet');
}

export async function verifyTransaction(reference) {
  if (CONFIG.paymentDemo) return { success: true, reference, amount: null, demo: true };
  // TODO(go-live): retrieve the Checkout Session / PaymentIntent and confirm payment_status=paid.
  throw new Error('International live verify not configured');
}

// Stripe webhooks are HMAC-signed; wired at go-live. Demo trusts and re-verifies via verifyTransaction.
export function verifyWebhookSignature() {
  return CONFIG.paymentDemo;
}

export function parseWebhookEvent(rawBody) {
  let e = {};
  try { e = JSON.parse(rawBody || '{}'); } catch { /* ignore */ }
  return {
    reference: e?.data?.object?.client_reference_id || e?.data?.reference,
    isPaymentSuccess: e?.type === 'checkout.session.completed',
  };
}
