import { CONFIG, branchById, branchByRefCode } from './config.js';

// Hubtel Online Checkout adapter — Ghana cards + mobile money (MTN, Telecel, AirtelTigo).
// Same interface as the Paystack adapter so the rest of the flow is unchanged.
//   docs: https://businessdocs-developers.hubtel.com/docs/api-reference-online-checkout
const HUBTEL_INITIATE = 'https://payproxyapi.hubtel.com/items/initiate';
const HUBTEL_STATUS = 'https://api-txnstatus.hubtel.com/transactions';

export const displayName = 'Hubtel';

function basicAuth({ clientId, clientSecret }) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

// Which Hubtel account collects (and is later queried for) this payment, and the
// credentials that speak for it. A branch that is fully configured collects into
// itself so it can see the money and reconcile locally; anything else — gift
// cards, a partly-configured branch — uses the central online account.
//
// The account and the key travel together, always. Addressing a branch account
// with the central key is not authorised, and Hubtel rejects the pairing.
//
// initiate knows the branch from metadata; the status check only has the
// reference, so it recovers the branch from the code the reference carries
// (NIOBE-<BR4>-...). Both paths MUST resolve the same route: a payment collected
// into a branch but queried against the central account reads back as "not found"
// and the booking would never auto-confirm.
function routeFor({ branchId, reference }) {
  const branch = branchId
    ? branchById(branchId)
    : branchByRefCode(String(reference || '').split('-')[1]);
  if (branch?.hubtelAccount && branch.hubtelClientId && branch.hubtelClientSecret) {
    return {
      account: branch.hubtelAccount,
      clientId: branch.hubtelClientId,
      clientSecret: branch.hubtelClientSecret,
    };
  }
  return {
    account: CONFIG.hubtelMerchantAccount,
    clientId: CONFIG.hubtelClientId,
    clientSecret: CONFIG.hubtelClientSecret,
  };
}

// What the branch sees on its Hubtel transaction list. Without this every line
// reads as an anonymous deposit; with it, the branch and the payer are on the row.
function describe(metadata, reference) {
  const branch = metadata?.branchId ? branchById(metadata.branchId) : null;
  const who = [metadata?.customerName, metadata?.customerPhone].filter(Boolean).join(' ');
  const base = `Niobe ${branch?.name || 'Beauty'} deposit`;
  return `${base}${who ? ` - ${who}` : ''} - ${metadata?.bookingId || reference}`.slice(0, 100);
}

// Create a checkout and return the hosted payment link (checkoutUrl).
// In demo mode this points at our own simulated checkout so the full flow can be
// exercised end-to-end without live keys.
export async function initializeTransaction({ email, amount, reference, metadata, callbackUrl }) {
  if (CONFIG.paymentDemo) {
    const url = `${CONFIG.publicUrl}/demo/checkout?reference=${encodeURIComponent(reference)}`;
    return { authorization_url: url, reference, demo: true };
  }

  const route = routeFor({ branchId: metadata?.branchId });
  const res = await fetch(HUBTEL_INITIATE, {
    method: 'POST',
    headers: { 'Authorization': basicAuth(route), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Hubtel expects the amount as a decimal in GHS (not minor units).
      totalAmount: Number(amount),
      description: describe(metadata, reference),
      callbackUrl: `${CONFIG.publicUrl}/webhook/payment`,   // server-to-server notification
      returnUrl: callbackUrl,                                // browser lands here after paying
      cancellationUrl: CONFIG.publicUrl,
      merchantAccountNumber: route.account,
      clientReference: reference,
      payeeName: metadata?.customerName,
      payeeMobileNumber: metadata?.customerPhone,
      payeeEmail: email,
    }),
  });
  const json = await res.json();
  // Hubtel returns responseCode "0000" on a successfully-created checkout.
  if (json.responseCode !== '0000' || !json.data?.checkoutUrl) {
    throw new Error(json.message || json.status || 'Hubtel initiate failed');
  }
  return { authorization_url: json.data.checkoutUrl, reference: json.data.clientReference || reference };
}

// Confirm a transaction actually succeeded via Hubtel's Transaction Status Check API.
// This is the source of truth — Hubtel callbacks are NOT signed, so we always re-verify here.
export async function verifyTransaction(reference) {
  if (CONFIG.paymentDemo) {
    return { success: true, reference, amount: null, demo: true };
  }
  const route = routeFor({ reference });
  const url = `${HUBTEL_STATUS}/${encodeURIComponent(route.account)}/status?clientReference=${encodeURIComponent(reference)}`;
  const res = await fetch(url, { headers: { 'Authorization': basicAuth(route) } });
  const json = await res.json();
  const data = json.data || {};
  const status = String(data.status || '').toLowerCase();
  return {
    success: json.responseCode === '0000' && (status === 'paid' || status === 'success'),
    reference: data.clientReference || reference,
    amount: data.amount != null ? Number(data.amount) : null,
    raw: data,
  };
}

// Hubtel does not sign webhooks; the security model is to re-verify via the status API,
// which finalizeDeposit() does through verifyTransaction() before confirming anything.
export function verifyWebhookSignature() {
  return true;
}

// Normalise Hubtel's callback payload to { reference, isPaymentSuccess }.
export function parseWebhookEvent(rawBody) {
  let event = {};
  try { event = JSON.parse(rawBody || '{}'); } catch { /* ignore */ }
  const data = event.Data || event.data || {};
  const status = String(data.Status || data.status || '').toLowerCase();
  return {
    reference: data.ClientReference || data.clientReference,
    isPaymentSuccess: (event.ResponseCode || event.responseCode) === '0000'
      && (status === 'paid' || status === 'success'),
  };
}
