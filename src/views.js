// Server-rendered customer-facing pages for the deposit flow.
// Shared styling with the staff dashboard (warm cream + gold Niobe palette).
import { displayName as GATEWAY, displayNameOf, backup } from './gateway.js';
import { CONFIG } from './config.js';

const GHS = (n) => `GHS ${Number(n).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const SYMBOLS = { GBP: '£', USD: '$', EUR: '€' };
const money = (n, cur = 'GHS') => cur === 'GHS'
  ? GHS(n)
  : `${SYMBOLS[cur] || cur + ' '}${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const feeLine = CONFIG.customerPaysFees ? ' Any transaction fee is added at checkout and paid by the customer.' : '';

const shell = (title, body, tag = CONFIG.paymentDemo ? `${GATEWAY} Test Mode` : '🔒 Secure checkout') => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
  :root{--bg:#f6f1ec;--card:#fffdfb;--ink:#2b2320;--muted:#8b7d73;--line:#e9ddd2;--gold:#b08a54;--gold-deep:#8a6a3c;--ok:#3f7d5b}
  *{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--ink);
    min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:34px 16px}
  .wrap{width:100%;max-width:520px}
  .brand{text-align:center;margin-bottom:18px}
  .brand .n{font-size:22px;font-weight:700;letter-spacing:.4px}
  .brand .t{color:var(--muted);font-size:13px;margin-top:2px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px 22px;box-shadow:0 6px 24px rgba(80,60,40,.06)}
  .row{display:flex;justify-content:space-between;padding:7px 0;font-size:14px;border-bottom:1px dashed var(--line)}
  .row:last-child{border-bottom:0}.row .k{color:var(--muted)}.row .v{font-weight:600;text-align:right}
  h2{margin:2px 0 14px;font-size:17px}
  .opt{display:flex;align-items:center;justify-content:space-between;border:1.5px solid var(--line);border-radius:12px;
    padding:14px 16px;margin:10px 0;cursor:pointer;background:#fff}
  .opt:hover{border-color:var(--gold)}
  .opt .lab{font-weight:600}.opt .amt{font-size:18px;font-weight:700;color:var(--gold-deep)}
  .opt .sub{font-size:12px;color:var(--muted);font-weight:400}
  .btn{display:block;width:100%;text-align:center;background:var(--gold-deep);color:#fff;border:0;border-radius:12px;
    padding:14px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;margin-top:6px}
  .btn:hover{background:#7a5c33}
  .btnAlt{display:block;width:100%;text-align:center;background:transparent;color:var(--gold-deep);border:1.5px solid var(--gold);
    border-radius:12px;padding:11px;font-size:13px;font-weight:600;cursor:pointer;margin-top:9px}
  .btnAlt:hover{background:#f7efe3}
  .note{font-size:12px;color:var(--muted);text-align:center;margin-top:14px;line-height:1.5}
  .tick{width:64px;height:64px;border-radius:50%;background:#e9f3ec;color:var(--ok);display:flex;align-items:center;
    justify-content:center;font-size:34px;margin:2px auto 12px}
  .ref{font-family:ui-monospace,Menlo,monospace;background:#f3e9dd;border:1px solid #ecdcbf;border-radius:8px;
    padding:8px 10px;font-size:13px;word-break:break-all;text-align:center;margin:10px 0}
  .badge{display:inline-block;font-size:11px;color:var(--gold-deep);background:#f4ead9;border:1px solid #ecdcbf;
    padding:2px 9px;border-radius:20px;margin-left:6px}
  .center{text-align:center}
  .demoTag{position:fixed;top:10px;right:12px;font-size:11px;color:#7a5c25;background:#fbf4e8;border:1px solid #ecdcbf;padding:3px 9px;border-radius:20px}
</style></head><body>${tag ? `<div class="demoTag">${tag}</div>` : ''}
<div class="wrap">${body}</div></body></html>`;

export function renderPayPage(bd) {
  const b = bd.booking;
  if (bd.exempt) {
    return shell('Booking secured', `<div class="brand"><div class="n">Niobe Beauty</div><div class="t">Booking confirmation</div></div>
    <div class="card center"><div class="tick">✓</div><h2>No deposit needed</h2>
    <p style="color:var(--muted);font-size:14px">This booking is covered by a gift card or account credit, so your slot is already secured. See you soon!</p></div>`);
  }
  const opts = bd.options.map((o) => `
    <label class="opt">
      <span><input type="radio" name="option" value="${o.id}" ${o.id === 'deposit' ? 'checked' : ''} style="margin-right:10px">
        <span class="lab">${o.label}</span><br><span class="sub">${o.id === 'deposit' ? 'Secure your slot now, pay the rest at your visit' : 'Nothing left to pay on the day'}</span></span>
      <span class="amt">${GHS(o.amount)}</span>
    </label>`).join('');
  return shell('Pay to confirm your booking', `
    <div class="brand"><div class="n">Niobe Beauty</div><div class="t">Secure your appointment</div></div>
    <div class="card">
      <div class="row"><span class="k">Service</span><span class="v">${b.service}</span></div>
      <div class="row"><span class="k">Therapist</span><span class="v">${b.therapist}</span></div>
      <div class="row"><span class="k">Branch</span><span class="v">${b.branchName}</span></div>
      <div class="row"><span class="k">Date &amp; time</span><span class="v">${b.datetime}</span></div>
      <div class="row"><span class="k">Total</span><span class="v">${GHS(bd.price)}</span></div>
      <h2 style="margin-top:18px">Choose how much to pay upfront</h2>
      <form method="POST" action="/pay/start">
        <input type="hidden" name="bookingId" value="${b.id}">
        ${opts}
        <button class="btn" type="submit">Continue to secure payment</button>
        ${backup ? `<button class="btnAlt" type="submit" name="gateway" value="${backup}">Having trouble? Pay with ${displayNameOf(backup)} instead</button>` : ''}
        ${CONFIG.intlCurrency ? `<button class="btnAlt" type="submit" name="gateway" value="international">Paying from abroad? Pay in ${CONFIG.intlCurrency}</button>` : ''}
      </form>
      <div class="note">Payments are processed securely by ${GATEWAY}${backup ? ` (or ${displayNameOf(backup)} as a backup)` : ''} — cards, mobile money and bank transfer.<br>A minimum of ${bd.options[0].amount ? Math.round((bd.options[0].amount / bd.price) * 100) : 50}% is required to hold your slot.${feeLine}</div>
    </div>`);
}

// Landing page from the email deposit link when the phone couldn't be pre-filled: ask for the
// mobile number the customer booked with (same as SimpleSpa's own "manage booking" sign-in).
export function renderPhoneEntry(branchId, branchName, note) {
  return shell('Pay your deposit', `
    <div class="brand"><div class="n">Niobe Beauty</div><div class="t">${branchName || 'Secure your appointment'}</div></div>
    <div class="card">
      <h2 style="margin-top:2px">Pay your deposit</h2>
      <p style="color:var(--muted);font-size:14px;margin:0 0 14px">Enter the mobile number you used when booking to bring up your appointment. No country code (e.g. +233) and no leading zero.</p>
      ${note ? `<div class="note" style="color:#b0492e;margin:0 0 12px">${note}</div>` : ''}
      <form method="GET" action="/pay">
        <input type="hidden" name="b" value="${branchId || ''}">
        <input name="ph" inputmode="tel" placeholder="24 123 4567" required
          style="width:100%;padding:13px 14px;border:1.5px solid var(--line);border-radius:12px;font-size:16px;margin-bottom:8px">
        <button class="btn" type="submit">Find my appointment</button>
      </form>
    </div>`);
}

// When one phone matches more than one upcoming unpaid appointment, let them pick.
export function renderChooser(list, branchName) {
  const rows = list.map((b) => `
    <a href="/pay?booking=${encodeURIComponent(b.id)}" style="text-decoration:none;color:inherit">
      <div class="opt" style="cursor:pointer">
        <span><span class="lab">${b.service}</span><br><span class="sub">${b.branchName} · ${b.datetime} · with ${b.therapist}</span></span>
        <span class="amt">${GHS(b.price)}</span>
      </div>
    </a>`).join('');
  return shell('Choose your appointment', `
    <div class="brand"><div class="n">Niobe Beauty</div><div class="t">${branchName || 'Secure your appointment'}</div></div>
    <div class="card"><h2 style="margin-top:2px">Which appointment?</h2>${rows}</div>`);
}

export function renderNoMatch(branchId, branchName) {
  return shell('No appointment found', `
    <div class="brand"><div class="n">Niobe Beauty</div><div class="t">${branchName || ''}</div></div>
    <div class="card center">
      <h2>We couldn't find an unpaid appointment</h2>
      <p style="color:var(--muted);font-size:14px">Please double-check the mobile number you booked with, or contact us and we'll be glad to help.</p>
      <a class="btnAlt" href="/pay?b=${branchId || ''}" style="margin-top:14px">Try another number</a>
    </div>`);
}

export function renderCheckout(pay, booking) {
  const name = displayNameOf(pay.gateway);
  const isIntl = pay.chargeCurrency && pay.chargeCurrency !== 'GHS';
  const chargeStr = money(pay.chargeAmount ?? pay.amount, pay.chargeCurrency || 'GHS');
  const amountRows = isIntl
    ? `<div class="row"><span class="k">Your deposit (secures your slot)</span><span class="v">${GHS(pay.amount)}</span></div>
       <div class="row"><span class="k">Charged to your card</span><span class="v">${chargeStr}</span></div>`
    : `<div class="row"><span class="k">Amount</span><span class="v">${GHS(pay.amount)}</span></div>`;
  return shell(`${name} Test Checkout`, `
    <div class="brand"><div class="n">${name} <span class="badge">TEST</span></div><div class="t">Simulated secure checkout</div></div>
    <div class="card">
      <div class="row"><span class="k">Pay to</span><span class="v">Niobe Beauty</span></div>
      <div class="row"><span class="k">Customer</span><span class="v">${booking.customer.email}</span></div>
      ${amountRows}
      <div class="row"><span class="k">Reference</span><span class="v" style="font-family:ui-monospace,monospace;font-size:12px">${pay.reference}</span></div>
      <form method="POST" action="/demo/pay" style="margin-top:16px">
        <input type="hidden" name="reference" value="${pay.reference}">
        <button class="btn" type="submit">Pay ${chargeStr} now</button>
      </form>
      <div class="note">${isIntl
        ? `You're securing a ${GHS(pay.amount)} deposit for your appointment; your card is charged the equivalent in ${pay.chargeCurrency}, settled to Niobe's UK account. `
        : `This is a simulated ${name} screen for testing. With live keys it becomes the real ${name} checkout (Card / Mobile Money / Bank). `}${feeLine}</div>
    </div>`, `${name} Test Mode`);
}

export function renderSuccess(result) {
  const b = result.booking || {};
  const pay = result.payment || {};
  const ref = b.paymentReference || pay.reference || '';
  const paid = b.paidAmount ?? pay.amount;
  const confirmed = result.confirm?.confirmed;
  const sim = result.confirm?.simulated;
  const statusLine = confirmed || sim
    ? `<div class="row"><span class="k">Booking status</span><span class="v" style="color:var(--ok)">Confirmed${sim ? ' · simulated' : ''}</span></div>`
    : '';
  const note = (confirmed || sim)
    ? `Your appointment has been confirmed with the reference above stamped against it${sim ? '. (Live confirmation activates once write access is enabled.)' : '.'}`
    : `Your deposit has been received and your slot is secured. The salon will finalise your booking — you'll be all set for your appointment. Please keep the reference above.`;
  return shell('Payment successful', `
    <div class="brand"><div class="n">Niobe Beauty</div><div class="t">Payment received</div></div>
    <div class="card center">
      <div class="tick">✓</div>
      <h2>Payment received — you're all set</h2>
      <div class="ref">${ref}</div>
      <div style="text-align:left;margin-top:8px">
        ${b.service ? `<div class="row"><span class="k">Service</span><span class="v">${b.service}</span></div>` : ''}
        ${b.branchName ? `<div class="row"><span class="k">Branch</span><span class="v">${b.branchName}</span></div>` : ''}
        ${b.datetime ? `<div class="row"><span class="k">Date &amp; time</span><span class="v">${b.datetime}</span></div>` : ''}
        ${paid != null ? `<div class="row"><span class="k">Paid</span><span class="v">${GHS(paid)}</span></div>` : ''}
        ${statusLine}
      </div>
      <div class="note">${note}</div>
    </div>`);
}
