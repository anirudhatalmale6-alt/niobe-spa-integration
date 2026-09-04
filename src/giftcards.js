import { initializeTransaction, verifyTransaction } from './gateway.js';
import { GIFTCARD_REF_CODE } from './hubtel.js';
import { convertFromGHS } from './fx.js';
import { issueOrder, getCatalog, findItem } from './giftup.js';
import { getOwnCatalog, findOwnItem } from './packages.js';
import { reserveBasket, markPaid, basketCards, mask } from './cards.js';
import { voucherEmail } from './voucher.js';
import { sendEmail } from './notify.js';
import { CONFIG } from './config.js';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Online gift-card SALES. A buyer chooses an amount in GHS and pays through the same rails as
// booking deposits (Hubtel mobile money locally, Stripe in GBP for abroad buyers with the
// live-FX markup). What happens next depends on who is issuing — CONFIG.giftcardIssuer:
//
//   'giftup' — we post an order to GiftUp, which mints the code, holds the balance and emails
//              its own branded voucher. GiftUp is the system of record.
//   'niobe'  — we reserve the cards in our own ledger (cards.js) before the payment starts and
//              mark them paid when it clears. We mint the code, hold the balance and send the
//              voucher. Nothing leaves the building.
//
// Both routes end in the same place from the buyer's point of view, and the READ side is
// unaffected either way: a card is always looked up across all three ledgers, so switching
// issuer never strands a card somebody is already holding.
//
// The order of operations is the same on both routes and is not negotiable: money first, card
// second. The retired site did it the other way round — it wrote the voucher Active and THEN
// asked for a payment link — which is why every abandoned checkout left a spendable card behind.
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const PURCHASES_FILE = join(DATA_DIR, 'gift-purchases.json');

