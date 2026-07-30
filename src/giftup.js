import { CONFIG } from './config.js';

// GiftUp! gift-card rail. GiftUp hosts the gift-card storefront (the SELLING side); this module
// only handles the REDEMPTION side — a customer securing a booking with a GiftUp gift card
// instead of paying an online deposit. We READ a card (validate + check balance) and REDEEM
// against it, and can UNDO a redemption if a booking is later cancelled.
//
// Zero-dependency: talks to GiftUp's REST API directly. Auth (from the GiftUp dashboard) is a
// Bearer JWT; test-mode operations add the x-giftup-testmode header. The gift cards are
// Currency-backed in GHS (same currency as Niobe deposits), so redemption is a straight GHS deduct.
const GIFTUP_API = 'https://api.giftup.app';

function headers(extra = {}) {
  const h = {
    'Authorization': `bearer ${CONFIG.giftupKey}`,
    'Accept': 'application/json',
    ...extra,
  };
  // Lets Niobe exercise the flow against test cards without touching real balances.
  if (CONFIG.giftupTestMode) h['x-giftup-testmode'] = 'true';
  return h;
}

// Retrieve a single gift card by its code and normalise the fields we rely on.
// Returns { found, valid, code, title, balance, backingType, canBeRedeemed, expired, voided, raw }.
// `valid` = the card exists and can actually be used to secure a booking right now.
export async function validateCard(code) {
  if (!CONFIG.giftupKey) throw new Error('GiftUp API key not configured');
  const c = String(code || '').trim();
  if (!c) return { found: false, valid: false, reason: 'no_code' };

  const res = await fetch(`${GIFTUP_API}/gift-cards/${encodeURIComponent(c)}`, { headers: headers() });
  if (res.status === 404) return { found: false, valid: false, code: c, reason: 'not_found' };
  const g = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(g?.message || `GiftUp lookup failed (${res.status})`);

  const balance = g.remainingValue != null ? Number(g.remainingValue) : null;
  const valid = !!g.canBeRedeemed && !g.hasExpired && !g.isVoided && (balance == null || balance > 0);
  return {
    found: true,
    valid,
    code: g.code || c,
    title: g.title || '',
    balance,
    backingType: g.backingType,          // 'Currency' for GHS-value cards
    canBeRedeemed: !!g.canBeRedeemed,
    expired: !!g.hasExpired,
    voided: !!g.isVoided,
    raw: g,
  };
}

// Redeem `amount` (in the card's currency — GHS for Niobe) against the card.
// Keep the reference so the redemption is traceable to the booking on the GiftUp ledger.
// Returns { transactionId, redeemedAmount, remainingCredit }. transactionId is needed to undo.
export async function redeem(code, amount, { reason, reference, locationId, metadata } = {}) {
  if (!CONFIG.giftupKey) throw new Error('GiftUp API key not configured');
  const c = String(code || '').trim();
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!c) throw new Error('Gift card code required');
  if (!(amt > 0)) throw new Error('Invalid redeem amount');

  const body = {
    amount: amt,
    units: null,
    reason: reason || (reference ? `Niobe booking ${reference}` : 'Niobe booking deposit'),
    locationId: locationId || null,
    redeemedOn: null,
    metadata: { ...(reference ? { reference } : {}), ...(metadata || {}) },
  };
  const res = await fetch(`${GIFTUP_API}/gift-cards/${encodeURIComponent(c)}/redeem`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(r?.message || `GiftUp redeem failed (${res.status})`);
  return {
    transactionId: r.transactionId,
    redeemedAmount: r.redeemedAmount != null ? Number(r.redeemedAmount) : amt,
    remainingCredit: r.remainingCredit != null ? Number(r.remainingCredit) : null,
    raw: r,
  };
}

// Issue a NEW gift card by creating a GiftUp order. Payment has already been collected by us
// (Stripe for abroad, Hubtel for local), so this just records the sale and lets GiftUp generate
// the code + email the branded voucher (unless sendEmails=false, e.g. while testing). value/price
// are in the card's currency (GHS — the GiftUp store currency). Returns { orderId, orderNumber,
// cards:[{code,value}], downloadLinks }. `reference` is stamped as externalPaymentId for reconciliation.
export async function issueOrder({
  value, price, purchaserName, purchaserEmail, recipient, reference,
  sku, itemName, sendEmails = true, scheduledFor,
} = {}) {
  if (!CONFIG.giftupKey) throw new Error('GiftUp API key not configured');
  const v = Math.round(Number(value) * 100) / 100;
  if (!(v > 0)) throw new Error('Invalid gift card value');
  const cost = price != null ? Number(price) : v;

  const body = {
    orderDate: new Date().toISOString(),
    disableAllEmails: !sendEmails,
    purchaserName: purchaserName || recipient?.name || 'Niobe customer',
    purchaserEmail: purchaserEmail || recipient?.email || undefined,
    revenue: cost,
    itemDetails: [{
      quantity: 1,
      name: itemName || 'Niobe Beauty Gift Card',
      backingType: 'Currency',
      price: cost,
      value: v,
      sku: sku || `NIOBE-GC-${v}`,
    }],
    recipientDetails: {
      recipientName: recipient?.name || purchaserName || 'Niobe customer',
      recipientEmail: recipient?.email || purchaserEmail,
      message: recipient?.message || '',
      scheduledFor: scheduledFor || null,
      fulfilmentMethod: 'Email',
    },
    metadata: reference ? { externalPaymentId: reference } : {},
  };

  const res = await fetch(`${GIFTUP_API}/orders`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(r?.message || `GiftUp order create failed (${res.status})`);

  const cards = Array.isArray(r.giftCards)
    ? r.giftCards.map((g) => ({ code: g.code, value: g.initialValue != null ? Number(g.initialValue) : v }))
    : [];
  return { orderId: r.orderId || r.id, orderNumber: r.orderNumber, cards, downloadLinks: r.downloadLinks || [], raw: r };
}

// Reverse a redemption (e.g. the booking was cancelled) using the transactionId from redeem().
export async function undoRedemption(code, transactionId, { reason, metadata } = {}) {
  if (!CONFIG.giftupKey) throw new Error('GiftUp API key not configured');
  const c = String(code || '').trim();
  if (!c || !transactionId) throw new Error('Gift card code and transactionId required');

  const res = await fetch(`${GIFTUP_API}/gift-cards/${encodeURIComponent(c)}/undo-redemption`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ transactionId, reason: reason || 'Booking cancelled', metadata: metadata || {} }),
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(r?.message || `GiftUp undo-redemption failed (${res.status})`);
  return {
    transactionId: r.transactionId,
    amountReversed: r.amountReversed != null ? Number(r.amountReversed) : null,
    remainingCredit: r.remainingCredit != null ? Number(r.remainingCredit) : null,
    raw: r,
  };
}
