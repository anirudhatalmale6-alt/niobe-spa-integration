// Spending one of OUR OWN gift cards against a booking.
//
// Until now the redemption flow could READ a card of ours (the balance page finds it) but
// could only DEDUCT from GiftUp. So a customer holding a card we issued could be told it was
// valid and worth GHS 500, redeem it, and have nothing taken off — the till short, the card
// still full. This is the money path, so it gets its own tests.
//
// Run with:  node scripts/test-own-redeem.mjs

process.env.NIOBE_DATA_DIR ||= '/tmp/niobe-own-redeem-test';
process.env.PUBLIC_URL ||= 'https://pay.niobebeauty.com';

import { rmSync, mkdirSync } from 'fs';
rmSync(process.env.NIOBE_DATA_DIR, { recursive: true, force: true });
mkdirSync(process.env.NIOBE_DATA_DIR, { recursive: true });

const { reserveBasket, markPaid, basketCards, getCard, spend, voidCard, extendCard } =
  await import('../src/cards.js');
const { checkOwnCard } = await import('../src/redeem.js');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A booking priced at GHS 400. Only the fields the check actually reads.
const booking = (price = 400, requireFull = false) => ({
  id: 'east_legon~appt-1', appointment_id: 'appt-1', branchId: 'east_legon',
  branchName: 'East Legon', service: 'Swedish Massage', price, requireFull,
});

// Issue a real paid card of `value` and hand back its code.
function paidCard(value, buyerEmail = 'buyer@example.com') {
  const r = reserveBasket({
    buyerName: 'Kwesi', buyerEmail, items: [{ amount: value, forSelf: true, delivery: 'email' }],
  });
  markPaid(r.reference, { paymentRef: `PAY-${r.reference}`, method: 'online' });
  return basketCards(r.reference)[0].code;
}

console.log('\nChecking one of our cards against a booking');
{
  // 400 booking, 50% deposit = 200, full = 400.
  const code = paidCard(500);
  const c = checkOwnCard(booking(), getCard(code), code);
  ok('a paid card of ours is accepted', c.ok && c.reason === 'ok');
  ok('and is marked as OURS, so the deduction goes to the right ledger', c.source === 'niobe');
  ok('the balance offered is the card balance', c.balance === 500);
  ok('both deposit options are affordable on a GHS 500 card',
    c.options.length === 2, JSON.stringify(c.options.map((o) => o.amount)));
  // The GiftUp branch reports a mirror balance because those cards live in two ledgers at
  // once. Ours do not, and claiming a mirror we never checked would be an invented fact.
  ok('no mirror balance is claimed for a card we issued',
    c.mirrorBalance === null && c.diverged === false);
}

console.log('\nWhat must be refused');
{
  const r = reserveBasket({
    buyerName: 'Kwesi', buyerEmail: 'buyer@example.com',
    items: [{ amount: 500, forSelf: true, delivery: 'email' }],
  });
  const reservedCode = basketCards(r.reference)[0].code;
  const c = checkOwnCard(booking(), getCard(reservedCode), reservedCode);
  // "Not found" rather than "not paid for". A reserved card's code was never released to
  // anybody, so if one is being presented something is wrong upstream — and explaining the
  // internals to whoever is holding it helps only them.
  ok('an unpaid reservation is refused, and gives nothing away',
    !c.ok && c.reason === 'not_found', c.reason);

  const voidCode = paidCard(500);
  voidCard(voidCode, { reason: 'test', by: 'tester' });
  ok('a voided card is refused',
    !checkOwnCard(booking(), getCard(voidCode), voidCode).ok);

  const smallCode = paidCard(50);
  const small = checkOwnCard(booking(), getCard(smallCode), smallCode);
  ok('a card that cannot cover the cheapest option is refused',
    !small.ok && small.reason === 'insufficient');
  ok('and the shortfall is a concrete number, not just "insufficient"',
    small.shortfall === 150, String(small.shortfall));

  // The rule that must not depend on a background job: expiry is evaluated from the DATE.
  const expiredCode = paidCard(500);
  const card = getCard(expiredCode);
  card.expiresAt = new Date(Date.now() - 86400000).toISOString();
  const exp = checkOwnCard(booking(), card, expiredCode);
  ok('an expired card is refused even though the sweep never ran',
    !exp.ok && exp.reason === 'expired', exp.reason);

  const spentCode = paidCard(500);
  spend(spentCode, 500, { reason: 'spent at the till' });
  ok('a fully spent card is refused',
    !checkOwnCard(booking(), getCard(spentCode), spentCode).reason.includes('ok'));
}

console.log('\nThe deduction itself');
{
  const code = paidCard(500);
  const before = getCard(code).balance;
  const r = spend(code, 200, { reference: 'NIOBE-EAST-1', reason: 'booking', branchId: 'east_legon' });
  ok('spending deducts exactly the amount', r.ok && r.spent === 200);
  ok('and the balance drops by it', getCard(code).balance === before - 200);

  // Refuses rather than clamps. Clamping would take "as much as is on the card" and leave
  // the till short by the difference with nobody told.
  const over = spend(code, 1000, { reference: 'x' });
  ok('spending more than the balance is refused, not clamped',
    !over.ok && over.reason === 'insufficient');
  ok('and nothing was taken', getCard(code).balance === before - 200);

  const tx = getCard(code).transactions.filter((t) => t.type === 'spend');
  ok('the spend is on the card\'s own transaction trail', tx.length === 1 && tx[0].amount === -200);
  ok('carrying the booking reference, so the till can be reconciled to it',
    tx[0].ref === 'NIOBE-EAST-1' && tx[0].branchId === 'east_legon');
}

console.log('\nA card of ours never goes to GiftUp');
{
  // The point of looking our ledger up FIRST. With no GiftUp key configured a lookup there
  // throws, which the flow reports as "we could not check" — so if one of our cards fell
  // through to it, a customer holding a perfectly good card would be told exactly that.
  const code = paidCard(500);
  ok('getCard finds it without any network call at all', !!getCard(code));
  ok('an unknown code is not claimed by our ledger', getCard('NB-ZZZZ-ZZZZ-ZZZZ') === null);
  // Ownership is decided by lookup, not by the "NB-" prefix — a prefix test silently stops
  // being true the day the code format changes.
  ok('a GiftUp-shaped code is not claimed by our ledger', getCard('ABC123XYZ') === null);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
