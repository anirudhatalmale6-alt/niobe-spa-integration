// Bulk orders (client, 22 Oct 2026): 20 or more cards bought in ONE purchase are each valid for
// 120 days instead of 90; online orders can hold up to 20 cards; the counter can sell a bulk order
// as one sale with a printable sheet of codes.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.NIOBE_DATA_DIR = mkdtempSync(join(tmpdir(), 'niobe-bulk-'));
delete process.env.GIFTCARD_MAX_QUANTITY;

const { reserveBasket, markPaid, basketCards, validDaysFor } = await import('../src/cards.js');
const { deskIssue, renderCardSheet } = await import('../src/carddesk.js');
const { normaliseQuantity } = await import('../src/giftcards.js');
const { renderGiftCardPage } = await import('../src/views.js');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); };
const DAY = 864e5;
const daysLeft = (card) => Math.round((Date.parse(card.expiresAt) - Date.now()) / DAY);
const buyer = { buyerName: 'Acme Ltd', buyerEmail: 'hr@acme.example', buyerPhone: '0244000000' };
const order = (n) => {
  const r = reserveBasket({ ...buyer, items: Array.from({ length: n }, () => ({ amount: 200, design: 'add-01', forSelf: true, delivery: 'print' })) });
  markPaid(r.reference, { paymentRef: `T-${n}`, method: 'test' });
  return basketCards(r.reference);
};

ok(validDaysFor(1) === 90 && validDaysFor(19) === 90 && validDaysFor(20) === 120 && validDaysFor(94) === 120, 'the line is 20 or more: 19 -> 90 days, 20 -> 120 days');
const nineteen = order(19), twenty = order(20);
ok(nineteen.every((c) => daysLeft(c) === 90), 'an order of 19 cards: every card valid 90 days');
ok(twenty.every((c) => daysLeft(c) === 120), 'an order of 20 cards: every card valid 120 days');
ok(order(1).every((c) => daysLeft(c) === 90), 'a single card is still 90 days');

const d = deskIssue({ amount: 200, quantity: '20', buyerName: 'Acme Ltd', by: 'Akosua', paymentRef: 'RCPT-9' });
ok(d.ok && /20 cards issued/.test(d.message) && /120 days/.test(d.message) && d.sheetUrl, `counter sale of 20 = one sale, 120 days, with a code sheet ("${d.message}")`);
const ref = decodeURIComponent(d.sheetUrl.split('ref=')[1]);
const sold = basketCards(ref);
ok(sold.length === 20 && sold.every((c) => c.status === 'paid' && daysLeft(c) === 120 && c.payment.paymentRef === 'RCPT-9'), 'all 20 cards are paid, 120 days, under the one receipt number');
const sheet = renderCardSheet(ref);
ok(sheet && sold.every((c) => sheet.includes(c.code)) && /20 cards/.test(sheet), 'the printable sheet lists every code in the order');
ok(renderCardSheet('NO-SUCH-REF') === null, 'no sheet for an order that does not exist');
const unpaid = reserveBasket({ ...buyer, items: [{ amount: 200, forSelf: true, delivery: 'print' }, { amount: 200, forSelf: true, delivery: 'print' }] });
ok(renderCardSheet(unpaid.reference) === null, 'no sheet for an UNPAID order — unpaid codes are never shown');

ok(deskIssue({ amount: 200, by: 'Akosua' }).ok && /Card issued/.test(deskIssue({ amount: 200, by: 'Akosua' }).message), 'leaving "number of cards" empty still sells one card as before');
for (const bad of ['0', '-3', '2.5', 'ten', '201']) ok(!deskIssue({ amount: 200, quantity: bad, by: 'Akosua' }).ok, `"${bad}" cards is refused`);

ok(normaliseQuantity(20) === 20 && normaliseQuantity(25) === 20, 'online, one order can now hold up to 20 cards (25 is capped at 20)');

const catalog = { groups: [], items: [] };
ok(/120 days when you buy 20 or more/.test(renderGiftCardPage(catalog, null, { issuer: 'niobe' })), 'the own-system purchase page states the bulk rule');
ok(!/120 days/.test(renderGiftCardPage(catalog, null, { issuer: 'giftup' })), 'the GiftUp page does NOT promise 120 days (GiftUp sets its own expiry)');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
