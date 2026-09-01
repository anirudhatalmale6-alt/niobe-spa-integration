// Where the expiry date has to appear, and what it has to say.
//
// The bug these guard against is not a crash. It is a voucher that says "valid for
// 90 days" to somebody whose 90 days started six weeks ago, on a purchase they did
// not make. Nothing throws; the customer simply arrives at a branch with a card
// that lapsed while they were being told it hadn't.
import assert from 'node:assert/strict';
import { renderGiftCardSuccess, renderGiftCheckout } from '../src/views.js';
import { CONFIG } from '../src/config.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const DAY = 86400000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString();

const purchase = (over = {}) => ({
  reference: 'NB-REF-1', buyerEmail: 'buyer@example.com', buyerName: 'A Buyer',
  amount: 500, chargeAmount: 500, quantity: 1, gateway: 'paystack',
  ...over,
});
const card = (over = {}) => ({ code: 'NB-AAAA-BBBB-CCCC', ...over });

console.log('\nThe issued voucher\n');

await test('shows the real expiry DATE, not a duration', async () => {
  const html = renderGiftCardSuccess({
    purchase: purchase(), cards: [card({ expiresAt: iso(90), daysLeft: 90 })],
  });
  assert.match(html, /Valid until/, 'no "Valid until" row on the voucher');
  assert.equal(/Valid for\s*<\/span>/.test(html), false,
    'still quoting a duration on a card that has a real expiry date');
});

await test('the date shown is the card\'s own expiry, not 90 days from today', async () => {
  // A gift bought 60 days ago and delivered now: 30 days left, not 90.
  const expires = iso(30);
  const html = renderGiftCardSuccess({
    purchase: purchase({ gift: true, recipient: { name: 'R', email: 'r@example.com' } }),
    cards: [card({ expiresAt: expires, daysLeft: 30 })],
  });
  const shown = new Date(expires).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  assert.match(html, new RegExp(shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `the voucher does not show ${shown}`);
  const ninety = new Date(Date.now() + 90 * DAY).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  assert.equal(html.includes(ninety), false, 'showing 90 days from today instead of the card\'s expiry');
});

await test('a card close to expiry says how many days are left', async () => {
  const html = renderGiftCardSuccess({ purchase: purchase(), cards: [card({ expiresAt: iso(9), daysLeft: 9 })] });
  assert.match(html, /9 days left/, 'no days-left warning on a card with 9 days on it');
});

await test('a healthy card is NOT nagged with a countdown', async () => {
  const html = renderGiftCardSuccess({ purchase: purchase(), cards: [card({ expiresAt: iso(88), daysLeft: 88 })] });
  assert.equal(/days left/.test(html), false, 'counting down at 88 days makes the warning meaningless at 9');
});

await test('an expiry line is always present, even with no date on the card', async () => {
  // Never silently omit it: a voucher with no expiry printed reads as one without an expiry.
  const html = renderGiftCardSuccess({ purchase: purchase(), cards: [card()] });
  assert.match(html, /Valid for<\/span><span class="v">\d+ days from purchase/,
    'no expiry line at all when the card carries no date');
});

console.log('\nBefore payment\n');

await test('checkout states the validity and what it runs from', async () => {
  const html = renderGiftCheckout(purchase());
  assert.match(html, new RegExp(`${CONFIG.giftCardValidityDays} days from payment`),
    'checkout does not say how long the card lasts or when the clock starts');
});

await test('a scheduled delivery discloses the SHORTENED window', async () => {
  const html = renderGiftCheckout(purchase({
    gift: true, recipient: { name: 'R', email: 'r@example.com' }, scheduledFor: iso(6),
  }));
  const left = CONFIG.giftCardValidityDays - 6;
  assert.match(html, new RegExp(`leaves ${left} days`),
    `scheduling delivery 6 days out should disclose ${left} days, not ${CONFIG.giftCardValidityDays}`);
  assert.match(html, /run from today, not from delivery/, 'does not say the clock starts at payment');
});

await test('no delivery scheduled means no shortened-window noise', async () => {
  const html = renderGiftCheckout(purchase({ gift: true, recipient: { name: 'R', email: 'r@example.com' } }));
  assert.equal(/leaves \d+ days/.test(html), false, 'warning about a delivery date that was never set');
});

await test('a delivery date of today is not reported as a loss', async () => {
  const html = renderGiftCheckout(purchase({ scheduledFor: new Date().toISOString() }));
  assert.equal(/leaves \d+ days/.test(html), false, 'same-day delivery costs the recipient nothing');
});

await test('an unparseable delivery date is dropped, not rendered', async () => {
  // The first version of this asserted only that "NaN" and "Invalid Date" were absent.
  // It survived every sabotage, because prettyDate already swallows bad input — it was
  // testing prettyDate, not this function. The property that belongs to this code is
  // that a date it could not read produces no delivery row and no window claim at all.
  const html = renderGiftCheckout(purchase({ scheduledFor: 'not-a-date' }));
  assert.equal(/Delivered on/.test(html), false, 'rendered a delivery row from a date it could not parse');
  assert.equal(/leaves \d+ days/.test(html), false, 'quoted a shortened window off an unparseable date');
  assert.equal(/NaN|Invalid Date/.test(html), false, 'unparseable date leaked to the customer');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
