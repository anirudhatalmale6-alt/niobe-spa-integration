import crypto from 'crypto';
import { CONFIG } from './config.js';

const PAYSTACK_API = 'https://api.paystack.co';

export const displayName = 'Paystack';

// Initialise a transaction and return the hosted payment link (authorization_url).
// In demo mode this points at our own simulated checkout so the full flow can be
// exercised end-to-end without live keys.
export async function initializeTransaction({ email, amount, reference, metadata, callbackUrl }) {
  const amountMinor = Math.round(Number(amount) * 100); // GHS -> pesewas

  if (CONFIG.paymentDemo) {
    const url = `${CONFIG.publicUrl}/demo/checkout?reference=${encodeURIComponent(reference)}`;
    return { authorization_url: url, reference, demo: true };
  }

  const res = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.paystackSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      amount: amountMinor,
      currency: CONFIG.currency,
      reference,
      callback_url: callbackUrl,
      metadata,
    }),
  });
  const json = await res.json();
  if (!json.status) throw new Error(json.message || 'Paystack initialize failed');
  return { authorization_url: json.data.authorization_url, reference: json.data.reference };
}

// Confirm a transaction actually succeeded (called from the callback and as a webhook backstop).
export async function verifyTransaction(reference) {
  if (CONFIG.paymentDemo) {
    return { success: true, reference, amount: null, demo: true };
  }
  const res = await fetch(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { 'Authorization': `Bearer ${CONFIG.paystackSecret}` },
  });
  const json = await res.json();
  if (!json.status) throw new Error(json.message || 'Paystack verify failed');
  return {
    success: json.data.status === 'success',
    reference: json.data.reference,
    amount: json.data.amount / 100,
    raw: json.data,
  };
}

// Verify the x-paystack-signature header on incoming webhooks (HMAC SHA512 of the raw body).
export function verifyWebhookSignature(rawBody, signature) {
  if (CONFIG.paymentDemo) return true;
  if (!CONFIG.paystackSecret) return false;
  const hash = crypto.createHmac('sha512', CONFIG.paystackSecret).update(rawBody).digest('hex');
  return hash === signature;
}

// Normalise a webhook payload to { reference, isPaymentSuccess } (gateway-independent shape).
export function parseWebhookEvent(rawBody) {
  let event = {};
  try { event = JSON.parse(rawBody || '{}'); } catch { /* ignore */ }
  return {
    reference: event?.data?.reference,
    isPaymentSuccess: event?.event === 'charge.success',
  };
}
