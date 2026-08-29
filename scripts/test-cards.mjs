// Lifecycle tests for the gift-card ledger (src/cards.js).
//
// These exist because the failure being fixed here is invisible on the happy path: the
// site's current checkout looks completely fine if you only ever buy a card and pay for
// it. The bug lives in what happens when you DON'T pay. So most of what follows walks
// away from the payment on purpose.
//
// Run:  node scripts/test-cards.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'niobe-cards-'));
process.env.NIOBE_DATA_DIR = dir;
process.env.GIFTCARD_RESERVE_HOURS = '48';

const {
  reserveBasket, markPaid, spend, unspend, voidCard, sweepReservations, extendCard,
  lookupAnyCard, getCard, basketCards, isExpired, daysLeft,
  STATUS, RESERVE_HOURS, REMIND_HOURS,
  VALID_DAYS, MAX_DELIVERY_DAYS, EXPIRY_REMIND_DAYS, EXTENSION_DAYS, EXTENSION_FEE_GHS,
  extensionFee, quoteExtension, GRACE_DAYS, EXTENSION_FEES,
} = await import('../src/cards.js');

const DAY = 24 * 3600 * 1000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok   ${name}`); }
  catch (e) { results.push(`  FAIL ${name}\n         ${e.message}`); process.exitCode = 1; }
}

const buyer = { buyerName: 'Ama Mensah', buyerEmail: 'ama@example.com', buyerPhone: '0244000000' };
const oneCard = (over = {}) => ({ amount: 500, design: 'floral-01', recipientName: 'Kofi', recipientEmail: 'kofi@example.com', message: 'Happy birthday', ...over });

// --- the defect this module exists to fix ------------------------------------

await test('a reservation carries no balance and no usable code', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  const [card] = basketCards(r.reference);
  assert.equal(card.status, STATUS.RESERVED);
  assert.equal(card.balance, 0, 'a reserved card must hold no money');
  assert.equal(r.count, 1);
  // The response the browser receives must not contain a code.
  assert.equal(JSON.stringify(r).includes(card.code), false, 'the code leaked to the buyer before payment');
});

await test('an unpaid code is not discoverable by the balance checker', async () => {
  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  const [card] = basketCards(r.reference);
  const look = await lookupAnyCard(card.code);
  assert.equal(look.found, false, 'an unpaid card was reported as a real gift card');
});

await test('an unpaid reservation cannot be spent', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  const [card] = basketCards(r.reference);
  const s = spend(card.code, 100);
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'not_spendable');
});

await test('payment is what creates the balance and releases the code', async () => {
  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  const res = markPaid(r.reference, { paymentRef: 'HUB-123' });
  assert.equal(res.ok, true);
  assert.equal(res.cards[0].status, STATUS.PAID);
  assert.equal(res.cards[0].balance, 500);
  assert.ok(res.cards[0].code, 'the code must be released once paid');
  const look = await lookupAnyCard(res.cards[0].code);
  assert.equal(look.found, true);
  assert.equal(look.valid, true);
  assert.equal(look.source, 'niobe');
});

// --- the 48-hour cancellation Niobe asked for --------------------------------

await test('an unpaid reservation is cancelled after the window, not before', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  const [card] = basketCards(r.reference);

  const justBefore = new Date(Date.parse(card.reserveExpiresAt) - 60_000);
  sweepReservations(justBefore);
  assert.equal(getCard(card.code).status, STATUS.RESERVED, 'cancelled early');

  const after = new Date(Date.parse(card.reserveExpiresAt) + 60_000);
  const sweep = sweepReservations(after);
  assert.equal(getCard(card.code).status, STATUS.CANCELLED);
  // Scoped to this basket: earlier tests leave their own reservations in the ledger and
  // the sweep is right to lapse those too.
  assert.equal(sweep.cancelled.filter((g) => g.reference === r.reference).length, 1);
  // The sweep report must not carry full codes — it goes into logs and staff pages.
  assert.equal(JSON.stringify(sweep).includes(card.code), false, 'the sweep report leaked a full code');
});

await test('a read-only sweep changes nothing', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  const [card] = basketCards(r.reference);
  const after = new Date(Date.parse(card.reserveExpiresAt) + 60_000);
  const sweep = sweepReservations(after, { readOnly: true });
  assert.equal(sweep.cancelled.length, 1, 'read-only sweep must still report');
  assert.equal(getCard(card.code).status, STATUS.RESERVED, 'read-only sweep cancelled a reservation');
});

await test('the buyer is nudged once, before the deadline', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  const [card] = basketCards(r.reference);
  const remindTime = new Date(Date.parse(card.reserveExpiresAt) - (REMIND_HOURS - 0.5) * 3600 * 1000);
  assert.ok(remindTime < new Date(card.reserveExpiresAt), 'the nudge must land before the cancellation');

  const mine = (s) => s.remind.filter((g) => g.reference === r.reference);
  assert.equal(mine(sweepReservations(remindTime)).length, 1);
  assert.equal(mine(sweepReservations(remindTime)).length, 0, 'the buyer was nudged twice');
});

await test('a paid card is not touched by the RESERVATION sweep', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  markPaid(r.reference, { paymentRef: 'HUB-124' });
  const [card] = basketCards(r.reference);
  assert.equal(card.reserveExpiresAt, null, 'a paid card must not keep the reservation deadline');
  // Well past 48 hours, well inside its own 90 days: the reservation clock must not
  // touch it. The two clocks are separate and this is what proves it.
  sweepReservations(new Date(Date.now() + 10 * DAY));
  assert.equal(getCard(card.code).status, STATUS.PAID, 'the reservation sweep killed a paid card');
  assert.equal(getCard(card.code).balance, 500);
});

await test('a late offline payment revives a lapsed reservation', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  const [card] = basketCards(r.reference);
  sweepReservations(new Date(Date.parse(card.reserveExpiresAt) + 60_000));
  assert.equal(getCard(card.code).status, STATUS.CANCELLED);
  const res = markPaid(r.reference, { method: 'bank-transfer', by: 'front-desk', paymentRef: 'BT-9' });
  assert.equal(res.ok, true);
  assert.equal(res.revived, 1);
  assert.equal(getCard(card.code).status, STATUS.PAID);
  assert.equal(getCard(card.code).balance, 500);
});

// --- idempotency: gateways retry ---------------------------------------------

await test('a repeated payment callback does not issue or credit twice', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  markPaid(r.reference, { paymentRef: 'HUB-125' });
  const again = markPaid(r.reference, { paymentRef: 'HUB-125' });
  assert.equal(again.alreadyPaid, true);
  const [card] = basketCards(r.reference);
  assert.equal(card.balance, 500, 'balance was credited twice');
  assert.equal(card.transactions.filter((t) => t.type === 'issue').length, 1);
});

await test('a callback for an unknown reference is refused, not invented', () => {
  const res = markPaid('NIOBE-GC-NOPE', { paymentRef: 'X' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unknown_reference');
});

// --- group purchases: one basket, many cards, one payment --------------------

await test('a basket of different cards is paid for as one', () => {
  const r = reserveBasket({
    ...buyer,
    items: [
      oneCard({ amount: 300, recipientName: 'Abena', recipientEmail: 'a@example.com', design: 'gold' }),
      oneCard({ amount: 750, recipientName: 'Yaw', recipientEmail: 'y@example.com', design: 'floral-01' }),
      oneCard({ amount: 200, forSelf: true, delivery: 'print', recipientEmail: '' }),
    ],
  });
  assert.equal(r.count, 3);
  assert.equal(r.total, 1250);
  const res = markPaid(r.reference, { paymentRef: 'HUB-126', amountPaid: 1250 });
  assert.equal(res.cards.length, 3);
  const codes = new Set(res.cards.map((c) => c.code));
  assert.equal(codes.size, 3, 'cards in one basket shared a code');
  assert.deepEqual(res.cards.map((c) => c.balance).sort((a, b) => a - b), [200, 300, 750]);
  // Each card keeps its own recipient and design — that is the whole point of a basket.
  assert.equal(res.cards.find((c) => c.balance === 300).recipientName, 'Abena');
  assert.equal(res.cards.find((c) => c.balance === 200).delivery, 'print');
});

await test('one bad card rejects the whole basket, writing nothing', () => {
  const before = Object.keys(JSON.parse(readFileSync(join(dir, 'gift-cards.json'), 'utf8'))).length;
  assert.throws(() => reserveBasket({ ...buyer, items: [oneCard(), oneCard({ amount: 5 })] }), /smallest amount/);
  const after = Object.keys(JSON.parse(readFileSync(join(dir, 'gift-cards.json'), 'utf8'))).length;
  assert.equal(after, before, 'a rejected basket left half its cards behind');
});

await test('a printed gift needs no recipient email, an emailed one does', () => {
  assert.doesNotThrow(() => reserveBasket({ ...buyer, items: [oneCard({ delivery: 'print', recipientEmail: '' })] }));
  assert.throws(() => reserveBasket({ ...buyer, items: [oneCard({ delivery: 'email', recipientEmail: '' })] }), /valid email/);
});

// --- spending -----------------------------------------------------------------

await test('a card can be part-spent and keeps the remainder', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard({ amount: 500 })] });
  const { cards: [pc] } = markPaid(r.reference, { paymentRef: 'HUB-127' });
  const s = spend(pc.code, 320, { reason: 'Facial', branchId: 'east_legon' });
  assert.equal(s.ok, true);
  assert.equal(s.balance, 180);
  const s2 = spend(pc.code, 180);
  assert.equal(s2.balance, 0);
  const s3 = spend(pc.code, 1);
  assert.equal(s3.ok, false);
  assert.equal(s3.reason, 'insufficient');
});

await test('an overspend is refused, never clamped', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard({ amount: 500 })] });
  const { cards: [pc] } = markPaid(r.reference, { paymentRef: 'HUB-128' });
  const s = spend(pc.code, 900);
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'insufficient');
  assert.equal(getCard(pc.code).balance, 500, 'a refused spend still moved the balance');
});

await test('the balance always equals the sum of its transactions', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard({ amount: 500 })] });
  const { cards: [pc] } = markPaid(r.reference, { paymentRef: 'HUB-129' });
  spend(pc.code, 120, { reason: 'Manicure' });
  spend(pc.code, 80, { reason: 'Pedicure' });
  unspend(pc.code, 80, { reason: 'mis-keyed at the till', by: 'front-desk' });
  const card = getCard(pc.code);
  const derived = card.transactions.reduce((s, t) => s + t.amount, 0);
  assert.equal(card.balance, 380);
  assert.equal(Math.round(derived * 100) / 100, card.balance, 'the ledger cannot re-derive its own balance');
});

await test('a refund cannot exceed what was actually spent', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard({ amount: 500 })] });
  const { cards: [pc] } = markPaid(r.reference, { paymentRef: 'HUB-130' });
  spend(pc.code, 100);
  const u = unspend(pc.code, 250);
  assert.equal(u.ok, false);
  assert.equal(u.reason, 'exceeds_spent');
  assert.equal(getCard(pc.code).balance, 400);
});

await test('a voided card is dead and reads as invalid', async () => {
  const r = reserveBasket({ ...buyer, items: [oneCard({ amount: 500 })] });
  const { cards: [pc] } = markPaid(r.reference, { paymentRef: 'HUB-131' });
  const v = voidCard(pc.code, { reason: 'refunded to buyer', by: 'manager' });
  assert.equal(v.ok, true);
  assert.equal(getCard(pc.code).balance, 0);
  const look = await lookupAnyCard(pc.code);
  assert.equal(look.valid, false);
  assert.equal(spend(pc.code, 10).ok, false);
});

// --- the balance checker ------------------------------------------------------

await test('an unknown code is only called invalid when every system answered', async () => {
  // GiftUp is not configured in this environment, so the honest answer to an unknown
  // code is "we could not check everywhere", NOT "your card is invalid".
  const look = await lookupAnyCard('NB-ZZZZ-ZZZZ-ZZZZ');
  assert.equal(look.found, false);
  assert.equal(look.reason, 'unavailable', 'an unchecked system was reported as a definite answer');
  assert.ok(look.errors.some((e) => e.source === 'giftup'));
});

await test('lookup is case- and whitespace-tolerant', async () => {
  const r = reserveBasket({ ...buyer, items: [oneCard({ amount: 500 })] });
  const { cards: [pc] } = markPaid(r.reference, { paymentRef: 'HUB-132' });
  const look = await lookupAnyCard(`  ${pc.code.toLowerCase()}  `);
  assert.equal(look.found, true, 'a customer typing in lower case was told their card is invalid');
  assert.equal(look.balance, 500);
});

await test('an empty code is rejected without calling anything', async () => {
  const look = await lookupAnyCard('   ');
  assert.equal(look.found, false);
  assert.equal(look.reason, 'no_code');
});

// --- codes --------------------------------------------------------------------

await test('codes avoid characters that are misread off a printed voucher', () => {
  const r = reserveBasket({ ...buyer, items: Array.from({ length: 20 }, () => oneCard()) });
  for (const c of basketCards(r.reference)) {
    assert.match(c.code, /^NB-[ABCDEFGHJKMNPQRSTUVWXYZ23456789-]+$/);
    assert.equal(/[OIL01]/.test(c.code.slice(3)), false, `ambiguous character in ${c.code}`);
  }
});

await test('the ledger survives a restart', async () => {
  const r = reserveBasket({ ...buyer, items: [oneCard({ amount: 400 })] });
  const { cards: [pc] } = markPaid(r.reference, { paymentRef: 'HUB-133' });
  spend(pc.code, 150);
  // Re-import with a cache-buster: a fresh module, same files on disk.
  const fresh = await import(`../src/cards.js?restart=${encodeURIComponent(pc.code)}`);
  const after = fresh.getCard(pc.code);
  assert.ok(after, 'the card did not survive a restart');
  assert.equal(after.balance, 250);
  assert.equal(after.status, 'paid');
  // And a second payment callback after the restart must still be a no-op.
  assert.equal(fresh.markPaid(r.reference, { paymentRef: 'HUB-133' }).alreadyPaid, true);
});

// --- the 90-day expiry (Niobe policy, 28 Aug) --------------------------------

const paidCard = (over = {}, payOpts = {}) => {
  const r = reserveBasket({ ...buyer, items: [oneCard(over)] });
  const { cards: [pc] } = markPaid(r.reference, { paymentRef: `HUB-${Math.round(Date.parse(r.expiresAt) % 100000)}`, ...payOpts });
  return { reference: r.reference, code: pc.code, card: () => getCard(pc.code) };
};

await test('a paid card is valid for 90 days from payment, not from delivery', () => {
  const { card } = paidCard({ deliverOn: iso(Date.now() + 6 * DAY) });
  const c = card();
  assert.ok(c.expiresAt, 'a paid card must carry an expiry');
  const days = Math.round((Date.parse(c.expiresAt) - Date.parse(c.paidAt)) / DAY);
  assert.equal(days, VALID_DAYS);
  // The delivery date must NOT push the expiry out — that is the loophole being closed.
  assert.ok(Date.parse(c.expiresAt) < Date.parse(`${c.deliverOn}T09:00:00Z`) + VALID_DAYS * DAY);
});

await test('delivery cannot be scheduled beyond the 7-day window', () => {
  assert.doesNotThrow(() => reserveBasket({ ...buyer, items: [oneCard({ deliverOn: iso(Date.now() + MAX_DELIVERY_DAYS * DAY) })] }));
  assert.throws(
    () => reserveBasket({ ...buyer, items: [oneCard({ deliverOn: iso(Date.now() + (MAX_DELIVERY_DAYS + 1) * DAY) })] }),
    /up to 7 days ahead/,
  );
  assert.throws(() => reserveBasket({ ...buyer, items: [oneCard({ deliverOn: iso(Date.now() - DAY) })] }), /already passed/);
  assert.throws(() => reserveBasket({ ...buyer, items: [oneCard({ deliverOn: 'not-a-date' })] }), /not a valid date/);
});

await test('an offline payer who pays late still gets a full 90 days', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  const [reserved] = basketCards(r.reference);
  const orderedAt = Date.parse(reserved.createdAt);
  sweepReservations(new Date(Date.parse(reserved.reserveExpiresAt) + 60_000));   // lapses
  const { cards: [pc] } = markPaid(r.reference, { method: 'bank-transfer', by: 'front-desk' });
  const c = getCard(pc.code);
  const fromPayment = Math.round((Date.parse(c.expiresAt) - Date.parse(c.paidAt)) / DAY);
  assert.equal(fromPayment, VALID_DAYS, 'the 90 days must run from payment, not the order');
  assert.ok(Date.parse(c.expiresAt) > orderedAt + VALID_DAYS * DAY, 'the late payer was short-changed');
});

await test('an expired card is refused even if the sweep never ran', () => {
  const { code, card } = paidCard();
  const c = card();
  // Move the expiry into the past WITHOUT sweeping — this is the stalled-cron case.
  c.expiresAt = new Date(Date.now() - DAY).toISOString();
  assert.equal(c.status, STATUS.PAID, 'precondition: the stored status still says paid');
  assert.equal(isExpired(c), true);
  const s = spend(code, 100);
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'expired', 'expired value was spendable because a job had not run');
});

await test('the expiry sweep retires the card and reports the forfeited value', () => {
  const { code, card } = paidCard({ amount: 500 });
  card().expiresAt = new Date(Date.now() - DAY).toISOString();
  const sweep = sweepReservations(new Date());
  const mine = sweep.expired.filter((e) => e.code === code);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].balance, 500);
  assert.equal(getCard(code).status, STATUS.EXPIRED);
  // The balance stays ON the record: it is the liability coming off Niobe's books.
  assert.equal(getCard(code).balance, 500, 'the forfeited value was zeroed and lost');
  assert.ok(sweep.forfeited >= 500);
  assert.ok(getCard(code).transactions.some((t) => t.type === 'expire'));
});

await test('a part-spent card carries only its remainder into expiry', () => {
  const { code, card } = paidCard({ amount: 500 });
  spend(code, 300, { reason: 'Massage' });
  card().expiresAt = new Date(Date.now() - DAY).toISOString();
  const sweep = sweepReservations(new Date());
  assert.equal(sweep.expired.find((e) => e.code === code).balance, 200);
});

await test('the holder is reminded 14 days out, once, with a way to book', () => {
  const { code, card } = paidCard({ amount: 500, recipientEmail: 'kofi@example.com' });
  const c = card();
  c.expiresAt = new Date(Date.now() + (EXPIRY_REMIND_DAYS - 1) * DAY).toISOString();

  const first = sweepReservations(new Date()).expiringSoon.filter((e) => e.code === code);
  assert.equal(first.length, 1);
  assert.equal(first[0].to, 'kofi@example.com', 'the reminder went to the buyer, not the holder');
  assert.equal(first[0].daysLeft <= EXPIRY_REMIND_DAYS, true);
  // Niobe's customers cannot get through on the phone — a reminder with no booking
  // link is just an announcement that they are about to lose money.
  assert.match(first[0].bookUrl, /\/book\?gc=/);
  assert.equal(first[0].extendFeeGHS, EXTENSION_FEE_GHS);

  const second = sweepReservations(new Date()).expiringSoon.filter((e) => e.code === code);
  assert.equal(second.length, 0, 'the holder was reminded twice');
});

await test('a card the buyer kept for themselves reminds the buyer', () => {
  const { code } = paidCard({ forSelf: true, delivery: 'print', recipientEmail: '' });
  getCard(code).expiresAt = new Date(Date.now() + (EXPIRY_REMIND_DAYS - 1) * DAY).toISOString();
  const hit = sweepReservations(new Date()).expiringSoon.find((e) => e.code === code);
  assert.equal(hit.to, buyer.buyerEmail);
});

await test('a spent-out card is not reminded about', () => {
  const { code, card } = paidCard({ amount: 500 });
  spend(code, 500);
  card().expiresAt = new Date(Date.now() + (EXPIRY_REMIND_DAYS - 1) * DAY).toISOString();
  const hit = sweepReservations(new Date()).expiringSoon.filter((e) => e.code === code);
  assert.equal(hit.length, 0, 'the customer was chased about a card with nothing on it');
});

await test('a read-only sweep neither expires nor marks anybody reminded', () => {
  const { code, card } = paidCard();
  card().expiresAt = new Date(Date.now() - DAY).toISOString();
  const sweep = sweepReservations(new Date(), { readOnly: true });
  assert.equal(sweep.expired.filter((e) => e.code === code).length, 1, 'read-only must still report');
  assert.equal(getCard(code).status, STATUS.PAID, 'a read-only sweep expired a card');
  assert.equal(getCard(code).expiryRemindedAt, null);
});

// --- the paid extension -------------------------------------------------------

await test('an extension cannot be given away for free by accident', () => {
  const { code } = paidCard();
  const res = extendCard(code, {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unpaid_extension', 'thirty days were added with nobody accountable');
});

await test('extending early adds 30 days to the expiry, not to today', () => {
  const { code, card } = paidCard();
  const before = card().expiresAt;
  const res = extendCard(code, { paymentRef: 'HUB-EXT-1' });
  assert.equal(res.ok, true);
  const added = Math.round((Date.parse(res.expiresAt) - Date.parse(before)) / DAY);
  assert.equal(added, EXTENSION_DAYS, 'the customer paid for 30 days and lost the unused ones');
  assert.equal(card().extensions[0].feeGHS, EXTENSION_FEE_GHS);
});

await test('extending a lapsed card revives it and runs from today', () => {
  const { code, card } = paidCard({ amount: 500 });
  card().expiresAt = new Date(Date.now() - 5 * DAY).toISOString();
  sweepReservations(new Date());
  assert.equal(card().status, STATUS.EXPIRED);

  const res = extendCard(code, { paymentRef: 'HUB-EXT-2' });
  assert.equal(res.ok, true);
  assert.equal(card().status, STATUS.PAID, 'a paid extension left the card dead');
  const fromToday = Math.round((Date.parse(res.expiresAt) - Date.now()) / DAY);
  assert.equal(fromToday, EXTENSION_DAYS, 'the extension was eaten by the days already lost');
  assert.equal(spend(code, 100).ok, true, 'the revived card still could not be spent');
});

await test('an extension re-arms the reminder', () => {
  const { code, card } = paidCard({ amount: 500 });
  card().expiresAt = new Date(Date.now() + (EXPIRY_REMIND_DAYS - 1) * DAY).toISOString();
  sweepReservations(new Date());
  assert.ok(card().expiryRemindedAt, 'precondition: reminded once');
  extendCard(code, { paymentRef: 'HUB-EXT-3' });
  assert.equal(card().expiryRemindedAt, null, 'the holder would never be warned again');
});

await test('there is nothing to extend on an empty or unpaid card', () => {
  const { code } = paidCard({ amount: 500 });
  spend(code, 500);
  assert.equal(extendCard(code, { paymentRef: 'X' }).reason, 'no_balance');

  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  const [reserved] = basketCards(r.reference);
  assert.equal(extendCard(reserved.code, { paymentRef: 'X' }).reason, 'not_extendable');
});

// --- the tiered fee, the grace and the override --------------------------------
// Niobe, 29 Aug: a flat GHS 200 is more than some cards are worth. GHS 100 up to
// GHS 300, GHS 200 above, plus the free 3 days the desk already offers first.

await test('a small card is quoted the lower fee, a large one the higher', () => {
  const small = paidCard({ amount: 150 });
  const large = paidCard({ amount: 500 });
  assert.equal(quoteExtension(small.code).feeGHS, 100);
  assert.equal(quoteExtension(large.code).feeGHS, EXTENSION_FEE_GHS);
  // The boundary is inclusive — GHS 300 is "up to 300", not "above 300".
  const edge = paidCard({ amount: 300 });
  assert.equal(quoteExtension(edge.code).feeGHS, 100, 'the card AT the threshold was charged the higher fee');
});

await test('the fee follows what is left on the card, not what was paid for it', () => {
  const { code, card } = paidCard({ amount: 500 });
  assert.equal(extensionFee(card()), EXTENSION_FEE_GHS);
  spend(code, 400, { reason: 'Facial' });
  // GHS 100 left. Charging 200 to rescue 100 is charging for the privilege of losing.
  assert.equal(extensionFee(card()), 100);
});

await test('a fee that would swallow the balance is refused, not taken', () => {
  const { code } = paidCard({ amount: 500 });
  spend(code, 420, { reason: 'Massage' });   // GHS 80 left, cheapest fee is GHS 100
  const res = extendCard(code, { paymentRef: 'HUB-EXT-SMALL' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'fee_exceeds_value', 'the customer was charged more than the card was worth');
  assert.equal(res.balance, 80);
  // ...and the desk is told what it CAN offer instead.
  assert.equal(res.graceDays, GRACE_DAYS);
  assert.equal(quoteExtension(code).worthIt, false);
});

await test('the free 3 days are free, but they name the person who gave them', () => {
  const { code, card } = paidCard({ amount: 500 });
  const before = card().expiresAt;

  const anon = extendCard(code, { grace: true });
  assert.equal(anon.ok, false);
  assert.equal(anon.reason, 'grace_needs_staff', 'three days were given away by nobody in particular');

  const res = extendCard(code, { grace: true, by: 'Front desk — Esi' });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'grace');
  assert.equal(res.feeGHS, 0);
  assert.equal(Math.round((Date.parse(res.expiresAt) - Date.parse(before)) / DAY), GRACE_DAYS);
  assert.equal(card().extensions[0].quotedFeeGHS, EXTENSION_FEE_GHS, 'the waived fee was not recorded');
});

await test('the grace is once per card — a repeatable grace is no expiry at all', () => {
  const { code } = paidCard({ amount: 500 });
  assert.equal(extendCard(code, { grace: true, by: 'Esi' }).ok, true);
  const again = extendCard(code, { grace: true, by: 'Esi' });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'grace_already_used');
  assert.ok(again.graceUsedAt);
  assert.equal(quoteExtension(code).graceAvailable, false);
  // The paid extension is still on the table afterwards.
  assert.equal(extendCard(code, { paymentRef: 'HUB-EXT-AFTER-GRACE' }).ok, true);
});

await test('the grace revives a card that has already lapsed', () => {
  const { code, card } = paidCard({ amount: 500 });
  card().expiresAt = new Date(Date.now() - 2 * DAY).toISOString();
  sweepReservations(new Date());
  assert.equal(card().status, STATUS.EXPIRED, 'precondition');

  const res = extendCard(code, { grace: true, by: 'Manager — Yaw' });
  assert.equal(res.ok, true);
  assert.equal(card().status, STATUS.PAID);
  assert.equal(Math.round((Date.parse(res.expiresAt) - Date.now()) / DAY), GRACE_DAYS);
  assert.equal(spend(code, 100).ok, true);
});

await test('a discretionary fee needs a name AND a reason', () => {
  const { code, card } = paidCard({ amount: 500 });

  const waived = extendCard(code, { feeGHS: 0, paymentRef: 'HUB-X' });
  assert.equal(waived.ok, false);
  assert.equal(waived.reason, 'override_needs_staff_and_reason', 'the fee was waived with nobody accountable');
  assert.equal(waived.quotedFeeGHS, EXTENSION_FEE_GHS);

  const noReason = extendCard(code, { feeGHS: 50, by: 'Esi' });
  assert.equal(noReason.reason, 'override_needs_staff_and_reason');

  const ok = extendCard(code, { feeGHS: 50, by: 'Manager — Yaw', reason: 'Treatment cancelled by the branch' });
  assert.equal(ok.ok, true);
  assert.equal(ok.kind, 'override');
  assert.equal(ok.feeGHS, 50);
  // Both numbers are kept: what the policy said, and what was actually taken.
  assert.equal(card().extensions[0].quotedFeeGHS, EXTENSION_FEE_GHS);
  assert.equal(card().extensions[0].reason, 'Treatment cancelled by the branch');
});

await test('paying the quoted fee is not an override and needs no reason', () => {
  const { code } = paidCard({ amount: 150 });
  const res = extendCard(code, { feeGHS: 100, paymentRef: 'HUB-EXT-QUOTED' });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'paid');
  assert.equal(res.feeGHS, 100);
});

await test('the reminder quotes the price of THIS card', () => {
  const { code, card } = paidCard({ amount: 150, recipientEmail: 'kofi@example.com' });
  card().expiresAt = new Date(Date.now() + (EXPIRY_REMIND_DAYS - 1) * DAY).toISOString();
  const hit = sweepReservations(new Date()).expiringSoon.find((e) => e.code === code);
  assert.equal(hit.extendFeeGHS, 100, 'the holder of a GHS 150 card was quoted the GHS 200 fee');
});

await test('the tier table is ordered and open-ended', () => {
  assert.equal(EXTENSION_FEES[EXTENSION_FEES.length - 1].upTo, null, 'the top tier must catch every card above it');
  const caps = EXTENSION_FEES.map((t) => t.upTo ?? Infinity);
  assert.deepEqual(caps, [...caps].sort((a, b) => a - b), 'tiers are read cheapest-first and must be sorted');
});

// --- what the customer is told ------------------------------------------------

await test('an expired card reads as expired, not as invalid or missing', async () => {
  const { code, card } = paidCard({ amount: 500 });
  card().expiresAt = new Date(Date.now() - DAY).toISOString();
  const look = await lookupAnyCard(code);
  assert.equal(look.found, true, 'the holder was told their card does not exist');
  assert.equal(look.expired, true);
  assert.equal(look.valid, false);
  assert.equal(look.balance, 500, 'the holder cannot see what they are about to lose');
  // The bad news and the way out have to arrive together, or they phone the branch.
  assert.equal(look.extendable, true);
  assert.equal(look.extendFeeGHS, EXTENSION_FEE_GHS);
});

await test('a live card shows its expiry and how long is left', async () => {
  const { code } = paidCard({ amount: 500 });
  const look = await lookupAnyCard(code);
  assert.equal(look.valid, true);
  assert.equal(look.expired, false);
  assert.equal(look.daysLeft, VALID_DAYS);
  assert.equal(look.extendable, false, 'a live card must not be nagged to pay for an extension');
});

// --- mis-read codes off a printed voucher -------------------------------------
// New codes cannot contain O/0/I/1/L. The SimpleSpa cards already in customers' hands
// can, and cannot be reissued — so a mis-reading has to resolve, safely.

// Legacy cards are seeded by writing the ledger and reloading the module — which is
// how they will genuinely arrive when their existing data is imported.
let legacySeq = 0;
async function withLegacyCards(cards) {
  const raw = JSON.parse(readFileSync(join(dir, 'gift-cards.json'), 'utf8'));
  const paidOn = new Date().toISOString();
  for (const [code, balance] of Object.entries(cards)) {
    raw[code] = {
      code, status: 'paid', faceValue: balance, balance, currency: 'GHS',
      reference: `LEGACY-${++legacySeq}`, buyerName: 'Imported', buyerEmail: 'imported@example.com',
      gift: false, delivery: 'print', design: 'default', recipientName: '', recipientEmail: '',
      message: '', deliverOn: null, createdAt: paidOn, paidAt: paidOn,
      expiresAt: new Date(Date.now() + 60 * DAY).toISOString(),
      reserveExpiresAt: null, remindedAt: null, expiryRemindedAt: null,
      extensions: [], payment: { method: 'imported', at: paidOn }, transactions: [],
    };
  }
  writeFileSync(join(dir, 'gift-cards.json'), JSON.stringify(raw, null, 1));
  return import(`../src/cards.js?legacy=${legacySeq}`);
}

await test('a code mis-read off a printed voucher still finds the one card it can be', async () => {
  // DPB-QO0 is a real Alisa Hotel code — it contains both the letter O and a zero.
  const mod = await withLegacyCards({ 'NB-DPB-QO0': 620 });
  const look = await mod.lookupAnyCard('NB-DPB-Q0O');     // both characters mis-read
  assert.equal(look.found, true, 'a genuine voucher was refused over a printing ambiguity');
  assert.equal(look.balance, 620);
  assert.equal(look.correctedFrom, 'NB-DPB-Q0O', 'the correction was not disclosed');
});

await test('an ambiguous code is never guessed between two real cards', async () => {
  const mod = await withLegacyCards({ 'NB-AMBIG-O': 100, 'NB-AMBIG-0': 900 });
  // A spelling that matches neither exactly, but could be either by mis-reading.
  const look = await mod.lookupAnyCard('NB-AMBIG-L');
  assert.equal(look.found, false, "a stranger's card was matched by guesswork");
  // And an EXACT match must still win outright rather than being called ambiguous.
  const exact = await mod.lookupAnyCard('NB-AMBIG-O');
  assert.equal(exact.found, true);
  assert.equal(exact.balance, 100);
  assert.equal(exact.correctedFrom, undefined, 'an exact hit was reported as a correction');
});

await test('a genuinely unknown code is not rescued by variants', async () => {
  const mod = await withLegacyCards({});
  const look = await mod.lookupAnyCard('NB-NOPE-0000-1111');
  assert.equal(look.found, false);
});

console.log(results.join('\n'));
console.log(`\n${passed}/${results.length} passed  (reservation window ${RESERVE_HOURS}h, nudge at ${REMIND_HOURS}h)`);
rmSync(dir, { recursive: true, force: true });
