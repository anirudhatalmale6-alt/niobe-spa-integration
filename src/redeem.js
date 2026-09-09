import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { validateCard, redeem } from './giftup.js';
import { getCard, spend as spendOwn, isExpired, publicCard } from './cards.js';
import { lookupSimpleSpaCard } from './sscards.js';
import { getBooking } from './bookings.js';
import { depositOptions, makeReference } from './deposit.js';
import { confirmAppointment } from './confirm.js';
import { markSecured, registerHold } from './holds.js';

// Redeeming an EXISTING gift card against a booking — the other half of the gift-card
// story. giftup.js already knew how to read and redeem a card; what was missing was a
// route a customer could actually reach, which is why holders of a card were pressing
// "I'm paying with account credit" (wrong queue, manual staff work) or giving up.
//
// The money-losing failure this module is built around: a gift card is real value, and
// a redemption is not a card authorisation that can simply be voided by walking away.
// If we deduct from the card and then fail to secure the slot, the customer has paid
// and has no booking — and unlike a card payment there is no automatic reversal. So the
// order of operations is deliberate throughout and the balance is NEVER touched until
// we know the redemption can cover what the booking needs.

// NIOBE_DATA_DIR so a test run can be pointed at a throwaway directory. cards.js honoured it
// and this file did not, which meant an end-to-end test against a temp ledger still wrote into
// the LIVE data directory — found by doing exactly that. The isolation only works if every
// module persisting money-adjacent state agrees to it, so all of them now do.
const DATA_DIR = process.env.NIOBE_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const LEDGER_FILE = join(DATA_DIR, 'gift-redemptions.json');

// Persisted so a restart between redeeming and the customer refreshing can't cause a
// second deduction from the same card. This is the same class of bug as the in-memory
// hold registry and the in-memory notify set: state that guards a real-world side
// effect cannot live only in the process.
let ledger = {};   // bookingId -> record
function loadLedger() {
  try {
    const raw = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
    if (raw && typeof raw === 'object') ledger = raw;
  } catch { ledger = {}; }
}
function saveLedger() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 1));
  } catch (e) {
    // If we cannot persist we must say so loudly: an unrecorded redemption is money
    // taken off a card with nothing durable tying it to a booking.
    console.log(`[gift-redeem] WARNING could not persist ledger: ${e.message}`);
  }
}
loadLedger();

function recordRedemption(entry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, 'gift-redemptions.log'), JSON.stringify(entry) + '\n');
  } catch { /* logging must never break the customer flow */ }
  if (!entry.confirmed) {
    console.log(`[gift-redeem] REDEEMED but NOT auto-confirmed (${entry.reason || ''}): booking=${entry.bookingId} appt=${entry.appointment_id} card=${mask(entry.code)} amount=${entry.amount}`);
  }
}

// Never write a full gift-card code to a log or a page — it is a bearer instrument.
// Anyone who reads it can spend it.
export const mask = (code) => {
  const c = String(code || '').trim();
  return c.length <= 4 ? '••••' : `${'•'.repeat(Math.max(4, c.length - 4))}${c.slice(-4)}`;
};

export function existingRedemption(bookingId) { return ledger[String(bookingId)] || null; }

// --- Step 1: read the card ---------------------------------------------------
// Pure lookup, no money moves. Tells the customer in plain terms whether the card
// works and what it covers, which is what Niobe asked for ("read unexpired gift
// cards and confirm").
// A card from our own ledger, checked against a booking.
//
// Deliberately mirrors the GiftUp branch's SHAPE — same reasons, same refusals, same field
// names on the way out — so the pages rendering this do not have to know which system issued
// the card, and a future edit to one branch is obviously missing from the other.
//
// The one real difference is that this ledger is ours, so "expired" and "not paid" are facts
// we hold rather than answers we asked someone else for. isExpired() is evaluated from the
// DATE on every read: a sweep that is stopped or an hour behind must never be the reason an
// expired card can still be spent.
export function checkOwnCard(b, card, code) {
  const opts = depositOptions(b.price, { giftCardOrCredit: false, requireFull: b.requireFull });

  if (card.status === 'voided') return { ok: false, reason: 'voided', booking: b, card: publicCard(card) };
  // A reserved card has not been paid for and its code was never released to anybody. If one
  // is being presented, something is wrong upstream — but to the person at the desk it is
  // simply not a valid card, and saying more would be telling them how the system works.
  if (card.status === 'reserved' || card.status === 'cancelled') {
    return { ok: false, reason: 'not_found', booking: b };
  }
  if (isExpired(card)) return { ok: false, reason: 'expired', booking: b, card: publicCard(card) };
  if (!(card.balance > 0)) return { ok: false, reason: 'no_balance', booking: b, card: publicCard(card) };

  const balance = card.balance;
  const affordable = (opts.options || []).filter((o) => o.amount <= balance + 0.009);
  const cheapest = (opts.options || []).reduce((min, o) => (!min || o.amount < min.amount ? o : min), null);

  return {
    ok: affordable.length > 0,
    reason: affordable.length ? 'ok' : 'insufficient',
    booking: b,
    card: publicCard(card),
    // Marks which ledger this came from, so redeemForBooking deducts from the right place
    // rather than inferring it a second time and possibly differently.
    source: 'niobe',
    balance,
    giftupBalance: null,
    // No mirror check. Cards we issue are not written into SimpleSpa, so there is no second
    // balance to disagree with — the double-spend risk the GiftUp branch guards against does
    // not exist here. If Niobe ever start mirroring these, this is the line that has to change.
    mirrorBalance: null,
    diverged: false,
    price: opts.price,
    options: affordable,
    needed: cheapest?.amount ?? opts.price,
    shortfall: Math.max(0, Math.round(((cheapest?.amount ?? opts.price) - balance) * 100) / 100),
  };
}

