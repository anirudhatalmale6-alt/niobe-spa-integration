import { CONFIG } from './config.js';
import {
  getCard, publicCard, lookupAnyCard, voidCard, extendCard, quoteExtension,
  reserveBasket, markPaid, basketCards, mask, EXTENSION_DAYS, GRACE_DAYS,
} from './cards.js';
import { voucherHtml } from './voucher.js';

// The staff side of the gift-card ledger: look a card up, sell one over the counter, cancel
// one, extend one.
//
// cards.js has been able to do all four since August and nothing could reach any of them. That
// is the last thing standing between the November launch and a real card being sold: the day a
// customer asks for a refund, or turns up two days after their card lapsed, somebody at a desk
// has to be able to act — and "ring the developer" is not an answer at 6pm on a Saturday.
//
// EVERY action here takes a staff name and writes it down. Not a formality: these all move
// money on a bearer instrument, and a ledger that records what happened but not who did it is
// no use the one time it matters. cards.js already refuses a free grace or an off-price
// extension without a name; this page refuses one for every action, so the rule is the same
// wherever staff meet it rather than something they discover on the one screen that enforces it.

const money = (n) => `GHS ${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clean = (s) => String(s || '').trim();
const normCode = (s) => clean(s).toUpperCase().replace(/[\s_]+/g, '');

// Plain English for every refusal cards.js can return. The desk is talking to a customer while
// they read this, so "not_extendable" is not a message — it is a reason to telephone somebody.
const WHY = {
  not_found: 'No card with that code.',
  not_paid: 'That card has not been paid for, so there is nothing to cancel.',
  not_spendable: 'That card is not active.',
  not_extendable: 'Only a paid or expired card can be extended.',
  no_balance: 'That card has nothing left on it, so an extension would buy nothing.',
  grace_needs_staff: 'The free extension has to be given by a named member of staff.',
  grace_already_used: 'The free extension has already been used on this card, once is the limit.',
  override_needs_staff_and_reason: 'A different price to the quoted one needs your name and a reason.',
  unpaid_extension: 'Take the payment first, then enter its reference — or give the free days instead.',
  fee_exceeds_value: 'The fee is more than the card is worth. Give the free days, or ask a manager.',
  bad_days: 'That number of days is not allowed.',
  bad_amount: 'That amount is not valid.',
  insufficient: 'The card does not have that much on it.',
  unknown_reference: 'That order could not be found.',
};
const why = (r) => WHY[r] || `Could not do that (${r}).`;

// --- actions ----------------------------------------------------------------

export function deskLookup(rawCode) {
  const code = normCode(rawCode);
  if (!code) return null;
  const card = getCard(code);
  if (!card) return { found: false, code };
  return {
    found: true,
    card: publicCard(card),
    // The full history. Staff are usually looking at this because a customer disputes
    // something, and "spent GHS 120 at East Legon on 9 September against booking X" ends the
    // conversation in a way a current balance never does.
    transactions: card.transactions || [],
    buyer: { name: card.buyerName, email: card.buyerEmail, phone: card.buyerPhone },
    recipient: card.gift ? { name: card.recipientName, email: card.recipientEmail } : null,
    quote: quoteExtension(code),
    payment: card.payment || null,
  };
}

export function deskVoid({ code, reason, by }) {
  if (!clean(by)) return { ok: false, message: 'Please enter your name.' };
  if (!clean(reason)) return { ok: false, message: 'Please say why — this cancels real money.' };
  const r = voidCard(normCode(code), { reason: clean(reason), by: clean(by) });
  return r.ok ? { ok: true, message: 'Card cancelled. Its balance is now zero and it cannot be used.' }
              : { ok: false, message: why(r.reason) };
}

export function deskExtend({ code, by, reason, grace, feeGHS, paymentRef }) {
  if (!clean(by)) return { ok: false, message: 'Please enter your name.' };
  const isGrace = grace === 'true' || grace === true;
  const r = extendCard(normCode(code), {
    by: clean(by),
    reason: clean(reason),
    grace: isGrace,
    // Empty means "the quoted price". Sending 0 instead would read as a deliberate override
    // to zero, which is a different decision and needs a reason attached.
    feeGHS: isGrace ? 0 : (clean(feeGHS) === '' ? null : Number(feeGHS)),
    paymentRef: clean(paymentRef) || null,
  });
  if (!r.ok) return { ok: false, message: why(r.reason) };
  // Built from what extendCard actually returns — kind, expiresAt, daysLeft, feeGHS — rather
  // than from fields it was assumed to have. The first version of this line said "Extended by
  // undefined day(s)" to whoever was standing at the desk.
  const until = new Date(r.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const how = r.kind === 'grace' ? 'Free extension given'
    : r.kind === 'override' ? `Extended at ${money(r.feeGHS)} (quoted price was ${money(r.quotedFeeGHS)})`
    : `Extended for ${money(r.feeGHS)}`;
  return { ok: true, message: `${how}. Valid until ${until} — ${r.daysLeft} day(s) from today.` };
}

// Sell a card over the counter. The customer has already handed over money, so this creates it
// and marks it paid in one go — but through exactly the same two steps the website uses, so a
// counter card and a website card are the same kind of thing in the ledger, with the same
// expiry, the same balance and the same audit trail.
export function deskIssue({ amount, buyerName, buyerEmail, recipientName, design, by, paymentRef, branchId }) {
  if (!clean(by)) return { ok: false, message: 'Please enter your name.' };
  const value = Number(amount);
  if (!(value > 0)) return { ok: false, message: 'Enter the amount the customer paid.' };
  // Left EMPTY when they do not give one, rather than invented. See reserveBasket.
  let reserved;
  try {
    reserved = reserveBasket({
      buyerName: clean(buyerName) || 'Counter sale',
      buyerEmail: clean(buyerEmail),
      items: [{
        amount: value,
        forSelf: !clean(recipientName),
        recipientName: clean(recipientName),
        // Printed at the counter and handed over, so never emailed to a recipient.
        delivery: 'print',
        design: clean(design) || undefined,
      }],
      channel: 'counter',
    });
  } catch (e) {
    return { ok: false, message: e.message };
  }
  const paid = markPaid(reserved.reference, {
    paymentRef: clean(paymentRef) || `COUNTER-${reserved.reference}`,
    method: 'counter',
    by: clean(by),
  });
  if (!paid.ok) return { ok: false, message: why(paid.reason) };
  const card = basketCards(reserved.reference)[0];
  return {
    ok: true,
    code: card.code,
    message: `Card issued for ${money(value)}. Print the voucher and hand it over.`,
    voucherUrl: `/gift-card/voucher?code=${encodeURIComponent(card.code)}`,
  };
}

// --- the page ---------------------------------------------------------------

const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
 :root{--bg:#f6f1ec;--card:#fffdfb;--ink:#2b2320;--muted:#8b7d73;--line:#e9ddd2;--gold:#b08a54;--gold-deep:#8a6a3c;--ok:#3f7d5b;--bad:#a4442f}
 *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font-family:'Segoe UI',system-ui,sans-serif}
 .wrap{max-width:820px;margin:0 auto;padding:22px 16px 60px}
 h1{font-size:19px;margin:0 0 2px} .sub{color:var(--muted);font-size:13px;margin:0 0 18px}
 .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 16px}
 h2{font-size:15px;margin:0 0 12px;letter-spacing:.3px}
 label{display:block;font-size:12.5px;color:var(--muted);margin:10px 0 4px}
 input,select,textarea{width:100%;padding:11px 12px;border:1.5px solid var(--line);border-radius:10px;font-size:15px;background:#fff;font-family:inherit}
 button{background:var(--gold-deep);color:#fff;border:0;border-radius:10px;padding:11px 18px;font-size:15px;font-weight:600;cursor:pointer;margin-top:12px}
 button.ghost{background:transparent;color:var(--gold-deep);border:1.5px solid var(--gold)}
 button.danger{background:var(--bad)}
 .row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--line);font-size:14px}
 .row:last-child{border-bottom:0} .k{color:var(--muted)} .v{font-weight:600;text-align:right}
 .code{font-family:Consolas,'Courier New',monospace;font-size:19px;letter-spacing:1.5px;font-weight:700}
 .msg{border-radius:10px;padding:11px 14px;margin:0 0 14px;font-size:14px}
 .msg.ok{background:#eaf3ee;border:1px solid #bcd9c8;color:#2c5a42}
 .msg.bad{background:#fbeceb;border:1px solid #eccbc6;color:#8e3a29}
 .cols{display:flex;gap:14px;flex-wrap:wrap} .cols>*{flex:1 1 220px}
 table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
 td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)} th{color:var(--muted);font-weight:600}
 td.num{text-align:right;font-variant-numeric:tabular-nums}
 .pill{display:inline-block;font-size:11.5px;padding:3px 9px;border-radius:20px;font-weight:600}
 .pill.paid{background:#eaf3ee;color:#2c5a42} .pill.dead{background:#f2ece8;color:#7a6a60}
 .warn{color:var(--bad);font-weight:600}
</style></head><body><div class="wrap">${body}</div></body></html>`;

