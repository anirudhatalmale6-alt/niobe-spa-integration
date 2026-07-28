import { CONFIG } from './config.js';

// expressPay adapter — Ghana cards + mobile money. Same interface as the other adapters
// so it drops straight into the gateway selector as Hubtel's backup.
//   docs: https://expresspaygh.com  (submit.php -> checkout.php -> query.php)
//
// Flow: submit.php returns a `token`; the customer is sent to checkout.php?token=…; the
// payment is later confirmed with query.php (expressPay callbacks are unsigned, so the
// query is the source of truth). query.php needs the token, so we keep reference->token.
const tokens = new Map(); // our reference (order-id) -> expressPay token

export const displayName = 'expressPay';

function form(params) {
  return new URLSearchParams(params).toString();
}

export async function initializeTransaction({ email, amount, reference, metadata, callbackUrl }) {
  if (CONFIG.paymentDemo) {
    tokens.set(reference, `demo-${reference}`);
    const url = `${CONFIG.publicUrl}/demo/checkout?reference=${encodeURIComponent(reference)}`;
    return { authorization_url: url, reference, demo: true };
  }

  const [firstname, ...rest] = String(metadata?.customerName || 'Niobe Customer').split(' ');
  const res = await fetch(`${CONFIG.expresspayBase}/submit.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      'merchant-id': CONFIG.expresspayMerchantId,
      'api-key': CONFIG.expresspayApiKey,
      'firstname': firstname,
      'lastname': rest.join(' ') || '-',
      'email': email,
      'phonenumber': metadata?.customerPhone || '',
      'amount': Number(amount).toFixed(2),
      'order-id': reference,
      'currency': CONFIG.currency,
      'redirect-url': callbackUrl,
      'post-url': `${CONFIG.publicUrl}/webhook/payment`,
    }),
  });
  const json = await res.json();
  if (Number(json.status) !== 1 || !json.token) {
    throw new Error(json['result-text'] || json.message || 'expressPay submit failed');
  }
  tokens.set(reference, json.token);
  return { authorization_url: `${CONFIG.expresspayBase}/checkout.php?token=${encodeURIComponent(json.token)}`, reference };
}

// Confirm via query.php (source of truth). result === 1 means approved/paid.
export async function verifyTransaction(reference) {
  if (CONFIG.paymentDemo) {
    return { success: true, reference, amount: null, demo: true };
  }
  const token = tokens.get(reference);
  if (!token) return { success: false, reference, amount: null, error: 'no token for reference' };
  const res = await fetch(`${CONFIG.expresspayBase}/query.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ 'merchant-id': CONFIG.expresspayMerchantId, 'api-key': CONFIG.expresspayApiKey, token }),
  });
  const json = await res.json();
  const resultText = String(json['result-text'] || '').toLowerCase();
  return {
    success: Number(json.result) === 1 || resultText.includes('approved') || resultText.includes('success'),
    reference: json['order-id'] || reference,
    amount: json.amount != null ? Number(json.amount) : null,
    raw: json,
  };
}

// expressPay does not sign webhooks; verifyTransaction (query.php) is the real gate.
export function verifyWebhookSignature() {
  return true;
}

// expressPay posts back the token + order-id (form-encoded) when payment completes.
export function parseWebhookEvent(rawBody) {
  let data = {};
  try { data = JSON.parse(rawBody || '{}'); } catch { data = Object.fromEntries(new URLSearchParams(rawBody || '')); }
  const reference = data['order-id'] || data.orderId;
  const token = data.token;
  if (reference && token) tokens.set(reference, token); // ensure verify can find the token
  return { reference, isPaymentSuccess: Boolean(reference) };
}