export async function checkGiftCard({ bookingId, code }) {
  const b = await getBooking(bookingId);
  if (!b) return { ok: false, reason: 'booking_not_found' };

  const already = existingRedemption(bookingId);
  if (already) return { ok: false, reason: 'already_redeemed', booking: b, redemption: already };

  // OUR OWN LEDGER FIRST, and by lookup rather than by the shape of the code.
  //
  // Our codes happen to start "NB-", but deciding ownership from a prefix is a guess that
  // silently stops being true the day the format changes. getCard() either has it or does
  // not; there is nothing to be wrong about.
  //
  // First also matters: it is the only ledger we can actually deduct from, it needs no
  // network call, and it cannot be down. A card of ours must never fall through to a GiftUp
  // lookup that returns "not found" and gets reported to the customer as invalid.
  const own = getCard(code);
  if (own) return checkOwnCard(b, own, code);

  let card;
  try {
    card = await validateCard(code);
  } catch (e) {
    // A GiftUp outage must not read as "your card is invalid" — the customer would
    // reasonably conclude their gift is worthless and give up on the booking.
    return { ok: false, reason: 'lookup_failed', booking: b, message: e.message };
  }

  if (!card.found) {
    // Not a GiftUp card — before declaring it invalid, check SimpleSpa's own older
    // gift-card system. Telling a customer their genuine voucher doesn't exist is a
    // worse failure than the one this whole flow was built to fix.
    const ss = await lookupSimpleSpaCard(code);
    if (ss.found) {
      return {
        ok: false,
        reason: ss.valid ? 'simplespa_manual' : (ss.expired ? 'expired' : 'no_balance'),
        booking: b, ssCard: ss,
      };
    }
    return { ok: false, reason: 'not_found', booking: b };
  }
  if (card.voided) return { ok: false, reason: 'voided', booking: b, card };
  if (card.expired) return { ok: false, reason: 'expired', booking: b, card };
  if (!card.valid) return { ok: false, reason: 'not_redeemable', booking: b, card };

  // CROSS-LEDGER SAFETY CHECK.
  //
  // Niobe mirror most GiftUp cards into SimpleSpa under the SAME code so branch staff
  // can see them and sell paid extensions. That means one card has TWO independent
  // balances, and spending it in one place does not reduce the other. Measured on live
  // data: 86 of 100 GiftUp cards also existed in SimpleSpa, and 8 had already diverged
  // — SimpleSpa at 0.00 (spent at the till) while GiftUp still showed the full value.
  //
  // Redeeming on the GiftUp figure alone would therefore let an already-spent card be
  // spent a second time online. So we take the LOWER of the two balances. That is
  // correct in both directions: spend at the till and SimpleSpa is lower; spend online
  // and GiftUp is lower. It can only ever be conservative, never generous.
  let mirror = null;
  try {
    mirror = await lookupSimpleSpaCard(code);
  } catch { /* a mirror lookup failure must not block a valid GiftUp card */ }

  const guBalance = card.balance == null ? Infinity : card.balance;
  const mirrored = mirror?.found ? Number(mirror.balance) : null;
  const balance = mirrored != null ? Math.min(guBalance, mirrored) : guBalance;

  // Fully spent on the SimpleSpa side => the value is gone, whatever GiftUp says.
  if (mirrored != null && mirrored <= 0) {
    return { ok: false, reason: 'already_used_in_branch', booking: b, card, ssCard: mirror };
  }

  const opts = depositOptions(b.price, { giftCardOrCredit: false, requireFull: b.requireFull });
  // Which of the normal pay options this card can actually cover in full. We only
  // ever offer an option the balance covers outright — see redeemForBooking for why
  // a part-payment is deliberately not offered here.
  const affordable = opts.options.filter((o) => balance + 0.001 >= o.amount);
  const cheapest = opts.options.reduce((a, o) => (o.amount < a.amount ? o : a), opts.options[0]);

  return {
    ok: affordable.length > 0,
    reason: affordable.length ? 'ok' : 'insufficient',
    booking: b,
    card,
    // The figure we will actually honour — the lower of the two ledgers.
    balance,
    giftupBalance: card.balance,
    mirrorBalance: mirrored,
    // True when the two ledgers disagree; recorded so reconciliation has a trail.
    diverged: mirrored != null && Math.abs(mirrored - guBalance) > 0.009,
    price: opts.price,
    options: affordable,
    // What they'd need for the smallest option, so the shortfall message is concrete
    // rather than "insufficient balance".
    needed: cheapest?.amount ?? opts.price,
    shortfall: Math.max(0, Math.round(((cheapest?.amount ?? opts.price) - balance) * 100) / 100),
  };
}

