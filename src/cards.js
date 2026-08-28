import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { CONFIG } from './config.js';
import { validateCard as validateGiftUpCard } from './giftup.js';
import { lookupSimpleSpaCard } from './sscards.js';

// Niobe's OWN gift-card ledger — the system of record for cards sold on the new site,
// replacing GiftUp for new sales. GiftUp and SimpleSpa cards already in customers'
// hands stay valid and are read live; nothing issued in the past is invalidated.
//
// This module exists because of a specific defect in the site as it stands today. Their
// checkout wrote the voucher with Status 'Active' and THEN asked the payment gateway for
// a checkout link; the payment callback only ever ran on success, and only stamped the
// transaction id — it never touched Status, because Status was already what it should
// have been at the end. Every abandoned or failed checkout therefore left a fully
// redeemable voucher behind, and the code had already been handed to the buyer's browser.
//
// So, two rules run through everything below:
//
//   1. A card is created in the state that is TRUE RIGHT NOW — `reserved`. It carries no
//      balance and cannot be redeemed. Only money moves it to `paid`.
//   2. The code is not emitted to anybody — not the page, not an email, not a JSON
//      response the buyer "shouldn't" read — until that payment is confirmed.
//
// The 48-hour cancellation Niobe asked for is the cleanup for the leftovers of rule 1:
// people who reach checkout and never pay. It is NOT the same thing as the card's own
// 90-day expiry, and the two must never be conflated — one kills an order nobody paid
// for, the other retires value somebody did pay for.
//
// THE 90-DAY EXPIRY (Niobe's policy, confirmed 28 Aug):
//   - A card is valid for 90 days from PURCHASE — the day the money arrived — not from
//     the day it is delivered. Otherwise a distant delivery date silently buys extra
//     validity, and delivery is chosen by the buyer.
//   - Delivery can therefore be scheduled at most 7 days out. Any further and the gift
//     arrives having already eaten a chunk of its own life.
//   - 14 days before expiry the holder is reminded, with a booking link — Niobe's
//     customers complain about phoning to book and not getting through, so a reminder
//     that says "ring the branch" is the reminder that gets ignored.
//   - Expiry can be extended by 30 days for GHS 200, per card. That is a paid change to
//     a bearer instrument, so it needs a payment reference or a named member of staff;
//     it can never be applied by accident.
//
// Expiry is evaluated FROM THE DATE on every read, never trusted to have been written by
// the sweep. A background job that is stopped, crashed or an hour behind must not be the
// reason an expired card can still be spent.

// Overridable so the test suite can exercise the real lifecycle against a throwaway
// directory. Testing money code against the live ledger is how a test run ends up
// cancelling a customer's reservation.
const DATA_DIR = process.env.NIOBE_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const LEDGER_FILE = join(DATA_DIR, 'gift-cards.json');

// How long an unpaid reservation is held before it is cancelled, and how long before
// that the buyer is nudged. Configurable because "48 hours" is a business decision, not
// a technical one — but the nudge must always land before the cancellation, so it is
// derived rather than set independently.
export const RESERVE_HOURS = Number(process.env.GIFTCARD_RESERVE_HOURS || 48);
export const REMIND_HOURS = Math.max(1, Math.round(RESERVE_HOURS / 2));

// The card's own life, all business decisions, all overridable without a code change.
export const VALID_DAYS = Number(process.env.GIFTCARD_VALID_DAYS || 90);
export const MAX_DELIVERY_DAYS = Number(process.env.GIFTCARD_MAX_DELIVERY_DAYS || 7);
export const EXPIRY_REMIND_DAYS = Number(process.env.GIFTCARD_EXPIRY_REMIND_DAYS || 14);
export const EXTENSION_DAYS = Number(process.env.GIFTCARD_EXTENSION_DAYS || 30);
export const EXTENSION_FEE_GHS = Number(process.env.GIFTCARD_EXTENSION_FEE_GHS || 200);

const STATUS = {
  RESERVED: 'reserved',    // checkout started, no money yet, code withheld
  PAID: 'paid',            // money confirmed, code released, balance live
  EXPIRED: 'expired',      // paid, unspent, and past its 90 days — value forfeited
  CANCELLED: 'cancelled',  // reservation lapsed or was cancelled — permanently dead
  VOIDED: 'voided',        // a paid card withdrawn by staff (refund, error, fraud)
};

const DAY_MS = 24 * 3600 * 1000;
const addDays = (iso, days) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

