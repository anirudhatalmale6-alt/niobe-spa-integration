import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CONFIG, branchById } from './config.js';
import { ghsPerUnit } from './fx.js';
import { csvRow, csvFile } from './csv.js';

// Reconciliation for money paid from abroad.
//
// A customer overseas is charged in GBP, but the booking is priced in cedis and the branch has
// to know one thing: HOW MANY CEDIS DOES THIS PAYMENT SETTLE? Until now nothing recorded that —
// the deposit log kept the cedi figure, Stripe kept the pound figure, and nothing joined them.
//
// Built from STRIPE OUTWARD, not from our own log inward. Stripe is the authority on what money
// actually arrived; our log only knows about payments this service saw through to the end. A
// payment that reached Stripe but never came back to us — customer closed the tab on the way
// back, service restarted mid-checkout — is exactly the case the branch is worried about, and
// listing from our own log is precisely what would hide it. Listing from Stripe makes it a row
// with a loud "not in our records" flag instead of silence.

const STRIPE_API = 'https://api.stripe.com/v1';
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

// ---------------------------------------------------------------------------
// Local records
// ---------------------------------------------------------------------------

// Read a JSON-lines log. The FIRST entry for a reference wins: finalize runs again whenever the
// customer refreshes the callback page, so the same payment is appended two or three times with
// identical amounts. Anyone adding up the raw file counts one GHS 650 deposit as GHS 1,950.
function readLog(file) {
  const path = join(DATA_DIR, file);
  if (!existsSync(path)) return new Map();
  const byRef = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e?.reference) continue;
    const prev = byRef.get(e.reference);
    // Keep the earliest record, but let a later one fill in fields the first one lacked
    // (an older deposit line has no price/customer — a re-finalise after this release does).
    byRef.set(e.reference, prev ? { ...e, ...prev, at: prev.at } : e);
  }
  return byRef;
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

async function stripeGet(path) {
  if (!CONFIG.stripeUkSecret) throw new Error('Stripe key not configured (STRIPE_UK_SECRET)');
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${CONFIG.stripeUkSecret}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || `Stripe ${res.status}`);
  return body;
}

// Every Checkout Session, with the fee and net settled amount pulled in alongside. The fee is
// only knowable from the balance transaction — the session says what the customer was charged,
// never what Niobe actually receives.
async function fetchSessions({ maxPages = 5 } = {}) {
  const out = [];
  let startingAfter = null;
  for (let page = 0; page < maxPages; page += 1) {
    const qs = new URLSearchParams({ limit: '100' });
    qs.append('expand[]', 'data.payment_intent.latest_charge.balance_transaction');
    if (startingAfter) qs.set('starting_after', startingAfter);
    const body = await stripeGet(`/checkout/sessions?${qs}`);
    out.push(...(body.data || []));
    if (!body.has_more || !body.data?.length) return { sessions: out, truncated: false };
    startingAfter = body.data[body.data.length - 1].id;
  }
  // Say so rather than quietly returning a partial history — a reconciliation that silently
  // stops at 500 payments is worse than one that admits where it stopped.
  return { sessions: out, truncated: true };
}

const obj = (v) => (v && typeof v === 'object' ? v : null);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const round2 = (n) => Math.round(n * 100) / 100;