// --- Step 2: redeem and secure ----------------------------------------------
// In-flight guard: a customer double-clicking "Confirm" fires two concurrent POSTs,
// and the persisted ledger alone can't stop the second one because neither has
// finished writing yet. Cheap, and the window it closes is a real double deduction.
const inFlight = new Set();

export async function redeemForBooking({ bookingId, code, option }) {
  const key = String(bookingId);

  const already = existingRedemption(key);
  if (already) return { ok: true, replay: true, redemption: already, booking: await getBooking(bookingId) };
  if (inFlight.has(key)) return { ok: false, reason: 'in_progress' };

  inFlight.add(key);
  try {
    // Re-check rather than trusting what the browser posted back: the balance can
    // have moved since the check page was rendered (the same card used at a branch
    // in the meantime), and the amount must never come from the client.
    const check = await checkGiftCard({ bookingId, code });
    if (!check.ok) return { ...check, ok: false };

    const chosen = check.options.find((o) => o.id === option) || check.options[0];
    if (!chosen) return { ok: false, reason: 'insufficient', ...check };

    const b = check.booking;
    const reference = makeReference(b.branchId);

    // MONEY MOVES HERE. Everything after this point must be failure-tolerant: the
    // customer has now genuinely paid.
    //
    // Which ledger is decided by the CHECK, not worked out again here. check.source was
    // established by the same lookup that produced the balance and the options; re-deriving
    // it would open the door to checking one card and deducting from another.
    let r;
    if (check.source === 'niobe') {
      const sp = spendOwn(code, chosen.amount, {
        reference,
        reason: `Niobe booking ${b.id} — ${b.service}`,
        branchId: b.branchId,
      });
      // spend() refuses rather than clamps, and returns a reason. Every one of them is a
      // clean failure — nothing was deducted — so the customer can retry or pay another way.
      if (!sp.ok) {
        return { ok: false, reason: sp.reason === 'insufficient' ? 'insufficient' : 'redeem_failed',
          message: sp.reason, booking: b, card: check.card, balance: sp.balance ?? check.balance };
      }
      // Normalised to the same shape the GiftUp call returns, so everything downstream —
      // the record, the pages, the reconciliation — stays one code path.
      r = { transactionId: `NB-${reference}`, remainingCredit: sp.balance };
    } else {
      try {
        r = await redeem(code, chosen.amount, {
          reference,
          reason: `Niobe booking ${b.id} — ${b.service}`,
          metadata: { bookingId: b.id, appointment_id: b.appointment_id, branchId: b.branchId },
        });
      } catch (e) {
        // Nothing was deducted, so this is still a clean failure the customer can retry.
        return { ok: false, reason: 'redeem_failed', message: e.message, booking: b, card: check.card };
      }
    }

    // Persist the redemption BEFORE anything else that could throw. If the process
    // died on the next line, this record is what proves the card was spent on this
    // booking. Written first, deliberately.
    const record = {
      bookingId: b.id,
      appointment_id: b.appointment_id,
      branchId: b.branchId,
      branchName: b.branchName,
      code: mask(code),
      amount: chosen.amount,
      optionId: chosen.id,
      reference,
      transactionId: r.transactionId,
      remainingCredit: r.remainingCredit,
      // Recorded so a later reconciliation can see the card also lives in SimpleSpa
      // and by how much the two ledgers disagreed at the moment it was spent.
      mirrorBalance: check.mirrorBalance ?? null,
      diverged: !!check.diverged,
      // Which ledger this came out of. Without it, a year from now nobody reading this file
      // can tell whether to reconcile a row against GiftUp's statement or our own.
      source: check.source || 'giftup',
      at: new Date().toISOString(),
    };
    ledger[key] = record;
    saveLedger();

    // Secure the slot before attempting the SimpleSpa write, so a confirm failure
    // can never let the release sweep cancel a booking that has been paid for.
    try { markSecured(b.appointment_id, `giftcard_ref:${reference}`); } catch { /* never block on this */ }

    let confirm;
    try {
      confirm = await confirmAppointment(b.branchId, b.appointment_id, reference);
    } catch (e) {
      confirm = { confirmed: false, pending: true, reason: e.message };
    }

    b.status = confirm.confirmed ? 'confirmed' : 'paid_pending_confirm';
    b.paidAmount = chosen.amount;
    b.paymentReference = reference;
    b.giftCard = { code: mask(code), amount: chosen.amount, transactionId: r.transactionId };

    record.confirmed = !!confirm.confirmed;
    record.reason = confirm.error || confirm.reason;
    ledger[key] = record;
    saveLedger();
    recordRedemption(record);

    return {
      ok: true,
      booking: b,
      redemption: record,
      confirm,
      remainingCredit: r.remainingCredit,
      paidInFull: chosen.id === 'full',
    };
  } finally {
    inFlight.delete(key);
  }
}