// The single source of truth for "is this card past its date", used by every read and
// every spend. The sweep only ever MATERIALISES what this already says — so a stalled
// sweep can delay a reminder email, but it can never let expired value be spent.
export function isExpired(card, now = new Date()) {
  if (!card || card.status !== STATUS.PAID) return card?.status === STATUS.EXPIRED;
  if (!card.expiresAt) return false;
  return now.getTime() >= Date.parse(card.expiresAt);
}
export function daysLeft(card, now = new Date()) {
  if (!card?.expiresAt) return null;
  return Math.ceil((Date.parse(card.expiresAt) - now.getTime()) / DAY_MS);
}
export { STATUS };

// --- persistence -------------------------------------------------------------
// Same discipline as the hold registry and the redemption ledger: state that guards a
// real-world side effect (money on a bearer instrument) cannot live only in the process.
// A restart between "payment confirmed" and "card redeemed" must not lose the card.
let ledger = {};          // code -> card record
let byReference = {};     // payment reference -> code   (rebuilt on load, not persisted)

function reindex() {
  byReference = {};
  for (const card of Object.values(ledger)) {
    if (card.reference) byReference[card.reference] = card.code;
  }
}
function loadLedger() {
  try {
    const raw = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
    if (raw && typeof raw === 'object') ledger = raw;
  } catch { ledger = {}; }
  reindex();
}
function saveLedger() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    // Write-then-rename, so a crash mid-write cannot leave a truncated ledger behind.
    // Losing this file loses every card Niobe has sold.
    const tmp = `${LEDGER_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger, null, 1));
    writeFileSync(LEDGER_FILE, readFileSync(tmp));
  } catch (e) {
    // Refusing loudly is the point: an unpersisted paid card is a customer holding a
    // code the business has no record of.
    console.log(`[gift-cards] WARNING could not persist ledger: ${e.message}`);
    throw new Error('Could not save the gift card. Please try again.');
  }
}
loadLedger();

function auditLog(entry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, 'gift-cards.log'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* logging must never break the customer flow */ }
}

// Never write a full gift-card code to a log or a page. It is a bearer instrument —
// anyone who reads it can spend it.
export const mask = (code) => {
  const c = String(code || '').trim();
  return c.length <= 4 ? '••••' : `${'•'.repeat(Math.max(4, c.length - 4))}${c.slice(-4)}`;
};

// --- codes -------------------------------------------------------------------
// No 0/O/1/I/L — these get read off a printed voucher and typed in at a front desk by
// someone who did not choose the font. Ambiguity here costs a phone call per card.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode() {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    if (i && i % 4 === 0) out += '-';
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `NB-${out}`;                      // NB-XXXX-XXXX-XXXX
}

// A collision would silently merge two customers' money into one card, so generate
// against the ledger rather than trusting the odds.
function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = randomCode();
    if (!ledger[c]) return c;
  }
  throw new Error('Could not allocate a gift card code');
}

let seq = 0;
function newReference() {
  seq = (seq + 1) % 1000;
  const t = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(2, 14);   // YYMMDDHHMMSS
  return `NIOBE-GC-${t}${String(seq).padStart(3, '0')}`;
}

// --- validation --------------------------------------------------------------
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());
const money = (n) => Math.round(Number(n) * 100) / 100;

const MIN_VALUE = Number(process.env.GIFTCARD_MIN_GHS || 50);
const MAX_VALUE = Number(process.env.GIFTCARD_MAX_GHS || 20000);

function normaliseItem(item, index) {
  const value = money(item.amount ?? item.value);
  if (!(value >= MIN_VALUE)) throw new Error(`Gift card ${index + 1}: the smallest amount is GHS ${MIN_VALUE}.`);
  if (!(value <= MAX_VALUE)) throw new Error(`Gift card ${index + 1}: the largest amount is GHS ${MAX_VALUE}. Please contact us for a larger gift.`);

  const gift = item.forSelf === true || String(item.forSelf) === 'true' ? false : true;
  // A gift needs somewhere to go. Delivery by print/PDF is legitimate and needs no
  // recipient address — the buyer prints it — so only an EMAIL delivery demands one.
  const delivery = ['email', 'print', 'whatsapp'].includes(item.delivery) ? item.delivery : 'email';
  if (delivery === 'email' && gift && !isEmail(item.recipientEmail)) {
    throw new Error(`Gift card ${index + 1}: please enter a valid email address for the person receiving it, or choose "print it myself".`);
  }
  return {
    value,
    design: String(item.design || '').trim() || 'default',
    designName: String(item.designName || '').trim(),
    delivery,
    gift,
    recipientName: String(item.recipientName || '').trim(),
    recipientEmail: String(item.recipientEmail || '').trim(),
    recipientPhone: String(item.recipientPhone || '').trim(),
    message: String(item.message || '').trim().slice(0, 500),
    // A future date schedules delivery; empty means send as soon as it is paid for.
    // Never used to gate the card's validity — a card is spendable from the moment it is
    // paid for, whatever date the buyer chose to have it delivered. It cannot EXTEND the
    // validity either: the 90 days run from purchase, which is why the window is capped.
    deliverOn: normaliseDeliverOn(item.deliverOn, index),
  };
}

// Delivery may be scheduled up to MAX_DELIVERY_DAYS ahead — beyond that the recipient
// opens a gift that has already spent part of its own 90 days, and the complaint lands
// on the branch. A date in the past is a typo, not an instruction to send it late.
function normaliseDeliverOn(raw, index) {
  if (!raw) return null;
  const day = String(raw).slice(0, 10);
  // Compared at midnight, i.e. whole days. Parsing this at a time of day would make
  // "seven days ahead" fail by a few hours depending on when the order was placed.
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`Gift card ${index + 1}: that delivery date is not a valid date.`);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  if (t < today.getTime()) throw new Error(`Gift card ${index + 1}: the delivery date has already passed.`);
  const latest = today.getTime() + MAX_DELIVERY_DAYS * DAY_MS;
  if (t > latest) {
    throw new Error(`Gift card ${index + 1}: delivery can be scheduled up to ${MAX_DELIVERY_DAYS} days ahead. The card is valid for ${VALID_DAYS} days from today, so a later delivery would shorten the time your recipient has to use it.`);
  }
  return day;
}

// --- reserve -----------------------------------------------------------------
// ONE basket, MANY cards, ONE payment — Niobe's "group purchases". Each card in the
// basket is its own record with its own amount, design, recipient and message, and they
// share a single payment reference. Either they all become paid or none of them do:
// a part-paid basket is not a state the money can produce, because it is one charge.
export function reserveBasket({ buyerName, buyerEmail, buyerPhone, items, channel = 'web' }) {
  if (!isEmail(buyerEmail)) throw new Error('Please enter a valid email address for your receipt.');
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) throw new Error('Please choose at least one gift card.');
  if (list.length > 50) throw new Error('Please split an order of more than 50 gift cards — contact us and we will arrange it.');

  const normalised = list.map(normaliseItem);   // validate ALL before writing ANY
  const reference = newReference();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESERVE_HOURS * 3600 * 1000);

  const cards = normalised.map((item) => {
    const code = newCode();
    const card = {
      code,
      status: STATUS.RESERVED,
      faceValue: item.value,
      // A reserved card holds NO value. Balance is money, and no money has arrived.
      balance: 0,
      currency: 'GHS',
      reference,
      buyerName: String(buyerName || '').trim() || 'Niobe customer',
      buyerEmail: String(buyerEmail).trim(),
      buyerPhone: String(buyerPhone || '').trim(),
      ...item,
      createdAt: now.toISOString(),
      // Deadline for the RESERVATION, not for the card. Cleared when it is paid, and
      // replaced by expiresAt — the card's own 90 days. Two different clocks, never
      // stored in the same field, because confusing them is how an unpaid order gets
      // 90 days of life or a paid card dies in 48 hours.
      reserveExpiresAt: expiresAt.toISOString(),
      remindedAt: null,
      expiresAt: null,
      expiryRemindedAt: null,
      extensions: [],
      paidAt: null,
      payment: null,
      transactions: [],
    };
    ledger[code] = card;
    byReference[reference] = code;   // any one of the basket's codes finds the basket
    return card;
  });

  saveLedger();
  auditLog({ event: 'reserved', reference, count: cards.length, total: money(cards.reduce((s, c) => s + c.faceValue, 0)), buyerEmail: cards[0].buyerEmail });

  return {
    reference,
    total: money(cards.reduce((s, c) => s + c.faceValue, 0)),
    currency: 'GHS',
    expiresAt: expiresAt.toISOString(),
    // Deliberately NO codes. The caller renders a payment page, not a voucher.
    // Anything that needs a code needs a paid card, and can ask for it then.
    count: cards.length,
  };
}

export function basketCards(reference) {
  return Object.values(ledger).filter((c) => c.reference === reference);
}

// --- payment confirmation ----------------------------------------------------
// The ONLY route from reserved to paid, and the only place a balance is ever created.
// Called from the gateway callback and from the staff "mark as paid" button — offline
// bank transfers are a real payment method here and must not be a second code path.
//
// Idempotent: a gateway that retries its callback (they all do) must not issue twice or
// email twice. Returns { alreadyPaid: true } so the caller can stay quiet on a repeat.
export function markPaid(reference, { paymentRef, method = 'online', amountPaid = null, by = null } = {}) {
  const cards = basketCards(reference);
  if (!cards.length) return { ok: false, reason: 'unknown_reference' };

  const paid = cards.filter((c) => c.status === STATUS.PAID);
  if (paid.length === cards.length) {
    // Wrapped, not passed bare: Array.map hands the INDEX as the second argument, which
    // publicCard reads as `now`. Bare `.map(publicCard)` dates every card to 1970.
    return { ok: true, alreadyPaid: true, cards: paid.map((c) => publicCard(c)) };
  }

  // A cancelled reservation that then pays is not an error to swallow — the money is
  // real and has arrived. Revive it rather than leaving a customer paid-up with nothing;
  // the log line is what tells staff it happened.
  const revived = cards.filter((c) => c.status === STATUS.CANCELLED);
  if (revived.length) {
    console.log(`[gift-cards] payment arrived for CANCELLED reservation ${reference} — reviving ${revived.length} card(s)`);
  }

  const now = new Date().toISOString();
  const expected = money(cards.reduce((s, c) => s + c.faceValue, 0));

  for (const card of cards) {
    if (card.status === STATUS.PAID) continue;
    card.status = STATUS.PAID;
    card.paidAt = now;
    // The card becomes worth its face value at exactly the moment it becomes paid.
    // These two are one decision, and they are written together on purpose.
    card.balance = card.faceValue;
    card.reserveExpiresAt = null;      // the reservation clock stops...
    // ...and the card's own clock starts, from the moment the money arrived. Using the
    // payment date rather than the order date matters for the offline payers revived
    // below: someone who pays by transfer three days late gets a full 90 days, not 87.
    card.expiresAt = addDays(now, VALID_DAYS);
    card.payment = { paymentRef: paymentRef || null, method, at: now, by };
    card.transactions.push({ at: now, type: 'issue', amount: card.faceValue, balance: card.balance, ref: paymentRef || null });
  }
  saveLedger();

  // Report a mismatch rather than reconciling it silently. Under/over-payment on a gift
  // card is a reconciliation problem for a person, and the cards are already correct at
  // face value — quietly adjusting them here would hide the discrepancy from the books.
  if (amountPaid != null && money(amountPaid) !== expected) {
    console.log(`[gift-cards] AMOUNT MISMATCH ref=${reference} expected=${expected} paid=${money(amountPaid)} — cards issued at face value, reconcile manually`);
  }

  auditLog({ event: 'paid', reference, method, paymentRef: paymentRef || null, by, count: cards.length, expected, amountPaid: amountPaid == null ? null : money(amountPaid), revived: revived.length });
  return { ok: true, alreadyPaid: false, revived: revived.length, cards: cards.map((c) => publicCard(c)) };
}

// A paid card withdrawn by staff — a refund, a duplicate, a fraudulent order. Kept
// distinct from `cancelled` (which only ever means "never paid for") so the two can
// never be confused when someone reads the ledger a year from now.
export function voidCard(code, { reason, by } = {}) {
  const card = ledger[String(code || '').trim().toUpperCase()];
  if (!card) return { ok: false, reason: 'not_found' };
  if (card.status !== STATUS.PAID) return { ok: false, reason: 'not_paid', status: card.status };
  const now = new Date().toISOString();
  card.transactions.push({ at: now, type: 'void', amount: -card.balance, balance: 0, reason: reason || '', by: by || null });
  card.status = STATUS.VOIDED;
  card.balance = 0;
  card.voidedAt = now;
  saveLedger();
  auditLog({ event: 'voided', code: mask(card.code), reason: reason || '', by: by || null });
  return { ok: true, card: publicCard(card) };
}

// --- spending ----------------------------------------------------------------
// Partial redemption: a GHS 500 card can pay for a GHS 320 treatment and keep GHS 180.
// The balance is never written without a transaction line written beside it, so the
// ledger can always be re-derived from its own history.
export function spend(code, amount, { reason, reference, branchId, by } = {}) {
  const card = ledger[String(code || '').trim().toUpperCase()];
  if (!card) return { ok: false, reason: 'not_found' };
  if (card.status !== STATUS.PAID) return { ok: false, reason: 'not_spendable', status: card.status };
  // Checked against the DATE, not against the stored status. If the sweep is behind —
  // stopped, crashed, or simply not due for another hour — an expired card must still
  // be refused. Correctness cannot depend on a background job having run.
  if (isExpired(card)) return { ok: false, reason: 'expired', expiresAt: card.expiresAt, balance: card.balance };

  const amt = money(amount);
  if (!(amt > 0)) return { ok: false, reason: 'bad_amount' };
  // Refuse rather than clamp. Silently spending "as much as is on the card" leaves the
  // till short by the difference with nobody told.
  if (amt > card.balance) return { ok: false, reason: 'insufficient', balance: card.balance };

  const now = new Date().toISOString();
  card.balance = money(card.balance - amt);
  card.transactions.push({ at: now, type: 'spend', amount: -amt, balance: card.balance, reason: reason || '', ref: reference || null, branchId: branchId || null, by: by || null });
  saveLedger();
  auditLog({ event: 'spend', code: mask(card.code), amount: amt, balance: card.balance, ref: reference || null, branchId: branchId || null, by: by || null });
  return { ok: true, spent: amt, balance: card.balance, card: publicCard(card) };
}

// Undo a spend — the till mis-keyed it, or the booking it paid for fell through. This
// exists because a gift card is not a card authorisation: walking away does not reverse
// it, so there has to be a deliberate way back.
export function unspend(code, amount, { reason, by } = {}) {
  const card = ledger[String(code || '').trim().toUpperCase()];
  if (!card) return { ok: false, reason: 'not_found' };
  const amt = money(amount);
  if (!(amt > 0)) return { ok: false, reason: 'bad_amount' };
  // Cannot refund more than was ever taken, or a card grows past its face value.
  const spent = card.transactions.filter((t) => t.type === 'spend').reduce((s, t) => s - t.amount, 0);
  const refunded = card.transactions.filter((t) => t.type === 'refund').reduce((s, t) => s + t.amount, 0);
  if (amt > money(spent - refunded)) return { ok: false, reason: 'exceeds_spent', spent: money(spent - refunded) };

  const now = new Date().toISOString();
  card.balance = money(card.balance + amt);
  card.transactions.push({ at: now, type: 'refund', amount: amt, balance: card.balance, reason: reason || '', by: by || null });
  saveLedger();
  auditLog({ event: 'refund', code: mask(card.code), amount: amt, balance: card.balance, reason: reason || '', by: by || null });
  return { ok: true, balance: card.balance, card: publicCard(card) };
}

// --- extending a card --------------------------------------------------------
// Niobe's paid extension: another 30 days for GHS 200 per card. Two rules make this
// safe rather than merely possible.
//
// First, it CANNOT happen for free by accident. Adding 30 days to a bearer instrument is
// giving away money, so it needs either a payment reference or a named member of staff
// taking responsibility. An extension with neither is refused.
//
// Second, the new expiry runs from the CURRENT expiry, not from today — unless the card
// has already lapsed, in which case it runs from today. Nobody should pay GHS 200 for
// thirty days and receive twenty-two because they renewed a week early.
export function extendCard(code, { days = EXTENSION_DAYS, feeGHS = EXTENSION_FEE_GHS, paymentRef = null, by = null, reason = '' } = {}) {
  const card = ledger[String(code || '').trim().toUpperCase()];
  if (!card) return { ok: false, reason: 'not_found' };
  if (![STATUS.PAID, STATUS.EXPIRED].includes(card.status)) return { ok: false, reason: 'not_extendable', status: card.status };
  if (!paymentRef && !by) return { ok: false, reason: 'unpaid_extension' };
  const n = Number(days);
  if (!(n > 0 && n <= 365)) return { ok: false, reason: 'bad_days' };
  // A spent-out card has nothing to extend; taking GHS 200 for it would be taking money
  // for nothing, and the customer would only discover that at the till.
  if (!(card.balance > 0)) return { ok: false, reason: 'no_balance' };

  const now = new Date();
  const nowIso = now.toISOString();
  const from = (card.expiresAt && Date.parse(card.expiresAt) > now.getTime()) ? card.expiresAt : nowIso;
  const previous = card.expiresAt;
  card.expiresAt = addDays(from, n);
  // Bringing a lapsed card back to life is the whole point of a paid extension.
  if (card.status === STATUS.EXPIRED) card.status = STATUS.PAID;
  // A fresh expiry deserves a fresh reminder, otherwise the holder is warned once and
  // never again — and quietly loses the balance they just paid GHS 200 to protect.
  card.expiryRemindedAt = null;
  card.extensions.push({ at: nowIso, days: n, feeGHS: money(feeGHS), from: previous, to: card.expiresAt, paymentRef, by, reason });
  card.transactions.push({ at: nowIso, type: 'extend', amount: 0, balance: card.balance, days: n, feeGHS: money(feeGHS), ref: paymentRef, by });
  saveLedger();
  auditLog({ event: 'extended', code: mask(card.code), days: n, feeGHS: money(feeGHS), from: previous, to: card.expiresAt, paymentRef, by, reason });
  return { ok: true, expiresAt: card.expiresAt, previousExpiry: previous, daysLeft: daysLeft(card, now), feeGHS: money(feeGHS), card: publicCard(card) };
}

// --- the 48-hour sweep -------------------------------------------------------
// Cancels reservations nobody paid for, and nudges the ones about to lapse.
//
// readOnly exists for the same reason it exists in the holds engine: opening a staff
// dashboard must never itself cancel a customer's reservation. One background loop is
// the only actor.
export function sweepReservations(now = new Date(), { readOnly = false } = {}) {
  const t = now.getTime();
  const cancelled = [];
  const toRemind = [];
  const expired = [];
  const expiringSoon = [];

  for (const card of Object.values(ledger)) {
    // --- clock one: the unpaid reservation ---
    if (card.status === STATUS.RESERVED) {
      const expiry = card.reserveExpiresAt ? Date.parse(card.reserveExpiresAt) : null;
      if (!expiry) continue;

      if (t >= expiry) {
        cancelled.push(card);
        if (!readOnly) {
          card.status = STATUS.CANCELLED;
          card.cancelledAt = new Date(t).toISOString();
          card.cancelReason = 'unpaid';
          card.balance = 0;
        }
        continue;
      }
      // Nudge once, and only once, when the deadline is within the reminder window.
      if (!card.remindedAt && t >= expiry - REMIND_HOURS * 3600 * 1000) {
        toRemind.push(card);
        if (!readOnly) card.remindedAt = new Date(t).toISOString();
      }
      continue;
    }

    // --- clock two: the paid card's own 90 days ---
    if (card.status !== STATUS.PAID || !card.expiresAt) continue;
    const cardExpiry = Date.parse(card.expiresAt);

    if (t >= cardExpiry) {
      // The balance is deliberately LEFT ON the record rather than zeroed. It is the
      // forfeited value — the liability coming off Niobe's books — and a figure they
      // will want to see. Nothing can spend it: isExpired() gates that by date.
      expired.push(card);
      if (!readOnly) {
        card.status = STATUS.EXPIRED;
        card.expiredAt = new Date(t).toISOString();
        card.transactions.push({ at: new Date(t).toISOString(), type: 'expire', amount: 0, balance: card.balance, forfeited: card.balance });
      }
      continue;
    }
    // 14 days out, once, and only for cards that still have something on them —
    // reminding somebody about an empty card is noise that trains them to ignore
    // the next one, which will be the reminder that mattered.
    if (!card.expiryRemindedAt && card.balance > 0 && t >= cardExpiry - EXPIRY_REMIND_DAYS * DAY_MS) {
      expiringSoon.push(card);
      if (!readOnly) card.expiryRemindedAt = new Date(t).toISOString();
    }
  }

  if (!readOnly && (cancelled.length || toRemind.length || expired.length || expiringSoon.length)) {
    saveLedger();
    for (const c of cancelled) auditLog({ event: 'cancelled', code: mask(c.code), reference: c.reference, reason: 'unpaid' });
    for (const c of expired) auditLog({ event: 'expired', code: mask(c.code), reference: c.reference, forfeited: c.balance, expiresAt: c.expiresAt });
  }

  // Group by basket — one buyer with six cards gets one email, not six.
  const byRef = (cards) => {
    const m = new Map();
    for (const c of cards) {
      if (!m.has(c.reference)) m.set(c.reference, { reference: c.reference, buyerName: c.buyerName, buyerEmail: c.buyerEmail, cards: [], total: 0, expiresAt: c.reserveExpiresAt });
      const g = m.get(c.reference);
      g.cards.push(mask(c.code));
      g.total = money(g.total + c.faceValue);
    }
    return [...m.values()];
  };

  // The expiry reminder goes to whoever is HOLDING the card, which is the recipient of
  // a gift, not the person who bought it three months ago. It is per card, not per
  // basket — six people were given six different cards.
  //
  // NOTE: unlike every other report in this module, these entries carry the FULL code —
  // a reminder without a working link is just an announcement that money is about to be
  // lost. So this one report is sensitive: hand it to the notifier, never to a log. Use
  // `masked` for anything that gets written down. (Nothing here can leak an unpaid card,
  // because only PAID cards ever reach this branch of the sweep.)
  const holder = (c) => ({
    code: c.code,
    masked: mask(c.code),
    balance: c.balance,
    expiresAt: c.expiresAt,
    daysLeft: daysLeft(c, now),
    // Whoever we can actually reach. A print-at-home gift may have no recipient address,
    // in which case the buyer is the only person we can warn.
    to: (c.gift && c.recipientEmail) || c.buyerEmail,
    toName: (c.gift && c.recipientName) || c.buyerName,
    // Niobe's customers complain that they phone to book and cannot get through, so the
    // reminder must carry a way to book without phoning anybody. This is the difference
    // between a reminder that recovers the booking and one that just announces a loss.
    bookUrl: `${(CONFIG.publicUrl || '').replace(/\/$/, '')}/book?gc=${encodeURIComponent(c.code)}`,
    extendFeeGHS: EXTENSION_FEE_GHS,
    extendDays: EXTENSION_DAYS,
  });

  return {
    cancelled: byRef(cancelled),          // unpaid orders killed at 48h
    remind: byRef(toRemind),              // unpaid orders about to be killed
    expired: expired.map(holder),         // cards that reached 90 days, value forfeited
    expiringSoon: expiringSoon.map(holder),  // cards 14 days out — book, or pay to extend
    forfeited: money(expired.reduce((s, c) => s + c.balance, 0)),
    readOnly,
    at: new Date(t).toISOString(),
  };
}

// --- the customer-facing view -----------------------------------------------
// What a card looks like to anyone outside this module. The buyer's own details are
// here because the buyer sees their own order; the full code is included only where
// the card is PAID, which is the whole point of the lifecycle above.
function publicCard(card, now = new Date()) {
  // An expired card still shows its code — the holder has it printed in their hand, and
  // "that code doesn't exist" is the wrong answer to someone asking why it was refused.
  // They need to be told it lapsed, and offered the GHS 200 extension.
  const issued = card.status === STATUS.PAID || card.status === STATUS.EXPIRED;
  const expired = isExpired(card, now);
  return {
    code: issued ? card.code : null,
    masked: mask(card.code),
    status: expired && card.status === STATUS.PAID ? STATUS.EXPIRED : card.status,
    expired,
    expiresAt: card.expiresAt,
    daysLeft: daysLeft(card, now),
    extensions: (card.extensions || []).length,
    faceValue: card.faceValue,
    balance: card.balance,
    currency: card.currency,
    design: card.design,
    designName: card.designName,
    recipientName: card.recipientName,
    message: card.message,
    delivery: card.delivery,
    deliverOn: card.deliverOn,
    reference: card.reference,
    createdAt: card.createdAt,
    paidAt: card.paidAt,
    reserveExpiresAt: card.reserveExpiresAt,
  };
}
export { publicCard };

export function getCard(code) {
  return ledger[String(code || '').trim().toUpperCase()] || null;
}

// --- the unified balance check ----------------------------------------------
// The one thing a gift-card site absolutely must get right, and the thing the current
// site gets wrong: it checks its own (empty) database only, so a real GiftUp card and a
// real SimpleSpa card both come back "Invalid voucher code". That sentence tells a
// customer holding genuine value that their gift is worthless, and they go away.
//
// So this asks all three ledgers, in the order a card is most likely to be found, and —
// critically — distinguishes "no such card anywhere" from "one of the systems did not
// answer". Those are opposite messages to the person standing at the desk. An outage
// must never be reported as an invalid card.
export async function lookupAnyCard(code, { skipVariants = false } = {}) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return { found: false, reason: 'no_code', errors: [] };

  const errors = [];

  // 1. Ours. No network, so it cannot fail — and it is where every new card lives.
  const own = ledger[c];
  if (own) {
    // A reserved card is NOT reported as a card. Nobody should be able to discover that
    // a code exists before it has been paid for, let alone see a balance against it.
    if (own.status === STATUS.RESERVED) return { found: false, source: null, reason: 'not_found', errors };
    const expired = isExpired(own);
    return {
      found: true,
      source: 'niobe',
      code: own.code,
      balance: own.balance,
      initialBalance: own.faceValue,
      currency: own.currency,
      status: expired ? STATUS.EXPIRED : own.status,
      expired,
      expiresAt: own.expiresAt,
      daysLeft: daysLeft(own),
      // What it costs to bring it back, so the page can offer the extension in the same
      // breath as the bad news rather than sending the customer to phone a branch.
      extendable: expired && own.balance > 0,
      extendFeeGHS: EXTENSION_FEE_GHS,
      extendDays: EXTENSION_DAYS,
      valid: own.status === STATUS.PAID && own.balance > 0 && !expired,
      // Ours can be deducted automatically; the other two cannot, and the desk needs
      // to know which it is holding before it starts a treatment.
      selfService: true,
      errors,
    };
  }

  // 2. GiftUp — every card sold up to the switch-over.
  if (CONFIG.giftupKey) {
    try {
      const g = await validateGiftUpCard(c);
      if (g.found) {
        return {
          found: true, source: 'giftup', code: g.code,
          balance: g.balance, initialBalance: null, currency: 'GHS',
          status: g.voided ? 'voided' : g.expired ? 'expired' : 'active',
          expired: !!g.expired, expiresAt: g.raw?.expiresOn || null,
          valid: !!g.valid, selfService: true, errors,
        };
      }
    } catch (e) {
      errors.push({ source: 'giftup', error: e.message });
    }
  } else {
    // Not configured is not the same as "checked and absent". If a customer's card
    // isn't found and we never actually asked GiftUp, the answer is "we can't tell".
    errors.push({ source: 'giftup', error: 'not_configured' });
  }

  // 3. SimpleSpa's own older cards — a separate ledger, per branch, dashed codes.
  try {
    const s = await lookupSimpleSpaCard(c);
    if (s.found) {
      return {
        found: true, source: 'simplespa', code: s.code,
        balance: s.balance, initialBalance: s.initialBalance, currency: 'GHS',
        status: s.expired ? 'expired' : 'active',
        expired: !!s.expired, expiresAt: s.expiresAt,
        valid: !!s.valid,
        branchId: s.branchId, branchName: s.branchName,
        // SimpleSpa exposes no write endpoint for gift cards — confirmed by testing and
        // in writing by SimpleSpa themselves — so this one can be READ but not deducted.
        // Redemption ends in a staff task. Saying so here is what stops the front desk
        // assuming the balance shown has been taken off.
        selfService: false,
        errors: [...errors, ...(s.errors || [])],
      };
    }
    if (s.errors?.length) errors.push(...s.errors.map((e) => ({ source: 'simplespa', ...e })));
  } catch (e) {
    errors.push({ source: 'simplespa', error: e.message });
  }

  // Before giving up: the code may have been MIS-READ off a printed voucher rather than
  // not existing. New Niobe codes cannot contain O/0/I/1/L, but the SimpleSpa cards
  // already in circulation can and do — DPB-QO0 has both an O and a zero in it, and
  // there is no way to reissue what customers are already holding.
  //
  // So try the plausible mis-readings. The safety rule is that this may only ever
  // resolve to ONE card: if two different real cards both match, we have no way to know
  // which one is in the customer's hand, and guessing would spend a stranger's money.
  if (!skipVariants) {
    const variants = ambiguityVariants(c);
    const hits = [];
    for (const v of variants) {
      const r = await lookupAnyCard(v, { skipVariants: true });   // no recursion beyond one level
      if (r.found) hits.push(r);
      if (hits.length > 1) break;
    }
    if (hits.length === 1) return { ...hits[0], correctedFrom: c, errors };
    if (hits.length > 1) return { found: false, reason: 'ambiguous_code', errors };
  }

  // Nowhere. Only now, and only if every system actually answered, is it safe to tell
  // someone their code is not a gift card.
  return { found: false, reason: errors.length ? 'unavailable' : 'not_found', errors };
}

// The characters people actually confuse on a printed voucher, in both directions.
const CONFUSABLE = { O: '0', '0': 'O', I: '1', '1': 'I', L: '1' };

// Every single-and-multi-character re-reading of an ambiguous code, excluding the
// original. Capped hard: a code full of ambiguous characters would otherwise fan out
// into hundreds of live API calls, and past a handful of possibilities the honest
// answer is "please check with the branch" anyway.
function ambiguityVariants(code, cap = 8) {
  const positions = [...code].map((ch, i) => (CONFUSABLE[ch] ? i : -1)).filter((i) => i >= 0);
  if (!positions.length || positions.length > 4) return [];
  const out = new Set();
  for (let mask = 1; mask < (1 << positions.length) && out.size < cap; mask++) {
    const chars = [...code];
    for (let b = 0; b < positions.length; b++) {
      if (mask & (1 << b)) chars[positions[b]] = CONFUSABLE[chars[positions[b]]];
    }
    const v = chars.join('');
    if (v !== code) out.add(v);
  }
  return [...out];
}