export async function getIntlPayments({ includeUnpaid = false } = {}) {
  const deposits = readLog('deposits.log');
  const giftSales = readLog('gift-sales.log');
  const { sessions, truncated } = await fetchSessions();

  // Today's mid-market rate, for the "would this transfer still cover it?" column. Purely
  // informational — it must never change what a customer is credited.
  let liveRate = null;
  try { liveRate = await ghsPerUnit(CONFIG.intlCurrency || 'GBP'); } catch { /* leave null */ }

  const rows = [];
  let abandoned = 0;

  for (const s of sessions) {
    const paid = s.payment_status === 'paid' || (s.status === 'complete' && s.payment_status !== 'unpaid');
    if (!paid) { abandoned += 1; if (!includeUnpaid) continue; }

    const reference = s.client_reference_id || s.metadata?.reference || '';
    const dep = deposits.get(reference);
    const gift = giftSales.get(reference);
    const local = dep || gift || null;

    const pi = obj(s.payment_intent);
    const charge = obj(pi?.latest_charge);
    const bt = obj(charge?.balance_transaction);

    const chargedAmount = s.amount_total != null ? s.amount_total / 100 : null;
    const chargedCurrency = String(s.currency || '').toUpperCase();
    const fee = bt ? bt.fee / 100 : null;
    const net = bt ? bt.net / 100 : null;

    // The cedi figure is whatever was quoted when the customer paid — never a re-conversion of
    // the pounds at a later rate. The customer paid what was asked; if sterling has moved since,
    // that is Niobe's currency risk, not a debt the customer owes.
    // For a gift card that is `payableGHS` (face value + service fee) — what the buyer actually
    // handed over — not `amount`, which is only what the card is worth. Using the face value
    // here would under-report every gift-card sale by the service fee.
    const ghsCredited = (gift ? (gift.payableGHS ?? gift.amount) : local?.amount) ?? null;

    // Rate actually used at checkout. Recorded on the payment from this release onwards; for
    // older payments derive it from what was charged, undoing the FX buffer.
    let rateUsed = local?.chargeRate ?? null;
    let rateDerived = false;
    if (rateUsed == null && ghsCredited != null && chargedAmount) {
      const buffer = 1 + (Number(CONFIG.fxBufferPct) || 0) / 100;
      rateUsed = round2((ghsCredited * buffer) / chargedAmount);
      rateDerived = true;
    }

    // A gift card is always bought outright, so what was payable IS the price and nothing is
    // left owing. A deposit is the opposite case — that is the whole reason this column exists.
    const priceGHS = gift ? (gift.payableGHS ?? gift.amount ?? null) : (local?.price ?? null);
    // Only meaningful when we know the full price. A missing price must read as "unknown",
    // never as a zero balance — a zero balance tells the desk to collect nothing.
    const balanceDueGHS = priceGHS != null && ghsCredited != null
      ? round2(Math.max(0, priceGHS - ghsCredited)) : null;

    // The rate the GBP->GHS transfer has to achieve for this payment to cover its cedi value.
    // This is the treasury number: below it, the FX buffer was not enough.
    const breakEvenRate = ghsCredited != null && net ? round2(ghsCredited / net) : null;
    const headroomPct = breakEvenRate && liveRate
      ? round2(((liveRate - breakEvenRate) / breakEvenRate) * 100) : null;

    const branch = local?.branchId || s.metadata?.branchId || '';
    rows.push({
      reference,
      paidAt: s.created ? new Date(s.created * 1000).toISOString() : (local?.at || null),
      paid,
      kind: gift ? 'Gift card' : (dep ? 'Booking deposit' : (String(reference).split('-')[1] === 'GC' ? 'Gift card' : 'Booking deposit')),
      branchId: branch,
      branchName: branch ? (branchById(branch)?.name || branch) : '',
      appointmentId: local?.appointment_id || (s.metadata?.bookingId || '').split('~')[1] || '',
      customer: local?.customer || gift?.buyerName || s.customer_details?.name || '',
      email: s.customer_details?.email || s.customer_email || gift?.buyerEmail || '',
      service: local?.service || (gift ? `Gift card — GHS ${gift.amount} face value` : ''),
      cardCountry: charge?.payment_method_details?.card?.country || '',
      priceGHS,
      ghsCredited,
      balanceDueGHS,
      optionId: local?.optionId || null,
      chargedAmount,
      chargedCurrency,
      rateUsed,
      rateDerived,
      stripeFee: fee,
      stripeNet: net,
      breakEvenRate,
      headroomPct,
      settleCurrency: bt ? String(bt.currency).toUpperCase() : chargedCurrency,
      availableOn: bt?.available_on ? new Date(bt.available_on * 1000).toISOString().slice(0, 10) : null,
      receiptUrl: charge?.receipt_url || null,
      // Flags the desk needs to act on, rather than a single status word that would have to
      // answer two different questions at once.
      inOurRecords: !!local,
      confirmed: dep ? !!dep.confirmed : (gift ? !!gift.issued : null),
    });
  }

  rows.sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt)));

  // The other direction: something our log calls an international payment that Stripe has never
  // heard of. Should be impossible, which is the reason to check — if it is ever non-empty,
  // either the key points at the wrong Stripe account or a record was written that no money backs.
  const seen = new Set(rows.map((r) => r.reference));
  const orphanLocal = [...deposits.values(), ...giftSales.values()]
    .filter((e) => e.gateway === 'international' && !seen.has(e.reference))
    .map((e) => ({ reference: e.reference, at: e.at, amount: e.amount, branchId: e.branchId || '' }));

  const paidRows = rows.filter((r) => r.paid);
  return {
    generatedAt: new Date().toISOString(),
    currency: CONFIG.intlCurrency || 'GBP',
    fxBufferPct: CONFIG.fxBufferPct,
    liveRate,
    truncated,
    abandonedCheckouts: abandoned,
    orphanLocal,
    rows,
    summary: {
      payments: paidRows.length,
      chargedTotal: round2(paidRows.reduce((s, r) => s + (r.chargedAmount || 0), 0)),
      feeTotal: round2(paidRows.reduce((s, r) => s + (r.stripeFee || 0), 0)),
      netTotal: round2(paidRows.reduce((s, r) => s + (r.stripeNet || 0), 0)),
      ghsCreditedTotal: round2(paidRows.reduce((s, r) => s + (r.ghsCredited || 0), 0)),
      balanceDueTotal: round2(paidRows.reduce((s, r) => s + (r.balanceDueGHS || 0), 0)),
      unmatched: paidRows.filter((r) => !r.inOurRecords).length,
    },
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function intlPaymentsCsv(data) {
  const cur = data.currency;
  const lines = [];
  lines.push(csvRow(['Niobe Beauty — payments from abroad (Stripe)']));
  lines.push(csvRow([`Generated ${data.generatedAt} · read live from Stripe`]));
  lines.push(csvRow([`"Cedis credited" is the amount quoted to the customer when they paid — credit that figure, not a fresh conversion of the ${cur}.`]));
  lines.push(csvRow([`Stripe fee and net ${cur} are what Niobe actually receives. "Break-even rate" is the GHS per ${cur} the transfer to Ghana must achieve for the payment to cover its cedi value.`]));
  if (data.liveRate) lines.push(csvRow([`Today's mid-market rate: 1 ${cur} = ${round2(data.liveRate)} GHS · FX buffer charged at checkout: ${data.fxBufferPct}%`]));
  lines.push('');

  lines.push(csvRow([
    'Paid at', 'Reference', 'Type', 'Branch', 'Customer', 'Email', 'Service',
    'Service price (GHS)', 'Cedis credited (GHS)', 'Still to pay (GHS)',
    `Charged (${cur})`, `Rate used (GHS per ${cur})`, `Stripe fee (${cur})`, `Net received (${cur})`,
    `Break-even rate (GHS per ${cur})`, 'Headroom vs today %', 'Funds available from', 'Card country', 'In our records',
  ]));

  for (const r of data.rows) {
    if (!r.paid) continue;
    lines.push(csvRow([
      r.paidAt ? r.paidAt.replace('T', ' ').slice(0, 16) : '',
      r.reference, r.kind, r.branchName, r.customer, r.email, r.service,
      r.priceGHS ?? '', r.ghsCredited ?? '', r.balanceDueGHS ?? '',
      r.chargedAmount ?? '',
      r.rateUsed != null ? `${r.rateUsed}${r.rateDerived ? ' (derived)' : ''}` : '',
      r.stripeFee ?? '', r.stripeNet ?? '',
      r.breakEvenRate ?? '',
      r.headroomPct ?? '',
      r.availableOn || '', r.cardCountry || '',
      r.inOurRecords ? 'yes' : 'NO — not matched to a booking',
    ]));
  }

  const s = data.summary;
  lines.push('');
  lines.push(csvRow([
    '', `TOTAL — ${s.payments} payments`, '', '', '', '', '',
    '', s.ghsCreditedTotal, s.balanceDueTotal,
    s.chargedTotal, '', s.feeTotal, s.netTotal, '', '', '', '', '',
  ]));

  if (s.unmatched) {
    lines.push('');
    lines.push(csvRow([`WARNING: ${s.unmatched} payment(s) reached Stripe but are not matched to a booking in our records — the money arrived, the appointment may never have been confirmed. Check each one.`]));
  }
  if (data.orphanLocal.length) {
    lines.push('');
    lines.push(csvRow([`WARNING: ${data.orphanLocal.length} payment(s) recorded here are not present in this Stripe account: ${data.orphanLocal.map((o) => o.reference).join(', ')}`]));
  }
  if (data.truncated) {
    lines.push('');
    lines.push(csvRow(['NOTE: only the most recent 500 Stripe checkouts were read — older payments are not listed.']));
  }
  if (data.abandonedCheckouts) {
    lines.push('');
    lines.push(csvRow([`For information: ${data.abandonedCheckouts} checkout(s) from abroad were started but never paid. No money was taken for these.`]));
  }
  return csvFile(lines);
}

export function intlPaymentsCsvFilename(data) {
  return `niobe-payments-abroad-${data.generatedAt.slice(0, 10)}.csv`;
}
