import { CONFIG, branchById, branchByRefCode } from './config.js';

// Hubtel Online Checkout adapter — Ghana cards + mobile money (MTN, Telecel, AirtelTigo).
// Same interface as the Paystack adapter so the rest of the flow is unchanged.
//   docs: https://businessdocs-developers.hubtel.com/docs/api-reference-online-checkout
const HUBTEL_INITIATE = 'https://payproxyapi.hubtel.com/items/initiate';
const HUBTEL_STATUS = 'https://api-txnstatus.hubtel.com/transactions';

export const displayName = 'Hubtel';

// The code slot 1 of a gift-card reference (makeGiftRef builds NIOBE-GC-<stamp>).
// Kept here as a named constant because routeFor and giftcards.js must agree on it:
// if the two ever drift, the sale is COLLECTED into one Hubtel account and the status
// QUERIED against another, which reads back "not found" and the card is never issued.
export const GIFTCARD_REF_CODE = 'GC';

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
  // Online gift-card sales settle into their OWN Hubtel account (Niobe, 29 Aug 2026:
  // "Online gift card money should land in 1493"), not a branch and not the central
  // booking account. A gift-card reference is NIOBE-GC-<stamp>, so the code in slot 1
  // is the literal "GC" — the same slot a branch code lives in, which is why this is
  // decided here rather than at the two call sites.
  const refCode = String(reference || '').split('-')[1];
  if (refCode === GIFTCARD_REF_CODE) {
    const gc = [CONFIG.giftcardHubtelAccount, CONFIG.giftcardHubtelClientId, CONFIG.giftcardHubtelClientSecret];
    if (gc.every(Boolean)) {
      return { account: gc[0], clientId: gc[1], clientSecret: gc[2] };
    }
    // Some but not all three set is a MISCONFIGURATION, not a choice. Falling through
    // silently would settle gift-card money into the booking account and nobody would
    // notice until someone reconciled two statements months later. All three empty is
    // deliberate (no separate account yet) and stays quiet.
    if (gc.some(Boolean)) {
      console.log('[hubtel] WARNING gift-card sale is settling into the CENTRAL account:'
        + ' GIFTCARD_HUBTEL_ACCOUNT/CLIENT_ID/CLIENT_SECRET are only partly set.'
        + ' Hubtel authorises the account and the key as a pair — all three are needed.');
    }
  }
  const branch = branchId
    ? branchById(branchId)
    : branchByRefCode(refCode);
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
  // A gift-card sale is not a deposit, and it lands in a different account. Labelling it
  // "deposit" would make the 1493 statement unreconcilable against the booking one.
  if (metadata?.type === 'giftcard') {
    const qty = Number(metadata?.quantity) > 1 ? `${metadata.quantity} x ` : '';
    const who = metadata?.buyerName || '';
    return `Niobe ${qty}gift card${who ? ` - ${who}` : ''} - ${reference}`.slice(0, 100);
  }
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

  // The reference goes in as well as the branch: without it a gift-card sale would be
  // COLLECTED into the central account here and then QUERIED against the gift-card
  // account by verifyTransaction (which only has the reference) — "not found", no card.
  const route = routeFor({ branchId: metadata?.branchId, reference });
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
