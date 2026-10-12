// Niobe's gift-card policy from 1 December 2026 (src/policy.js):
//   - no extensions of any kind, and none in advance for a card expiring on/after the date
//   - GHS 150 off the card (or what is left) for a late change or no-show, once per booking
//
// The policy date is read once at import, so the suite runs itself twice in child processes:
// BEFORE the date (it is 30 days away) and AFTER it (it was yesterday). Each phase uses its
// own empty data directory, so no live card is ever touched.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 24 * 3600 * 1000;
const ymd = (t) => new Date(t).toISOString().slice(0, 10);

if (!process.env.POLICY_PHASE) {
  let failed = 0, total = 0, ok = 0;
  for (const [phase, from] of [['before', ymd(Date.now() + 30 * DAY)], ['after', ymd(Date.now() - DAY)]]) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, POLICY_PHASE: phase, GIFTCARD_POLICY_FROM: from, NIOBE_DATA_DIR: mkdtempSync(join(tmpdir(), `niobe-policy-${phase}-`)) },
      encoding: 'utf8',
    });
    process.stdout.write(`\n${phase.toUpperCase()} the policy date (${from})\n${r.stdout}${r.stderr}`);
    const m = r.stdout.match(/(\d+)\/(\d+) phase/);
    if (!m || r.status !== 0) failed++;
    if (m) { ok += +m[1]; total += +m[2]; }
  }
  console.log(`\n${ok}/${total} passed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- one phase
const { reserveBasket, markPaid, basketCards, getCard, extendCard, quoteExtension, lookupAnyCard, chargeLateFee, sweepReservations } = await import('../src/cards.js');
const { policyInForce, extensionBlocked, lateFeeNotice, POLICY_FROM } = await import('../src/policy.js');
const { deskExtend, deskLateFee } = await import('../src/carddesk.js');
const { expiryReminderEmail } = await import('../src/cardsweep.js');
const { renderGiftRedeemProblem, renderBalanceExpired, renderGiftRedeemCheck } = await import('../src/views.js');

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); };

let n = 0;
function paidCard(amount = 500) {
  const r = reserveBasket({ buyerName: 'Ama', buyerEmail: 'ama@example.com', buyerPhone: '0244000000', items: [{ amount, design: 'floral-01', recipientName: 'Kofi', recipientEmail: 'kofi@example.com' }] });
  markPaid(r.reference, { paymentRef: `TEST-${++n}`, method: 'test' });
  return getCard(basketCards(r.reference)[0].code);
}
const at = (t) => new Date(t).toISOString();
const cutoff = Date.parse(`${POLICY_FROM}T00:00:00Z`);
const staff = { by: 'Akosua', paymentRef: 'RCPT-1' };

if (process.env.POLICY_PHASE === 'before') {
  ok(!policyInForce(), 'policy is not yet in force');

  const early = paidCard(); early.expiresAt = at(Date.now() + 10 * DAY);
  let r = extendCard(early.code, staff);
  ok(r.ok, 'a card expiring BEFORE the date can still be extended (paid)');

  const lapsed = paidCard(); lapsed.expiresAt = at(Date.now() - DAY);
  ok((await lookupAnyCard(lapsed.code)).extendable === true, 'an expired card is offered an extension on the balance page');
  ok(extendCard(lapsed.code, { by: 'Akosua', grace: true }).ok, 'the free grace still works before the date');

  const fresh = paidCard();   // 90 days from today — past the policy date
  ok(extendCard(fresh.code, staff).reason === 'expires_after_cutoff', 'a card expiring AFTER the date cannot be extended in advance');
  ok(extendCard(fresh.code, { by: 'Akosua', grace: true }).reason === 'expires_after_cutoff', '...not with the free grace either');
  ok(extendCard(fresh.code, { by: 'Manager', feeGHS: 0, reason: 'goodwill' }).reason === 'expires_after_cutoff', '...and not with a manager override');
  ok(quoteExtension(fresh.code).blocked === 'expires_after_cutoff' && !quoteExtension(fresh.code).graceAvailable, 'the desk quote says why, and offers no grace');

  ok(extensionBlocked(at(cutoff)) === 'expires_after_cutoff', 'a card expiring ON the date itself is affected');
  ok(extensionBlocked(at(cutoff - 60000)) === null, 'a card expiring the minute before the date is not');

  const d = deskExtend({ code: fresh.code, by: 'Akosua', paymentRef: 'R' });
  ok(!d.ok && /cannot be extended/.test(d.message), `the desk explains the refusal in words ("${d.message.slice(0, 60)}…")`);

  const soon = paidCard(); soon.expiresAt = at(Date.now() + 10 * DAY);
  const h = sweepReservations(new Date(), { readOnly: true }).expiringSoon.find((x) => x.masked && soon.code.endsWith(x.masked.slice(-4)));
  ok(h && h.extendFeeGHS != null && /extend it by/.test(expiryReminderEmail(h).html), 'the 14-day reminder still offers an extension before the date');

  const f = chargeLateFee(fresh.code, { kind: 'no_show', bookingRef: 'B1', by: 'Akosua' });
  ok(f.reason === 'fee_not_in_force' && getCard(fresh.code).balance === 500, 'no late fee can be taken before the date');
  ok(/^From \d/.test(lateFeeNotice()), 'the booking-page notice says "From 1 December 2026, ..."');
}

if (process.env.POLICY_PHASE === 'after') {
  ok(policyInForce(), 'policy is in force');

  const lapsed = paidCard(); lapsed.expiresAt = at(Date.now() - 3 * DAY);
  ok(extendCard(lapsed.code, staff).reason === 'extensions_ended', 'an expired card can no longer be extended (paid)');
  ok(extendCard(lapsed.code, { by: 'Akosua', grace: true }).reason === 'extensions_ended', '...nor given the free grace');
  ok(extendCard(lapsed.code, { by: 'Manager', feeGHS: 0, reason: 'goodwill' }).reason === 'extensions_ended', '...nor overridden by a manager');
  ok((await lookupAnyCard(lapsed.code)).extendable === false, 'the balance page no longer offers an extension');

  const live = paidCard(); live.expiresAt = at(Date.now() + 10 * DAY);
  ok(extendCard(live.code, staff).reason === 'extensions_ended', 'an in-date card cannot be extended either');

  const h = sweepReservations(new Date(), { readOnly: true }).expiringSoon.find((x) => x.masked && live.code.endsWith(x.masked.slice(-4)));
  const mail = h ? expiryReminderEmail(h).html : '';
  ok(h && h.extendFeeGHS === null, 'the 14-day reminder carries no extension price');
  ok(!/extend it by/.test(mail) && /can no longer be extended/.test(mail), 'the reminder says "book before the date", not "we can extend"');

  const page = renderGiftRedeemProblem({ reason: 'expired', booking: {} });
  ok(/can no longer be extended/.test(page) && !/we'll see what we can do/.test(page), 'the booking page no longer promises "we\'ll see what we can do"');
  const bal = renderBalanceExpired({ last4: '1234', balance: 300, expiresAt: at(Date.now() - DAY), extendable: false, extendFeeGHS: null });
  ok(/can no longer be extended/.test(bal), 'the balance page says the same');

  // The fee.
  const c = paidCard(500);
  let f = chargeLateFee(c.code, { kind: 'late_cancel', bookingRef: 'Ama 3 Dec 14:00', by: 'Akosua' });
  ok(f.ok && f.fee === 150 && getCard(c.code).balance === 350 && !f.partial, 'late cancellation: GHS 150 off a GHS 500 card leaves 350');
  f = chargeLateFee(c.code, { kind: 'late_cancel', bookingRef: 'Ama 3 Dec 14:00', by: 'Kwame' });
  ok(f.reason === 'fee_already_charged' && getCard(c.code).balance === 350, 'the same booking cannot be charged twice');
  f = chargeLateFee(c.code, { kind: 'no_show', bookingRef: 'Ama 9 Dec 10:00', by: 'Akosua' });
  ok(f.ok && getCard(c.code).balance === 200, 'a different booking is a different fee (no-show: 350 -> 200)');
  const tx = getCard(c.code).transactions.filter((t) => t.lateFee);
  ok(tx.length === 2 && tx.every((t) => t.by && t.ref), 'each fee is on the card\'s history with who took it and for which booking');

  const small = paidCard(500); small.balance = 90;
  f = chargeLateFee(small.code, { kind: 'late_reschedule', bookingRef: 'B-small', by: 'Akosua' });
  ok(f.ok && f.fee === 90 && f.partial && getCard(small.code).balance === 0, 'less than GHS 150 left: the fee takes what remains (90 -> 0)');
  ok(chargeLateFee(small.code, { kind: 'no_show', bookingRef: 'B-other', by: 'Akosua' }).reason === 'no_balance', 'an empty card has nothing to take');

  const x = paidCard();
  ok(chargeLateFee(x.code, { kind: 'no_show', bookingRef: 'B', by: '' }).reason === 'fee_needs_staff', 'the fee needs a staff name');
  ok(chargeLateFee(x.code, { kind: 'no_show', bookingRef: ' ', by: 'Akosua' }).reason === 'fee_needs_booking', '...and a booking');
  ok(chargeLateFee(x.code, { kind: 'whatever', bookingRef: 'B', by: 'Akosua' }).reason === 'bad_kind', '...and one of the three reasons');
  ok(chargeLateFee(lapsed.code, { kind: 'no_show', bookingRef: 'B', by: 'Akosua' }).reason === 'expired', 'nothing is taken off an expired card');
  ok(getCard(x.code).balance === 500, 'refused attempts took nothing');

  const dm = deskLateFee({ code: x.code, by: 'Akosua', kind: 'no_show', bookingRef: 'Kofi 4 Dec' });
  ok(dm.ok && /GHS 150|150\.00/.test(dm.message), `the desk confirms in words ("${dm.message}")`);

  const notice = lateFeeNotice();
  ok(!/^From/.test(notice) && /^If you need/.test(notice), 'after the date the notice drops "From ..." and reads as a sentence');
}

// Both phases: the booking page always carries the notice and the box.
const html = renderGiftRedeemCheck({ booking: { id: 'b1', service: 'Massage', price: 300 }, card: { code: 'NB-TEST' }, balance: 500, price: 300, options: [{ id: 'full', label: 'Pay in full', amount: 300 }] });
ok(/name="agree" value="yes" required/.test(html), 'the gift-card booking page has a required "I understand" box');
ok(html.includes('GHS 150') && html.includes('24 hours'), 'and the notice states the fee and the notice period');
ok(/Please tick the box/.test(renderGiftRedeemCheck({ booking: { id: 'b1' }, card: {}, balance: 1, price: 1, options: [{ id: 'full', label: 'x', amount: 1 }], agreeError: true })), 'posting without the tick re-shows the page asking for it');

console.log(`${pass}/${pass + fail} phase`);
process.exit(fail ? 1 : 0);
