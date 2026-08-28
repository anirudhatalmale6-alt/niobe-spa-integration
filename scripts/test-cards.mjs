// Lifecycle tests for the gift-card ledger (src/cards.js).
//
// These exist because the failure being fixed here is invisible on the happy path: the
// site's current checkout looks completely fine if you only ever buy a card and pay for
// it. The bug lives in what happens when you DON'T pay. So most of what follows walks
// away from the payment on purpose.
//
// Run:  node scripts/test-cards.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'niobe-cards-'));
process.env.NIOBE_DATA_DIR = dir;
process.env.GIFTCARD_RESERVE_HOURS = '48';

const {
  reserveBasket, markPaid, spend, unspend, voidCard, sweepReservations,
  lookupAnyCard, getCard, basketCards, STATUS, RESERVE_HOURS, REMIND_HOURS,
} = await import('../src/cards.js');

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

await test('a paid card is never touched by the sweep', () => {
  const r = reserveBasket({ ...buyer, items: [oneCard()] });
  markPaid(r.reference, { paymentRef: 'HUB-124' });
  const [card] = basketCards(r.reference);
  assert.equal(card.reserveExpiresAt, null, 'a paid card must not keep a deadline');
  const farFuture = new Date(Date.now() + 400 * 24 * 3600 * 1000);
  sweepReservations(farFuture);
  assert.equal(getCard(card.code).status, STATUS.PAID, 'the sweep expired a paid card');
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

console.log(results.join('\n'));
console.log(`\n${passed}/${results.length} passed  (reservation window ${RESERVE_HOURS}h, nudge at ${REMIND_HOURS}h)`);
rmSync(dir, { recursive: true, force: true });
