import { initializeTransaction, verifyTransaction } from './gateway.js';
import { convertFromGHS } from './fx.js';
import { issueOrder, getCatalog, findItem } from './giftup.js';
import { CONFIG } from './config.js';
import { appendFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Online gift-card SALES. A buyer chooses an amount (in GHS — the GiftUp store currency), pays
// through the same rails as booking deposits (Hubtel mobile money locally, Stripe in GBP for
// abroad buyers with the live-FX markup), and on success we issue the real card through GiftUp,
// which generates the code and emails the branded voucher. GiftUp stays the card system-of-record.
const purchases = new Map();     // reference -> purchase record

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
// Durable record of every issued gift card, so a paid sale is never lost.
function recordGiftSale(entry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, 'gift-sales.log'), JSON.stringify(entry) + '\n');
  } catch { /* logging must never break the payment flow */ }
  if (!entry.issued) {
    console.log(`[gift-sale] PAID but NOT issued (${entry.reason || ''}): ref=${entry.reference} amount=${entry.amount}`);
  }
}

// The money side of a sale, written down with the sale itself. `amount` is the card's FACE
// value; `payableGHS` is what the buyer actually handed over (face + service fee) and is the
// figure that has to reconcile against the bank. A buyer abroad pays in pounds, so the rate
// used at that moment is recorded too — it cannot be recovered later, the rate will have moved.
const saleFx = (pur) => ({
  payableGHS: pur.payableGHS ?? null,
  feeGHS: pur.feeGHS ?? null,
  surchargePct: pur.surchargePct ?? null,
  buyerName: pur.buyerName || '',
  buyerEmail: pur.buyerEmail || '',
  chargeAmount: pur.chargeAmount ?? null,
  chargeCurrency: pur.chargeCurrency || 'GHS',
  chargeRate: pur.chargeRate ?? null,
});

let seq = 0;
function makeGiftRef() {
  seq = (seq + 1) % 1000;
  const t = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(2, 14); // YYMMDDHHMMSS
  return `NIOBE-GC-${t}${String(seq).padStart(3, '0')}`;
}

const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());

// Buyer + gift-recipient details, validated. Throws a customer-friendly message on bad input.
function normaliseBuyer({ buyerName, buyerEmail, asGift, recipientName, recipientEmail, message, deliveryDate }) {
  if (!isEmail(buyerEmail)) throw new Error('Please enter a valid email address for the receipt.');
  const gift = !!asGift && String(asGift) !== 'false';
  // If it's a gift, we need the recipient's email to deliver the voucher; otherwise it goes to the buyer.
  if (gift && !isEmail(recipientEmail)) throw new Error('Please enter a valid email address for the person receiving the gift.');
  return {
    buyerName: String(buyerName || '').trim() || 'Niobe customer',
    buyerEmail: String(buyerEmail).trim(),
    gift,
    recipient: gift
      ? {
          name: String(recipientName || '').trim() || 'A special someone',
          email: String(recipientEmail).trim(),
          message: String(message || '').trim(),
        }
      : { name: String(buyerName || '').trim() || 'Niobe customer', email: String(buyerEmail).trim(), message: '' },
    // A future-dated delivery schedules when GiftUp emails the voucher; empty = send now.
    scheduledFor: deliveryDate ? new Date(`${deliveryDate}T09:00:00Z`).toISOString() : null,
  };
}

// Resolve WHAT is being bought: a chosen package (fixed value, taken from GiftUp so it can't be
// tampered with) or a custom amount (validated against the min/max). Returns { value, itemId, packageName }.
async function resolveSelection({ itemId, amount }) {
  if (itemId) {
    const catalog = await getCatalog();
    const item = findItem(catalog, itemId);
    if (!item) throw new Error('That package is no longer available — please choose another.');
    if (!(Number(item.value) > 0)) throw new Error('That package has no price set — please choose another or a custom amount.');
    return { value: Math.round(Number(item.value) * 100) / 100, itemId: item.id, packageName: item.name };
  }
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt >= CONFIG.giftCardMinAmount)) throw new Error(`The minimum gift card amount is GHS ${CONFIG.giftCardMinAmount}.`);
  if (amt > CONFIG.giftCardMaxAmount) throw new Error(`The maximum gift card amount is GHS ${CONFIG.giftCardMaxAmount}. For larger amounts please contact us.`);
  // Use the "custom amount" item so a free-amount card inherits that item's design/terms.
  const catalog = await getCatalog();
  return { value: amt, itemId: catalog.customItemId || null, packageName: null };
}