const messageBox = (m) => (m ? `<div class="msg ${m.ok ? 'ok' : 'bad'}">${esc(m.message)}${
  m.code ? ` <span class="code" style="font-size:15px">${esc(m.code)}</span>` : ''}${
  m.voucherUrl ? ` — <a href="${esc(m.voucherUrl)}" target="_blank" rel="noopener">print the voucher</a>` : ''}</div>` : '');

function cardPanel(found) {
  if (!found) return '';
  if (!found.found) {
    return `<div class="card"><h2>Not found</h2>
      <p style="color:var(--muted);font-size:14px;margin:0">No card in Niobe's own ledger with code
      <span class="code" style="font-size:14px">${esc(found.code)}</span>.
      If it is an older GiftUp or SimpleSpa card, check it on the
      <a href="/balance?code=${encodeURIComponent(found.code)}" target="_blank" rel="noopener">balance page</a>
      — those live in other systems and cannot be cancelled or extended from here.</p></div>`;
  }
  const c = found.card;
  const q = found.quote || {};
  const dead = ['voided', 'cancelled', 'expired'].includes(c.status);
  const tx = (found.transactions || []).map((t) => `<tr>
      <td>${esc(new Date(t.at).toLocaleString('en-GB', { timeZone: 'UTC' }))}</td>
      <td>${esc(t.type)}${t.reason ? ` — ${esc(t.reason)}` : ''}</td>
      <td class="num">${t.amount == null ? '' : esc(money(t.amount))}</td>
      <td class="num">${esc(money(t.balance))}</td>
      <td>${esc(t.by || t.ref || '')}</td></tr>`).join('');

  return `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <span class="code">${esc(c.code || c.masked)}</span>
      <span class="pill ${dead ? 'dead' : 'paid'}">${esc(c.status)}</span>
    </div>
    <div style="margin-top:12px">
      <div class="row"><span class="k">Balance</span><span class="v">${esc(money(c.balance))}</span></div>
      <div class="row"><span class="k">Originally</span><span class="v">${esc(money(c.faceValue))}</span></div>
      <div class="row"><span class="k">Expires</span><span class="v">${c.expiresAt
        ? esc(new Date(c.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }))
        : 'not paid for yet'}${c.daysLeft != null ? ` <span class="k">(${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'})</span>` : ''}</span></div>
      <div class="row"><span class="k">Bought by</span><span class="v">${esc(found.buyer?.name || '')}${found.buyer?.email ? ` <span class="k">${esc(found.buyer.email)}</span>` : ' <span class="k">no email — cannot be warned before it expires</span>'}</span></div>
      ${found.recipient ? `<div class="row"><span class="k">For</span><span class="v">${esc(found.recipient.name || '')}</span></div>` : ''}
      ${c.extensions ? `<div class="row"><span class="k">Extended</span><span class="v">${c.extensions} time(s)</span></div>` : ''}
    </div>
    ${tx ? `<table><tr><th>When</th><th>What</th><th class="num">Amount</th><th class="num">Left</th><th>Who / ref</th></tr>${tx}</table>` : ''}
    <p style="margin:14px 0 0"><a href="/gift-card/voucher?code=${encodeURIComponent(c.code || '')}" target="_blank" rel="noopener">Print the voucher</a></p>
  </div>

  ${c.status === 'paid' || c.status === 'expired' ? `
  <div class="cols">
    <div class="card">
      <h2>Extend it</h2>
      ${q.ok ? `<div class="row"><span class="k">Price for this card</span><span class="v">${esc(money(q.feeGHS))} for ${q.days} days</span></div>
      <div class="row"><span class="k">Free ${q.graceDays} days</span><span class="v">${q.graceAvailable ? 'available, once' : 'already used'}</span></div>
      ${q.worthIt === false ? '<p class="warn" style="font-size:13px;margin:10px 0 0">The fee is worth more than the card. Give the free days instead.</p>' : ''}` : ''}
      <form method="POST" action="/desk/cards">
        <input type="hidden" name="action" value="extend">
        <input type="hidden" name="code" value="${esc(c.code || '')}">
        <label>Your name</label><input name="by" required placeholder="Who is doing this">
        <label>Payment reference <span style="text-transform:none">(if they paid the fee)</span></label>
        <input name="paymentRef" placeholder="Receipt or transaction number">
        <label>Or a different price, with a reason</label>
        <div class="cols" style="gap:8px">
          <input name="feeGHS" inputmode="decimal" placeholder="Leave blank for the quoted price">
          <input name="reason" placeholder="Why">
        </div>
        <button type="submit">Extend for ${EXTENSION_DAYS} days</button>
        ${q.graceAvailable ? `<button class="ghost" type="submit" name="grace" value="true">Give the free ${GRACE_DAYS} days</button>` : ''}
      </form>
    </div>
    <div class="card">
      <h2>Cancel it</h2>
      <p style="color:var(--muted);font-size:13px;margin:0">This sets the balance to zero for good. Use it for a refund, a duplicate or a card issued in error — not for a card the customer has simply finished.</p>
      <form method="POST" action="/desk/cards">
        <input type="hidden" name="action" value="void">
        <input type="hidden" name="code" value="${esc(c.code || '')}">
        <label>Your name</label><input name="by" required placeholder="Who is doing this">
        <label>Why</label><input name="reason" required placeholder="Refunded / duplicate / issued in error">
        <button class="danger" type="submit">Cancel this card</button>
      </form>
    </div>
  </div>` : ''}`;
}

export function renderCardDesk({ query = '', found = null, message = null, designs = [] } = {}) {
  const designOptions = designs.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
  return shell('Gift cards — front desk', `
    <h1>Gift cards</h1>
    <p class="sub">Look one up, sell one over the counter, cancel or extend. Every action is recorded against your name.</p>
    ${messageBox(message)}

    <div class="card">
      <h2>Find a card</h2>
      <form method="GET" action="/desk/cards">
        <input name="code" value="${esc(query)}" autofocus placeholder="NB-XXXX-XXXX-XXXX" style="font-family:Consolas,'Courier New',monospace;letter-spacing:1px">
        <button type="submit">Look it up</button>
      </form>
    </div>

    ${cardPanel(found)}

    <div class="card">
      <h2>Sell a card at the counter</h2>
      <p style="color:var(--muted);font-size:13px;margin:0 0 4px">Take the money first, then fill this in. The card is live the moment you press the button, so do not press it until they have paid.</p>
      <form method="POST" action="/desk/cards">
        <input type="hidden" name="action" value="issue">
        <div class="cols">
          <div><label>Amount paid (GHS)</label><input name="amount" inputmode="decimal" required placeholder="500"></div>
          <div><label>Payment reference</label><input name="paymentRef" placeholder="Receipt number"></div>
        </div>
        <div class="cols">
          <div><label>Customer's name</label><input name="buyerName" placeholder="Who bought it"></div>
          <div><label>Their email <span style="text-transform:none">(optional)</span></label><input name="buyerEmail" type="email" placeholder="For the voucher and the expiry reminder"></div>
        </div>
        <div class="cols">
          <div><label>Gift for <span style="text-transform:none">(optional)</span></label><input name="recipientName" placeholder="Name on the card"></div>
          ${designOptions ? `<div><label>Design</label><select name="design">${designOptions}</select></div>` : ''}
        </div>
        <label>Your name</label><input name="by" required placeholder="Who is doing this">
        <button type="submit">Issue the card</button>
      </form>
      <p style="color:var(--muted);font-size:12.5px;margin:12px 0 0">Without an email address the card still works perfectly — it just cannot be emailed, and nobody can be warned before it expires. Print the voucher and hand it over.</p>
    </div>
  `);
}
