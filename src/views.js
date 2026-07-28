// Server-rendered customer-facing pages for the deposit flow.
// Shared styling with the staff dashboard (warm cream + gold Niobe palette).
import { displayName as GATEWAY } from './gateway.js';

const GHS = (n) => `GHS ${Number(n).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shell = (title, body) => `<!doctype html><html lang="en"><head>
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
  .note{font-size:12px;color:var(--muted);text-align:center;margin-top:14px;line-height:1.5}
  .tick{width:64px;height:64px;border-radius:50%;background:#e9f3ec;color:var(--ok);display:flex;align-items:center;
    justify-content:center;font-size:34px;margin:2px auto 12px}
  .ref{font-family:ui-monospace,Menlo,monospace;background:#f3e9dd;border:1px solid #ecdcbf;border-radius:8px;
    padding:8px 10px;font-size:13px;word-break:break-all;text-align:center;margin:10px 0}
  .badge{display:inline-block;font-size:11px;color:var(--gold-deep);background:#f4ead9;border:1px solid #ecdcbf;
    padding:2px 9px;border-radius:20px;margin-left:6px}
  .center{text-align:center}
  .demoTag{position:fixed;top:10px;right:12px;font-size:11px;color:#7a5c25;background:#fbf4e8;border:1px solid #ecdcbf;padding:3px 9px;border-radius:20px}
</style></head><body><div class="demoTag">${GATEWAY} Test Mode</div>
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
      </form>
      <div class="note">Payments are processed securely by ${GATEWAY} — cards, mobile money and bank transfer.<br>A minimum of ${bd.options[0].amount ? Math.round((bd.options[0].amount / bd.price) * 100) : 50}% is required to hold your slot.</div>
    </div>`);
}

export function renderCheckout(pay, booking) {
  return shell(`${GATEWAY} Test Checkout`, `
    <div class="brand"><div class="n">${GATEWAY} <span class="badge">TEST</span></div><div class="t">Simulated secure checkout</div></div>
    <div class="card">
      <div class="row"><span class="k">Pay to</span><span class="v">Niobe Beauty</span></div>
      <div class="row"><span class="k">Customer</span><span class="v">${booking.customer.email}</span></div>
      <div class="row"><span class="k">Amount</span><span class="v">${GHS(pay.amount)}</span></div>
      <div class="row"><span class="k">Reference</span><span class="v" style="font-family:ui-monospace,monospace;font-size:12px">${pay.reference}</span></div>
      <form method="POST" action="/demo/pay" style="margin-top:16px">
        <input type="hidden" name="reference" value="${pay.reference}">
        <button class="btn" type="submit">Pay ${GHS(pay.amount)} now</button>
      </form>
      <div class="note">This is a simulated ${GATEWAY} screen for testing. With live test keys it becomes the real ${GATEWAY} checkout (Card / Mobile Money / Bank).</div>
    </div>`);
}

export function renderSuccess(result) {
  const b = result.booking;
  const sim = result.confirm?.simulated;
  return shell('Payment successful', `
    <div class="brand"><div class="n">Niobe Beauty</div><div class="t">Booking confirmed</div></div>
    <div class="card center">
      <div class="tick">✓</div>
      <h2>Payment received — you're all set</h2>
      <div class="ref">${b.paymentReference}</div>
      <div style="text-align:left;margin-top:8px">
        <div class="row"><span class="k">Service</span><span class="v">${b.service}</span></div>
        <div class="row"><span class="k">Branch</span><span class="v">${b.branchName}</span></div>
        <div class="row"><span class="k">Date &amp; time</span><span class="v">${b.datetime}</span></div>
        <div class="row"><span class="k">Paid</span><span class="v">${GHS(b.paidAmount)}</span></div>
        <div class="row"><span class="k">SimpleSpa status</span><span class="v" style="color:var(--ok)">Confirmed (20)${sim ? ' · simulated' : ''}</span></div>
      </div>
      <div class="note">Your appointment has been automatically confirmed in SimpleSpa with the reference above stamped against it${sim ? '. (Live confirmation activates once the branch API key is in Write mode.)' : '.'}</div>
    </div>`);
}