// --- SimpleSpa (legacy) gift cards ------------------------------------------
// These CANNOT be deducted through the API — SimpleSpa exposes no gift-card write
// endpoint — so this path does the most that can honestly be done automatically:
// verify the card is real and has the balance, hold the slot so it isn't released
// while the customer waits, and raise a staff task to apply the card in SimpleSpa.
//
// This is deliberately NOT presented to the customer as "paid". It is the same
// shape as the existing account-credit claim, with one important difference: the
// balance here has been VERIFIED against SimpleSpa rather than merely claimed by
// the customer, so staff are confirming a real card, not taking someone's word.
//
// The risk this carries, stated plainly because it must not be discovered later:
// if staff never apply the card in SimpleSpa, the customer keeps their balance AND
// the slot. That is why every claim is written to a work-list rather than trusted
// to memory.
export async function claimSimpleSpaCard({ bookingId, code }) {
  const key = String(bookingId);
  const already = existingRedemption(key);
  if (already) return { ok: true, replay: true, redemption: already, booking: await getBooking(bookingId) };

  const check = await checkGiftCard({ bookingId, code });
  if (check.reason !== 'simplespa_manual') return { ...check, ok: false };

  const b = check.booking;
  const ss = check.ssCard;
  const reference = makeReference(b.branchId);

  const record = {
    bookingId: b.id,
    appointment_id: b.appointment_id,
    branchId: b.branchId,
    branchName: b.branchName,
    source: 'simplespa',
    code: mask(ss.code),
    // Full code IS kept for this path only, because staff must type it into
    // SimpleSpa to apply it. It lives in the gitignored data dir alongside the
    // other customer records, never in a page or a console line.
    codeFull: ss.code,
    cardBranch: ss.branchName,
    balance: ss.balance,
    expiresAt: ss.expiresAt,
    customer: b.customer?.name,
    phone: b.customer?.phone,
    service: b.service,
    datetime: b.datetime,
    price: b.price,
    reference,
    manual: true,
    confirmed: false,
    at: new Date().toISOString(),
  };
  ledger[key] = record;
  saveLedger();

  // Hold the slot with staffAuth so the release deadline rolls into business hours:
  // the customer has produced a real card and must not lose the booking while the
  // desk works through the queue. NOT markSecured — nothing has actually been paid
  // yet, and treating it as paid would let an unapplied card slip through silently.
  try { registerHold(b.appointment_id, { branchId: b.branchId, staffAuth: true, reason: 'giftcard_manual_pending' }); } catch { /* never block the customer */ }

  b.status = 'giftcard_claim_pending';
  recordRedemption(record);
  console.log(`[gift-redeem] SIMPLESPA card claimed — needs staff to apply it: booking=${b.id} branch=${b.branchName} card=${mask(ss.code)} balance=${ss.balance}`);

  return { ok: true, manual: true, booking: b, redemption: record, ssCard: ss };
}