// The money side of an in-flight sale: reference -> record. PERSISTED, because the gap between
// "buyer sent to the payment page" and "callback arrives" can span a restart, and a purchase
// that only lived in memory came back as "Unknown gift-card reference" — i.e. the customer has
// paid and we tell them we have never heard of the order. Mobile money makes that gap minutes
// long, so it is not a rare case.
const purchases = new Map();
function loadPurchases() {
  try {
    const raw = JSON.parse(readFileSync(PURCHASES_FILE, 'utf8'));
    for (const [ref, rec] of Object.entries(raw || {})) purchases.set(ref, rec);
  } catch { /* no file yet, or unreadable — an empty map is the correct starting state */ }
}
function savePurchases() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    // Only what is still in flight. A finished sale is already durable in gift-sales.log and,
    // on the niobe route, in the card ledger — keeping it here forever would grow the file
    // without bound and keep buyers' email addresses long after they are needed for anything.
    const live = {};
    for (const [ref, rec] of purchases) if (rec.status !== 'issued') live[ref] = rec;
    const tmp = `${PURCHASES_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(live, null, 1));
    writeFileSync(PURCHASES_FILE, readFileSync(tmp));
  } catch (e) {
    // Not fatal — the sale can still complete in this process. But say it, because the
    // failure it leads to is silent and lands on a customer who has already paid.
    console.log(`[gift-sale] WARNING could not persist in-flight purchases: ${e.message}`);
  }
}
loadPurchases();
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
  // GIFTCARD_REF_CODE, not a literal "GC": hubtel.js reads this slot back off the
  // reference to decide which merchant account to QUERY, having used it to decide which
  // one to COLLECT into. If the two spellings ever drift, the money goes to 1493 and the
  // status check asks the central account, which answers "not found" — paid, no card.
  return `NIOBE-${GIFTCARD_REF_CODE}-${t}${String(seq).padStart(3, '0')}`;
}

const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());

// Buyer + gift-recipient details, validated. Throws a customer-friendly message on bad input.
function normaliseBuyer({ buyerName, buyerEmail, asGift, recipientName, recipientEmail, message, deliveryDate, delivery }) {
  if (!isEmail(buyerEmail)) throw new Error('Please enter a valid email address for the receipt.');
  const gift = !!asGift && String(asGift) !== 'false';
  // A recipient's email is needed only when WE are the ones emailing them. "I'll print it
  // myself" and "I'll send it on WhatsApp" both mean the buyer does the handing over, and
  // demanding an address there rejects a perfectly good order for a detail the buyer has no
  // reason to know — the exact case Niobe asked about on 3 September.
  const posted = ['email', 'print', 'whatsapp'].includes(delivery) ? delivery : 'email';
  if (gift && posted === 'email' && !isEmail(recipientEmail)) {
    throw new Error('Please enter a valid email address for the person receiving the gift, or choose "I\'ll print it myself".');
  }
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

// The package list, from whichever issuer is in charge. One function so that every caller —
// the checkout page, the price resolver, the tests — asks the same question and cannot end up
// pricing against one catalogue while rendering the other.
export async function giftCatalog() {
  return CONFIG.giftcardIssuer === 'niobe' ? getOwnCatalog() : await getCatalog();
}

// Resolve WHAT is being bought: a chosen package (fixed value, taken from the CATALOGUE rather
// than from the browser so a posted price cannot be tampered with) or a custom amount
// (validated against the min/max). Returns { value, itemId, packageName }.
async function resolveSelection({ itemId, amount }) {
  const catalog = await giftCatalog();
  const find = CONFIG.giftcardIssuer === 'niobe' ? findOwnItem : findItem;
  if (itemId) {
    const item = find(catalog, itemId);
    if (!item) throw new Error('That package is no longer available — please choose another.');
    if (!(Number(item.value) > 0)) throw new Error('That package has no price set — please choose another or a custom amount.');
    return { value: Math.round(Number(item.value) * 100) / 100, itemId: item.id, packageName: item.name };
  }
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt >= CONFIG.giftCardMinAmount)) throw new Error(`The minimum gift card amount is GHS ${CONFIG.giftCardMinAmount}.`);
  if (amt > CONFIG.giftCardMaxAmount) throw new Error(`The maximum gift card amount is GHS ${CONFIG.giftCardMaxAmount}. For larger amounts please contact us.`);
  // On the GiftUp route a free-amount card is attached to the "custom amount" item so it
  // inherits that item's design and terms. We have no such indirection — an amount is an
  // amount — so customItemId is null there and this resolves to no item at all.
  return { value: amt, itemId: catalog.customItemId || null, packageName: null };
}

const money = (n) => Math.round(Number(n) * 100) / 100;

// How many cards this order is for. Comes from the browser and multiplies the amount charged,
// so it is clamped to a whole number in range rather than trusted — a fractional or negative
// quantity would otherwise price the order at a number nobody intended.
export function normaliseQuantity(quantity) {
  const q = Math.floor(Number(quantity));
  if (!Number.isFinite(q) || q < 1) return 1;
  return Math.min(q, CONFIG.giftCardMaxQuantity);
}

// The whole price of a gift-card order, in one place, as a pure function so it can be tested
// and quoted to the customer BEFORE they commit — the same numbers the checkout charges.
//
// Niobe's rules (confirmed 29 Aug 2026): buy 2 or more to be redeemed together and the face
// value is discounted 5%; a 3% service charge then covers processing and site administration.
// Discount first, charge on the discounted subtotal — the same itemisation the old site showed.
// (The total is identical either way, 0.95 x 1.03 == 1.03 x 0.95; only the receipt lines differ.)
export function priceGiftPurchase({ unitValue, quantity = 1 }) {
  const qty = normaliseQuantity(quantity);
  const unit = money(unitValue);
  const subtotal = money(unit * qty);

  const discountPct = qty >= CONFIG.giftCardMultiBuyMinQty ? CONFIG.giftCardMultiBuyDiscountPct : 0;
  const discountGHS = money(subtotal * (discountPct / 100));
  const afterDiscount = money(subtotal - discountGHS);

  const surchargePct = CONFIG.giftCardSurchargePct;
  const feeGHS = money(afterDiscount * (surchargePct / 100));
  const payableGHS = money(afterDiscount + feeGHS);

  // The CARDS keep their full face value — the discount is a reduction in what the buyer hands
  // over, not in what the recipient can spend. Anything else is a card that spends less than
  // the number printed on it.
  return {
    quantity: qty, unitValue: unit, subtotal,
    discountPct, discountGHS, afterDiscount,
    surchargePct, feeGHS, payableGHS,
    faceValueTotal: subtotal,
  };
}

// One basket entry per card, for the own-ledger route. The checkout posts a single selection
// and a quantity, so N cards of the same value go in as N separate records — each with its own
// code, its own balance and its own audit trail, because that is what they are. A "quantity"
// column on one row would mean one code for five cards, and five people cannot hold one code.
function basketItems(p, quantity) {
  const one = {
    amount: p.amount,
    forSelf: !p.gift,
    delivery: p.delivery,
    design: p.design,
    designName: p.designName,
    recipientName: p.recipient.name,
    recipientEmail: p.recipient.email,
    message: p.recipient.message,
    deliverOn: p.deliverOn,
  };
  return Array.from({ length: quantity }, () => ({ ...one }));
}

// Start a gift-card purchase: price it (GHS, or the foreign-currency charge for the abroad rail),
// kick off the payment, and stash the record so finalize can issue the card after payment.
export async function startPurchase(input, preferredGateway) {
  const buyer = normaliseBuyer(input);
  const sel = await resolveSelection(input);
  const quantity = normaliseQuantity(input.quantity);
  const p = {
    ...buyer, amount: sel.value, itemId: sel.itemId, packageName: sel.packageName, quantity,
    // Only meaningful on the own-ledger route — GiftUp takes the design from the item id.
    // Carried on both so the checkout form does not need to know which issuer is live.
    design: String(input.design || '').trim(),
    designName: String(input.designName || '').trim(),
    delivery: ['email', 'print', 'whatsapp'].includes(input.delivery) ? input.delivery : 'email',
    deliverOn: input.deliveryDate || null,
  };

  // On our own route the cards are RESERVED before the payment is even started, and the
  // reservation mints the reference. That ordering is the point: the record of what was
  // ordered exists, on disk, before the buyer can possibly have paid for it. The cards carry
  // no balance and their codes are withheld until markPaid, so an abandoned checkout leaves
  // behind a dead reservation the 48-hour sweep tidies up — never a spendable voucher.
  let reserved = null;
  if (CONFIG.giftcardIssuer === 'niobe') {
    reserved = reserveBasket({
      buyerName: p.buyerName, buyerEmail: p.buyerEmail, buyerPhone: input.buyerPhone,
      items: basketItems(p, quantity), channel: 'web',
    });
  }
  const reference = reserved ? reserved.reference : makeGiftRef();

  // Each card is worth its FACE value (p.amount, GHS); the buyer pays the priced total.
  const price = priceGiftPurchase({ unitValue: p.amount, quantity });
  const { surchargePct, feeGHS, payableGHS, discountPct, discountGHS, subtotal } = price;

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
    metadata: { type: 'giftcard', reference, buyerName: p.buyerName, gift: p.gift, recipientName: p.recipient.name, quantity },
  }, preferredGateway);

  purchases.set(reference, {
    reference, ...p, gateway: init.gateway,
    issuer: CONFIG.giftcardIssuer,   // pinned at the start, not read again at finalize — see below
    surchargePct, feeGHS, payableGHS, discountPct, discountGHS, subtotal,
    chargeAmount: charge.amount, chargeCurrency: charge.currency, chargeRate: charge.rate,
    status: 'pending',
  });
  savePurchases();
  return { authorization_url: init.authorization_url, reference, amount: p.amount, quantity, price, gateway: init.gateway };
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
  savePurchases();

  // Which issuer finishes this sale is the one that STARTED it, not whichever is configured
  // right now. The two can differ: the flag is flipped, or the process restarts with a new
  // setting, while a mobile-money payment is still settling. Reading the live flag here would
  // finish a sale reserved in our own ledger by posting a second order to GiftUp, or call
  // markPaid on a reference that has no cards behind it. The purchase record decides.
  if ((pur.issuer || 'giftup') === 'niobe') return finalizeOwn(reference, pur, v);

  // Payment is authoritative. Issue the card; if GiftUp can't issue right now, we still record the
  // paid sale (never lose the money) and flag it for manual issue rather than failing the customer.
  try {
    const order = await issueOrder({
      value: pur.amount,                         // EACH card's balance = face value (GHS)
      quantity: pur.quantity || 1,               // multi-buy: N cards, each at full face value
      price: pur.payableGHS ?? pur.amount,       // what the buyer actually paid (incl. fee, less any discount)
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
    savePurchases();
    recordGiftSale({ reference, amount: pur.amount, gateway: pur.gateway, issued: false,
      reason: e.message, buyerEmail: pur.buyerEmail, recipient: pur.recipient, at: new Date().toISOString(),
      ...saleFx(pur) });
    return { ok: true, purchase: pur, cards: [], pendingIssue: true };
  }
}

// Finalise on OUR OWN ledger. The payment is already verified by the caller; this is the step
// that turns reserved cards into money.
//
// The shape differs from the GiftUp route in one important way. There, issuing is a network
// call that can fail after the money has arrived, which is why that branch has a
// 'paid_pending_issue' state and a manual queue behind it. Here, issuing is a local write we
// have already done the hard part of — the cards exist, reserved, from before the payment
// started. markPaid cannot half-succeed: it either moves the whole basket to paid or it does
// not, because one payment cannot pay for part of one basket.
async function finalizeOwn(reference, pur, verified) {
  const res = markPaid(reference, {
    paymentRef: verified?.reference || reference,
    method: 'online',
    // Deliberately NOT pur.payableGHS. markPaid reconciles what it is given against the total
    // FACE value of the basket, which is the right check for a staff member marking an offline
    // transfer as paid. It is the wrong check here: an online buyer pays face value plus the 3%
    // service fee, less any multi-buy discount, so handing it payableGHS would log a mismatch on
    // every single sale and the warning would become noise inside a week. The real
    // reconciliation is against what the gateway says it collected, and is done below.
    amountPaid: null,
  });

  if (!res.ok) {
    // The money is real and has arrived; we just cannot find what it was for. That is a
    // person's job, and it must be loud — this is the one failure on this route that leaves a
    // paying customer with nothing.
    pur.status = 'paid_pending_issue';
    savePurchases();
    console.log(`[gift-sale] PAID but the reservation is missing (${res.reason}): ref=${reference}`);
    recordGiftSale({ reference, amount: pur.amount, gateway: pur.gateway, issued: false,
      reason: `own-ledger: ${res.reason}`, buyerEmail: pur.buyerEmail, recipient: pur.recipient,
      at: new Date().toISOString(), ...saleFx(pur) });
    return { ok: true, purchase: pur, cards: [], pendingIssue: true };
  }

  // Reconcile against what the gateway actually collected. Only when the buyer was charged in
  // cedis: on the abroad rail the charge is in GBP, and comparing a pound figure to a cedi one
  // would report a mismatch on every foreign sale while hiding any real one in the noise.
  const collected = verified?.amount;
  if (collected != null && (pur.chargeCurrency || 'GHS') === 'GHS'
      && money(collected) !== money(pur.payableGHS)) {
    console.log(`[gift-sale] AMOUNT MISMATCH ref=${reference} charged=${money(pur.payableGHS)}`
      + ` collected=${money(collected)} — cards issued at face value, reconcile manually`);
  }

  const cards = (res.cards || []).map((c) => ({ code: c.code, value: c.faceValue }));
  pur.status = 'issued';
  pur.cards = cards;
  pur.orderNumber = reference;    // our own ledger has no separate order number; the ref IS it
  savePurchases();
  recordGiftSale({ reference, amount: pur.amount, gateway: pur.gateway, issued: true,
    issuer: 'niobe', cards, orderNumber: reference, alreadyPaid: !!res.alreadyPaid,
    at: new Date().toISOString(), ...saleFx(pur) });

  // Delivery is deliberately AFTER the sale is recorded, and its failure is not the sale's
  // failure. An email that does not send is a card the customer can still be given by hand or
  // read off the confirmation page; a sale that is rolled back because an email bounced is
  // money taken for nothing. So this never throws upward.
  let delivery = { attempted: false };
  if (!res.alreadyPaid) {
    try {
      delivery = await deliverBasket(reference, pur);
    } catch (e) {
      console.log(`[gift-sale] WARNING vouchers not delivered for ${reference}: ${e.message}`);
      delivery = { attempted: true, ok: false, error: e.message };
    }
  }

  return { ok: true, purchase: pur, cards, orderNumber: reference, delivery,
    alreadyIssued: !!res.alreadyPaid };
}

// WHO the voucher is emailed to, and why. Exported and pure so it can be tested on its own —
// this is the decision that, got wrong, sends a surprise present to the person it was meant to
// be a surprise for, and that is not a bug anyone can undo afterwards.
//
// Only an EMAIL delivery to a GIFT goes to the recipient. The other two deliveries are the
// buyer's own copy — "print it myself" and "I'll send it on WhatsApp" both mean the buyer is
// doing the handing over — so they go to the buyer even though a recipient address may well be
// sitting right there on the card.
export function voucherRecipient(card) {
  const toRecipient = card.delivery === 'email' && !!card.gift && !!card.recipientEmail;
  return { toRecipient, to: toRecipient ? card.recipientEmail : card.buyerEmail };
}

// Send the vouchers for a paid basket. Returns a per-card summary rather than a boolean,
// because "some of the five went out" is a real outcome and a boolean would round it to
// either "fine" or "broken" — and staff need to know WHICH one to re-send.
//
// Nothing in here throws: see the caller. A delivery failure is a card that still exists, is
// still paid for and is still readable off the confirmation page.
async function deliverBasket(reference, pur) {
  const cards = basketCards(reference).filter((c) => c.status === 'paid');
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const results = [];

  for (const card of cards) {
    // A future delivery date is an instruction to send it LATER, not a reason never to send
    // it. It is picked up by the scheduled sweep; recorded here so the confirmation page can
    // tell the buyer their gift will arrive on the day they chose rather than implying it has
    // already gone.
    if (card.deliverOn && Date.parse(`${card.deliverOn}T00:00:00Z`) > today.getTime()) {
      results.push({ card: mask(card.code), status: 'scheduled', on: card.deliverOn });
      continue;
    }

    const { to, toRecipient } = voucherRecipient(card);
    if (!to) {
      results.push({ card: mask(card.code), status: 'no_address' });
      continue;
    }

    const mail = voucherEmail({ card, buyerName: pur.buyerName, forSelf: !toRecipient });
    // WhatsApp delivery is not automatic yet — the Business API is still waiting on the new
    // MTN SIM. Until then the buyer gets the voucher to forward, and is told that plainly
    // rather than being left wondering why nothing arrived on WhatsApp.
    const note = card.delivery === 'whatsapp' && !toRecipient
      ? '<p style="font-family:\'Segoe UI\',Helvetica,Arial,sans-serif;font-size:14px;color:#8b7d73">'
        + 'Forward this voucher on WhatsApp to whoever it is for — it is ready to send as it is.</p>'
      : '';

    const r = await sendEmail({ to, subject: mail.subject, html: note + mail.html });
    results.push({
      card: mask(card.code),
      status: r.ok ? 'sent' : 'failed',
      to: toRecipient ? 'recipient' : 'buyer',
      // The ACTUAL address, so the confirmation page can name it rather than working it out
      // again from the order. It gets that wrong for a "print it myself" gift — the order says
      // recipient, the send went to the buyer — and names an empty address to the customer.
      address: to,
      error: r.ok ? undefined : r.error,
    });
    if (!r.ok) {
      // Loud, and with the reference rather than the code — the code is a bearer instrument
      // and must never reach a log file.
      console.log(`[gift-sale] voucher NOT delivered ref=${reference} card=${mask(card.code)} to=${to}: ${r.error}`);
    }
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'no_address').length;
  return { attempted: true, ok: failed === 0, sent, failed,
    scheduled: results.filter((r) => r.status === 'scheduled').length, results };
}

export function getPurchase(reference) { return purchases.get(reference); }

// The cards behind a paid reference, for the confirmation page. Reads the LEDGER rather than
// the purchase record, so a page refreshed after a restart still shows the codes.
export function ownCardsFor(reference) {
  return CONFIG.giftcardIssuer === 'niobe' || purchases.get(reference)?.issuer === 'niobe'
    ? basketCards(reference)
    : [];
}
