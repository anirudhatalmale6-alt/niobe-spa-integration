import { CONFIG } from './config.js';
import { sweepReservations, clearReminder, clearReminderByReference, RESERVE_HOURS, EXPIRY_REMIND_DAYS, EXTENSION_DAYS } from './cards.js';
import { sendEmail } from './notify.js';

// The two clocks a gift card runs on, actually running.
//
// cards.js has always known how to do this — cancel an unpaid reservation at 48 hours, nudge
// the buyer halfway there, retire a card at 90 days, warn its holder 14 days out — and it is
// covered by 54 tests. What was missing is the part that calls it. Logic nothing invokes is
// indistinguishable from logic that does not exist: reservations pile up for ever and, worse,
// nobody is ever warned their gift is about to expire.
//
// Two different kinds of thing happen in here and they are deliberately not treated the same:
//
//   STATE CHANGES (cancel, expire) happen whether or not anyone can be emailed. A reservation
//   lapses at 48 hours because 48 hours have passed, not because we managed to send a message.
//
//   REMINDERS are only worth marking as sent if they were sent. sweepReservations stamps a
//   card reminded in the pass that decides it is due, so a mail outage lasting the ten seconds
//   the sweep runs would consume the 14-day warning silently. Any send that fails is un-marked
//   and picked up next time — retrying a reminder is harmless, never sending one is not.
//
// Starts in REPORT-ONLY, like the no-show release engine, and for the same reason: the first
// live run of anything that emails customers and cancels their orders should be one Niobe has
// watched for a few days first.

const money = (n) => `GHS ${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const wrap = (body) => `<div style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;
  color:#2b2320;line-height:1.6;max-width:520px">${body}
  <p style="color:#8b7d73;font-size:13px;margin-top:22px">Niobe Salon &amp; Spa — East Legon ·
  Cantonments · African Regent Hotel · HFC Community 18 · Alisa Hotel Tema</p></div>`;

// "Your order is about to lapse" — sent halfway to the 48-hour deadline.
function reserveReminderEmail(g) {
  return {
    subject: 'Your Niobe gift card order is waiting for payment',
    html: wrap(`<p>Hello ${esc(g.buyerName || 'there')},</p>
      <p>Your gift card order for <strong>${esc(money(g.total))}</strong> is still waiting for
      payment, and we hold it for ${RESERVE_HOURS} hours before it is released.</p>
      <p>If you still want it, you can complete the payment here:<br>
      <a href="${esc(CONFIG.publicUrl)}/gift-card">${esc(String(CONFIG.publicUrl || '').replace(/^https?:\/\//, ''))}/gift-card</a></p>
      <p>If you have changed your mind, you need do nothing at all.</p>`),
  };
}

// "Your card expires in 14 days" — the one that recovers a booking rather than announcing a
// loss, which is why it carries a way to book that does not involve telephoning a branch.
function expiryReminderEmail(h) {
  return {
    subject: `Your Niobe gift card expires in ${h.daysLeft} day${h.daysLeft === 1 ? '' : 's'}`,
    html: wrap(`<p>Hello ${esc(h.toName || 'there')},</p>
      <p>Your Niobe gift card has <strong>${esc(money(h.balance))}</strong> left on it and is
      valid until <strong>${esc(new Date(h.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }))}</strong>
      — that is ${h.daysLeft} day${h.daysLeft === 1 ? '' : 's'} from today.</p>
      <p><a href="${esc(h.bookUrl)}" style="display:inline-block;background:#8a6a3c;color:#fff;
      text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600">Book an appointment</a></p>
      <p style="color:#8b7d73;font-size:14px">If you cannot use it in time, we can extend it by
      ${EXTENSION_DAYS} days for ${esc(money(h.extendFeeGHS))} — just reply or call any branch
      before the date above.</p>`),
  };
}

// Sends one list, returns how many went. NEVER throws: a sweep that dies partway through
// leaves the rest of the month's cards untouched with nobody the wiser.
async function send(list, build, kind, unmark) {
  let sent = 0, failed = 0;
  for (const item of list) {
    const to = item.to || item.buyerEmail;
    // Nobody to write to. Not a failure to retry — retrying will find no address next time
    // either — but it must not pass silently, because it means somebody's card will expire
    // with no warning and we knew.
    if (!to) {
      console.log(`[gift-sweep] NO ADDRESS for a ${kind} reminder (${item.reference || item.masked || 'unknown'}) — nobody was warned`);
      continue;
    }
    const mail = build(item);
    let r;
    try { r = await sendEmail({ to, subject: mail.subject, html: mail.html }); }
    catch (e) { r = { ok: false, error: e.message }; }

    if (r.ok) { sent += 1; continue; }
    failed += 1;
    console.log(`[gift-sweep] ${kind} reminder NOT sent to ${to}: ${r.error}`);
    // Put it back so the next sweep tries again.
    unmark(item);
  }
  return { sent, failed };
}

export async function runCardSweep({ dryRun = CONFIG.giftcardSweepDryRun } = {}) {
  const r = sweepReservations(new Date(), { readOnly: dryRun });

  const totals = {
    cancelled: r.cancelled.length,
    expired: r.expired.length,
    forfeited: r.forfeited,
    remindReserve: r.remind.length,
    remindExpiry: r.expiringSoon.length,
    sent: 0,
    failed: 0,
    dryRun,
  };

  if (!dryRun) {
    // Un-marked by REFERENCE for a basket reminder and by CODE for a card reminder —
    // matching the granularity each one was decided at, so a retry covers exactly what failed.
    const a = await send(r.remind, reserveReminderEmail, 'reserve', (i) => clearReminderByReference(i.reference));
    const b = await send(r.expiringSoon, expiryReminderEmail, 'expiry', (i) => clearReminder(i.code, 'expiry'));
    totals.sent = a.sent + b.sent;
    totals.failed = a.failed + b.failed;
  }

  return { totals, detail: r };
}

let timer = null;

export function startCardSweepLoop() {
  if (!CONFIG.giftcardSweepEnabled) {
    console.log('[gift-sweep] DISABLED (GIFTCARD_SWEEP_ENABLED=false) — reservations will not lapse and nobody will be reminded');
    return () => {};
  }
  const everyMs = CONFIG.giftcardSweepMs;
  console.log(`[gift-sweep] ON — every ${Math.round(everyMs / 60000)}m, dryRun=${CONFIG.giftcardSweepDryRun}`
    + `, reservation window ${RESERVE_HOURS}h, expiry warning ${EXPIRY_REMIND_DAYS} days out`);

  const run = async () => {
    try {
      const { totals } = await runCardSweep();
      // Quiet when there is nothing to say. A line every fifteen minutes saying "0, 0, 0"
      // is how the one that matters gets scrolled past.
      if (totals.cancelled || totals.expired || totals.remindReserve || totals.remindExpiry) {
        console.log(`[gift-sweep] ${totals.cancelled} reservation(s) lapsed, ${totals.expired} card(s) expired`
          + ` (${money(totals.forfeited)} forfeited), ${totals.sent} reminder(s) sent`
          + `${totals.failed ? `, ${totals.failed} FAILED` : ''}${totals.dryRun ? ' [REPORT ONLY]' : ''}`);
      }
    } catch (e) {
      console.log(`[gift-sweep] error: ${e.message}`);
    }
  };

  timer = setInterval(run, everyMs);
  if (timer.unref) timer.unref();
  run();
  return () => { if (timer) clearInterval(timer); timer = null; };
}