// Start a gift-card purchase: price it (GHS, or the foreign-currency charge for the abroad rail),
// kick off the payment, and stash the record so finalize can issue the card after payment.
export async function startPurchase(input, preferredGateway) {
  const buyer = normaliseBuyer(input);
  const sel = await resolveSelection(input);
  const p = { ...buyer, amount: sel.value, itemId: sel.itemId, packageName: sel.packageName };
  const reference = makeGiftRef();

  // The card is worth its FACE value (p.amount, GHS). The buyer pays that plus the service fee
  // (covers GiftUp's commission + processing) — a straight surcharge on the GHS amount.
  const surchargePct = CONFIG.giftCardSurchargePct;
  const feeGHS = Math.round(p.amount * (surchargePct / 100) * 100) / 100;
  const payableGHS = Math.round((p.amount + feeGHS) * 100) / 100;

  // Abroad buyers are CHARGED the GBP equivalent of the payable amount (+ FX markup); the card
  // value stays GHS. Locals pay the payable amount in cedis.
  const charge = preferredGateway === 'international'
    ? await convertFromGHS(payableGHS, CONFIG.intlCurrency)
    : { amount: payableGHS, currency: 'GHS' };

  const init = await initializeTransaction({
    email: p.buyerEmail,
    amount: payableGHS,            // Hubtel/expressPay charge this GHS amount (value + fee)
    reference,
    chargeAmount: charge.amount,   // Stripe charges this (GBP) for the abroad rail
    chargeCurrency: charge.currency,
    callbackUrl: `${CONFIG.publicUrl}/gift-card/callback?reference=${encodeURIComponent(reference)}`,
    metadata: { type: 'giftcard', reference, buyerName: p.buyerName, gift: p.gift, recipientName: p.recipient.name },
  }, preferredGateway);

  purchases.set(reference, {
    reference, ...p, gateway: init.gateway,
    surchargePct, feeGHS, payableGHS,
    chargeAmount: charge.amount, chargeCurrency: charge.currency, chargeRate: charge.rate,
    status: 'pending',
  });
  return { authorization_url: init.authorization_url, reference, amount: p.amount, gateway: init.gateway };
}

// Finalise: confirm the payment, then issue the gift card through GiftUp (which emails the voucher).
export async function finalizePurchase(reference) {
  const pur = purchases.get(reference);
  if (!pur) throw new Error('Unknown gift-card reference');
  // The browser return and the Hubtel webhook can both land — never issue twice.
  if (pur.status === 'issued') return { ok: true, purchase: pur, cards: pur.cards, alreadyIssued: true };
  if (pur.status === 'issuing') return { ok: true, purchase: pur, cards: pur.cards || [], inProgress: true };

  const v = await verifyTransaction(reference, pur.gateway);
  // Not confirmed yet (e.g. mobile money still settling) — leave it retryable; the webhook or a
  // later browser refresh will finalise it once the payment clears.
  if (!v.success) { if (pur.status !== 'issued') pur.status = 'pending'; return { ok: false, reason: 'payment_not_confirmed_yet' }; }
  if (pur.status === 'issuing' || pur.status === 'issued') return { ok: true, purchase: pur, cards: pur.cards || [], inProgress: true };
  pur.status = 'issuing';

  // Payment is authoritative. Issue the card; if GiftUp can't issue right now, we still record the
  // paid sale (never lose the money) and flag it for manual issue rather than failing the customer.
  try {
    const order = await issueOrder({
      value: pur.amount,                         // card balance = face value (GHS)
      price: pur.payableGHS ?? pur.amount,       // what the buyer actually paid (incl. service fee)
      itemId: pur.itemId,                        // chosen package (inherits its design) or custom-amount item
      itemName: pur.packageName || undefined,
      purchaserName: pur.buyerName,
      purchaserEmail: pur.buyerEmail,
      recipient: pur.recipient,
      reference,
      scheduledFor: pur.scheduledFor,
      // In demo/test mode we don't want real voucher emails going out.
      sendEmails: !(CONFIG.paymentDemo || CONFIG.giftupTestMode),
    });
    pur.status = 'issued';
    pur.cards = order.cards;
    pur.orderNumber = order.orderNumber;
    pur.downloadLinks = order.downloadLinks;
    recordGiftSale({ reference, amount: pur.amount, gateway: pur.gateway, issued: true,
      cards: order.cards, orderNumber: order.orderNumber, at: new Date().toISOString(),
      ...saleFx(pur) });
    return { ok: true, purchase: pur, cards: order.cards, orderNumber: order.orderNumber, downloadLinks: order.downloadLinks };
  } catch (e) {
    pur.status = 'paid_pending_issue';
    recordGiftSale({ reference, amount: pur.amount, gateway: pur.gateway, issued: false,
      reason: e.message, buyerEmail: pur.buyerEmail, recipient: pur.recipient, at: new Date().toISOString(),
      ...saleFx(pur) });
    return { ok: true, purchase: pur, cards: [], pendingIssue: true };
  }
}

export function getPurchase(reference) { return purchases.get(reference); }
