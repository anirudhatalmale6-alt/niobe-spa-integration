// The gift-card sweep: the 48-hour reservation clock and the 90-day expiry clock, actually
// running on a timer and actually sending the reminders.
//
// The lifecycle rules themselves are covered by test-cards.mjs. What is tested here is the
// part that was missing until now — the caller — and specifically the one behaviour that is
// easy to get wrong and impossible to notice: a reminder marked as sent when it was not.
//
// Run with:  node scripts/test-card-sweep.mjs

process.env.NIOBE_DATA_DIR ||= '/tmp/niobe-card-sweep-test';
process.env.PUBLIC_URL ||= 'https://pay.niobebeauty.com';
// No Graph credentials, so every send fails. That is the point: this is the outage.
delete process.env.GRAPH_TENANT_ID;

import { rmSync, mkdirSync } from 'fs';
rmSync(process.env.NIOBE_DATA_DIR, { recursive: true, force: true });
mkdirSync(process.env.NIOBE_DATA_DIR, { recursive: true });

const { reserveBasket, markPaid, basketCards, getCard, sweepReservations,
  clearReminder, clearReminderByReference } = await import('../src/cards.js');
const { runCardSweep } = await import('../src/cardsweep.js');

let pass = 0, fail = 0;
const logs = [];
const realLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };
const say = (...a) => realLog(...a);
function ok(name, cond, detail = '') {
  if (cond) { pass++; say(`  ok   ${name}`); }
  else { fail++; say(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HOUR = 3600 * 1000, DAY = 24 * HOUR;

function reserve(value = 500, email = 'buyer@example.com') {
  const r = reserveBasket({ buyerName: 'Kwesi', buyerEmail: email,
    items: [{ amount: value, forSelf: true, delivery: 'email' }] });
  return { reference: r.reference, code: basketCards(r.reference)[0].code };
}

say('\nReport-only mode changes nothing');
{
  const { reference, code } = reserve();
  getCard(code).reserveExpiresAt = new Date(Date.now() - HOUR).toISOString();   // overdue

  const { totals } = await runCardSweep({ dryRun: true });
  ok('a dry run reports the lapsed reservation', totals.cancelled === 1, JSON.stringify(totals));
  ok('but does NOT cancel it', getCard(code).status === 'reserved', getCard(code).status);
  ok('and sends nothing at all', totals.sent === 0 && totals.failed === 0);
  ok('it says it was report-only, so the log cannot be misread', totals.dryRun === true);
  clearReminderByReference(reference);
}

say('\nArmed, the reservation clock actually runs');
{
  const { code } = reserve();
  getCard(code).reserveExpiresAt = new Date(Date.now() - HOUR).toISOString();

  const { totals } = await runCardSweep({ dryRun: false });
  ok('an overdue reservation is cancelled', getCard(code).status === 'cancelled');
  ok('and reported', totals.cancelled >= 1);
  // A cancelled reservation must carry no value. It never had any — but if a later edit ever
  // made it, this is the assertion that catches it.
  ok('a cancelled reservation holds no money', getCard(code).balance === 0);
}

say('\nA reminder that could not be sent is NOT marked as sent');
{
  // This is the whole reason clearReminder exists. sweepReservations stamps a card reminded
  // in the same pass that decides it is due; if a ten-second mail outage coincides, the
  // holder never hears from us and the card expires with no warning.
  const { code } = reserve();
  // Inside the nudge window (half of 48h), not yet overdue.
  getCard(code).reserveExpiresAt = new Date(Date.now() + 6 * HOUR).toISOString();

  const { totals } = await runCardSweep({ dryRun: false });
  ok('the reminder was attempted', totals.remindReserve === 1, JSON.stringify(totals));
  ok('and it failed, because there is no mail configured', totals.failed === 1);
  ok('so the card is NOT stamped as reminded', getCard(code).remindedAt === null,
    String(getCard(code).remindedAt));

  // The proof that it will actually be retried: run again, same card, still due.
  const second = await runCardSweep({ dryRun: false });
  ok('the next sweep tries it again', second.totals.remindReserve === 1,
    JSON.stringify(second.totals));
}

say('\nThe expiry clock, and its 14-day warning');
{
  const { reference } = reserve(500, 'holder@example.com');
  markPaid(reference, { paymentRef: 'PAY-1', method: 'online' });
  const code = basketCards(reference)[0].code;

  // 10 days left — inside the 14-day warning window.
  getCard(code).expiresAt = new Date(Date.now() + 10 * DAY).toISOString();
  const a = await runCardSweep({ dryRun: false });
  ok('a card nearing expiry is picked up', a.totals.remindExpiry === 1, JSON.stringify(a.totals));
  ok('and the failed warning is not consumed either',
    getCard(code).expiryRemindedAt === null);

  // Past its date now.
  getCard(code).expiresAt = new Date(Date.now() - DAY).toISOString();
  const b = await runCardSweep({ dryRun: false });
  ok('a card past its date is expired', getCard(code).status === 'expired');
  ok('and the forfeited value is reported, not silently dropped',
    b.totals.forfeited === 500, String(b.totals.forfeited));
  // Left ON the record deliberately: it is the liability coming off Niobe's books.
  ok('the balance stays on the record as the forfeited amount',
    getCard(code).balance === 500);
}

say('\nAn empty card is not reminded about');
{
  const { reference } = reserve(500, 'spent@example.com');
  markPaid(reference, { paymentRef: 'PAY-2', method: 'online' });
  const code = basketCards(reference)[0].code;
  const { spend } = await import('../src/cards.js');
  spend(code, 500, { reason: 'spent in full' });
  getCard(code).expiresAt = new Date(Date.now() + 10 * DAY).toISOString();

  const r = sweepReservations(new Date(), { readOnly: true });
  // Reminding somebody about an empty card is noise, and noise is what trains people to
  // ignore the reminder that mattered.
  ok('a spent-out card gets no expiry warning',
    !r.expiringSoon.some((h) => h.code === code));
}

say('\nWhat gets written down');
{
  const withCode = logs.filter((l) => /NB-[A-Z0-9]{4}-/.test(l));
  ok('no full gift-card code is ever logged', withCode.length === 0, withCode[0] || '');
  ok('a failed reminder is logged loudly rather than swallowed',
    logs.some((l) => l.includes('NOT sent')), '');
}

console.log = realLog;
say(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
