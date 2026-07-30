import { initializeTransaction, verifyTransaction } from './gateway.js';
import { convertFromGHS } from './fx.js';
import { issueOrder } from './giftup.js';
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

let seq = 0;
function makeGiftRef() {
  seq = (seq + 1) % 1000;
  const t = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(2, 14); // YYMMDDHHMMSS
  return `NIOBE-GC-${t}${String(seq).padStart(3, '0')}`;
}

const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());

// Validate + normalise the buyer's input. Throws a customer-friendly message on bad input.
function normalisePurchase({ amount, buyerName, buyerEmail, asGift, recipientName, recipientEmail, message, deliveryDate }) {
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt >= CONFIG.giftCardMinAmount)) {
    throw new Error(`The minimum gift card amount is GHS ${CONFIG.giftCardMinAmount}.`);
  }
  if (amt > CONFIG.giftCardMaxAmount) {
    throw new Error(`The maximum gift card amount is GHS ${CONFIG.giftCardMaxAmount}. For larger amounts please contact us.`);
  }
  if (!isEmail(buyerEmail)) throw new Error('Please enter a valid email address for the receipt.');

  const gift = !!asGift && String(asGift) !== 'false';
  // If it's a gift, we need the recipient's email to deliver the voucher; otherwise it goes to the buyer.
  if (gift && !isEmail(recipientEmail)) throw new Error('Please enter a valid email address for the person receiving the gift.');

  return {
    amount: amt,
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

// Start a gift-card purchase: price it (GHS, or the foreign-currency charge for the abroad rail),
// kick off the payment, and stash the record so finalize can issue the card after payment.
export async function startPurchase(input, preferredGateway) {
  const p = normalisePurchase(input);
  const reference = makeGiftRef();

  // The card VALUE is always GHS; abroad buyers are simply CHARGED the GBP equivalent (+ markup).
  const charge = preferredGateway === 'international'
    ? await convertFromGHS(p.amount, CONFIG.intlCurrency)
    : { amount: p.amount, currency: 'GHS' };

  const init = await initializeTransaction({
    email: p.buyerEmail,
    amount: p.amount,
    reference,
    chargeAmount: charge.amount,
    chargeCurrency: charge.currency,
    callbackUrl: `${CONFIG.publicUrl}/gift-card/callback?reference=${encodeURIComponent(reference)}`,
    metadata: { type: 'giftcard', reference, buyerName: p.buyerName, gift: p.gift, recipientName: p.recipient.name },
  }, preferredGateway);

  purchases.set(reference, {
    reference, ...p, gateway: init.gateway,
    chargeAmount: charge.amount, chargeCurrency: charge.currency, chargeRate: charge.rate,
    status: 'pending',
  });
  return { authorization_url: init.authorization_url, reference, amount: p.amount, gateway: init.gateway };
}

// Finalise: confirm the payment, then issue the gift card through GiftUp (which emails the voucher).
export async function finalizePurchase(reference) {
  const pur = purchases.get(reference);
  if (!pur) throw new Error('Unknown gift-card reference');
  if (pur.status === 'issued') return { ok: true, purchase: pur, cards: pur.cards, alreadyIssued: true };

  const v = await verifyTransaction(reference, pur.gateway);
  if (!v.success) { pur.status = 'failed'; return { ok: false, reason: 'payment_not_successful' }; }
  pur.status = 'paid';

  // Payment is authoritative. Issue the card; if GiftUp can't issue right now, we still record the
  // paid sale (never lose the money) and flag it for manual issue rather than failing the customer.
  try {
    const order = await issueOrder({
      value: pur.amount,
      price: pur.amount,                         // card is GHS-valued regardless of how they paid
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
      cards: order.cards, orderNumber: order.orderNumber, at: new Date().toISOString() });
    return { ok: true, purchase: pur, cards: order.cards, orderNumber: order.orderNumber, downloadLinks: order.downloadLinks };
  } catch (e) {
    pur.status = 'paid_pending_issue';
    recordGiftSale({ reference, amount: pur.amount, gateway: pur.gateway, issued: false,
      reason: e.message, buyerEmail: pur.buyerEmail, recipient: pur.recipient, at: new Date().toISOString() });
    return { ok: true, purchase: pur, cards: [], pendingIssue: true };
  }
}

export function getPurchase(reference) { return purchases.get(reference); }
