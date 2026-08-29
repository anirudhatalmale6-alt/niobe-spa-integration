import { depositOptions, isAmountAllowed, makeReference, serviceRequiresFull } from './deposit.js';
import { initializeTransaction, verifyTransaction } from './gateway.js';
import { confirmAppointment } from './confirm.js';
import { convertFromGHS } from './fx.js';
import { BRANCHES, CONFIG, branchById } from './config.js';
import { ssPost, findClientPayments } from './simplespa.js';
import { isCreditClient } from './credit.js';
import { registerHold, markSecured } from './holds.js';
import { sendAlreadyPaidEmail } from './notify.js';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Durable record of every successful deposit — so a paid booking is never lost even if the
// SimpleSpa auto-confirm write is unavailable at the time (write API not yet enabled, or a
// transient error). Staff/we can reconcile from this and re-confirm once writes are on.
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
function recordPaidDeposit(entry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, 'deposits.log'), JSON.stringify(entry) + '\n');
  } catch { /* logging must never break the payment flow */ }
  if (!entry.confirmed) {
    console.log(`[deposit] PAID but NOT auto-confirmed (${entry.reason || ''}): ref=${entry.reference} branch=${entry.branchId} appt=${entry.appointment_id} amount=${entry.amount}`);
  }
}

// Durable queue of customers who self-selected "paying with account credit" on the pay page.
// These take NO deposit and are NEVER auto-confirmed — staff must verify the account actually
// holds credit and then confirm the appointment manually. The log is the staff work-list.
function recordCreditClaim(entry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, 'credit-claims.log'), JSON.stringify(entry) + '\n');
  } catch { /* logging must never break the customer flow */ }
  console.log(`[already-paid:${entry.kind || 'credit'}] booking=${entry.bookingId} branch=${entry.branchId} appt=${entry.appointment_id} phone=${entry.phone} — needs staff verify + manual confirm`);
}

// What this client has paid for recently, appended against the claim above once SimpleSpa
// answers. Separate line, same bookingId, so the slow lookup can never delay the customer.
function recordClaimEvidence(entry) {
  const found = (entry.evidence || []).length;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, 'credit-claims.log'), JSON.stringify({ event: 'evidence', at: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* logging must never break the customer flow */ }
  const packages = (entry.evidence || []).filter((e) => e.looksLikePackage).length;
  console.log(`[already-paid] evidence booking=${entry.bookingId} — ${found} payment${found === 1 ? '' : 's'} on "${entry.customer}" in the last 180 days${packages ? `, ${packages} look like a package` : ''}`);
}

// A booking here is an existing SimpleSpa appointment that this service attaches a deposit
// payment to. Live (DEMO_MODE=false) it is read from SimpleSpa's appointments.php by the
// customer's branch + mobile number; in demo we seed a couple so the flow can be walked.
const bookings = new Map();      // booking id -> booking object (cache)
const payments = new Map();      // reference   -> payment record

// Pending payments have to survive a restart. A customer sent to Hubtel or Stripe can take
// twenty minutes to come back — a Stripe checkout stays open for a day — and this service is
// restarted on every deploy. Held only in memory, that window ends with someone who has really
// paid being told "Unknown payment reference", with the money taken and the slot released.
const PAYMENTS_FILE = join(DATA_DIR, 'payments.json');
const KEEP_PAYMENTS = 500;       // plenty of history; keeps the file small enough to rewrite
function loadPayments() {
  try {
    for (const p of JSON.parse(readFileSync(PAYMENTS_FILE, 'utf8'))) {
      if (p?.reference) payments.set(p.reference, p);
    }
  } catch { /* no file yet, or unreadable — start empty rather than refuse to boot */ }
}
function savePayments() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const all = [...payments.values()].slice(-KEEP_PAYMENTS);
    // Write then rename: a crash midway through leaves the previous good file in place
    // instead of a truncated one that would lose every in-flight payment at once.
    const tmp = `${PAYMENTS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(all));
    renameSync(tmp, PAYMENTS_FILE);
  } catch { /* persistence must never break the payment flow */ }
}
loadPayments();

// Statuses that mean the appointment is already dealt with (no deposit to collect):
// 15 Cancelled, 17 No-Show, 20 Confirmed, 22 Confirmed (No SMS), 25 Arrived, 30 Paid.
// Anything else (Rebooked, Online, …) with a real client can still take a deposit.
const SETTLED_STATUS = new Set([15, 17, 20, 22, 25, 30]);

const last9 = (s) => String(s || '').replace(/\D/g, '').slice(-9);
// Live booking ids are `<branchId>~<appointment_id>` so a booking can be re-fetched from
// SimpleSpa by id alone (e.g. after a restart between viewing the page and paying).
const makeBookingId = (branchId, apptId) => `${branchId}~${apptId}`;

function seed() {
  const samples = [
    { id: 'APT-1001', appointment_id: 'e3b0c44298fc1c149afbf4c8996fb924', branchId: 'east_legon', branchName: 'East Legon',
      service: 'Deep Tissue Massage (60 min)', price: 120, therapist: 'Ama', datetime: '2026-08-02 10:00',
      customer: { name: 'Akosua Mensah', email: 'akosua@example.com', phone: '233241234567' } },
    { id: 'APT-1002', appointment_id: 'a17f9c2b44d94e01b2c8f7ea1d5c3300', branchId: 'cantonments', branchName: 'Cantonments',
      service: 'Classic Facial (45 min)', price: 90, therapist: 'Efua', datetime: '2026-08-03 14:30',
      customer: { name: 'Kwabena Osei', email: 'kwabena@example.com', phone: '233209876543' } },
  ];
  for (const s of samples) {
    const creditExempt = isCreditClient(s.customer.phone);
    bookings.set(s.id, { ...s, status: 'pending', creditExempt, giftCardOrCredit: creditExempt });
  }
}
if (CONFIG.demoMode) seed();

// --- Live SimpleSpa reads -------------------------------------------------

// Per-branch service price maps (appointments.php carries no price), cached briefly.
// Keyed BOTH by service_id and by normalised name, because a live appointment can
// reference a service_id that is no longer in the branch's current services.php
// (renamed/re-created service) even though the same service name is still priced —
// this is what caused C18 bookings to show "no unpaid appointment" (price fell to
// 0 and the booking was dropped). We resolve price by id → branch name → global name.
const serviceCache = new Map(); // branchId -> { at, idMap, nameMap }
const SERVICE_TTL_MS = 10 * 60 * 1000;
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function servicePriceMaps(branch) {
  const hit = serviceCache.get(branch.id);
  if (hit && Date.now() - hit.at < SERVICE_TTL_MS) return hit;
  const res = await ssPost(branch, 'services.php', { per_page: 1000 });
  const arr = res.services || Object.values(res).find(Array.isArray) || [];
  const idMap = new Map();
  const nameMap = new Map();
  for (const s of arr) {
    const price = Number(s.price) || 0;
    idMap.set(String(s.service_id), { name: s.name, price });
    const k = normName(s.name);
    // keep the highest priced entry for a duplicated name within a branch
    if (price > 0 && (!nameMap.has(k) || price > nameMap.get(k))) nameMap.set(k, price);
  }
  const entry = { at: Date.now(), idMap, nameMap };
  serviceCache.set(branch.id, entry);
  return entry;
}

// Global normalised-name → price fallback, for services a booking references that
// aren't in that branch's own catalog at all. Built across every branch (East
// Legon first as the fullest, canonical catalog), keeping the first non-zero
// price per name. Cached with the same TTL.
let globalNameCache = { at: 0, map: new Map() };
async function globalNamePrice() {
  if (Date.now() - globalNameCache.at < SERVICE_TTL_MS && globalNameCache.map.size) return globalNameCache.map;
  const ordered = [...BRANCHES].sort((a, b) => (a.id === 'east_legon' ? -1 : b.id === 'east_legon' ? 1 : 0));
  const map = new Map();
  for (const b of ordered) {
    try {
      const { nameMap } = await servicePriceMaps(b);
      for (const [k, price] of nameMap) if (!map.has(k)) map.set(k, price);
    } catch { /* skip a branch we can't read */ }
  }
  globalNameCache = { at: Date.now(), map };
  return map;
}

// Resolve a live appointment's price: exact service_id → same-branch name →
// global name. Returns { name, price, source }.
export async function resolveServicePrice(branch, appt) {
  const { idMap, nameMap } = await servicePriceMaps(branch);
  const byId = idMap.get(String(appt.service?.service_id));
  const apptName = appt.service?.service_name || byId?.name || '';
  if (byId && byId.price > 0) return { name: byId.name, price: byId.price, source: 'id' };
  const k = normName(apptName);
  if (k && nameMap.has(k)) return { name: apptName, price: nameMap.get(k), source: 'branch_name' };
  const g = await globalNamePrice();
  if (k && g.has(k)) return { name: apptName, price: g.get(k), source: 'global_name' };
  return { name: apptName || byId?.name || 'Your service', price: byId?.price || 0, source: 'none' };
}

const ymd = (d) => d.toISOString().slice(0, 10);

// Pull the branch's upcoming appointments across a window (paginated). No server-side status
// filter — SimpleSpa "blocks" share status 0 (New) but carry no client, so we filter by the
// customer's phone (blocks never match) and drop already-settled statuses client-side.
async function fetchUpcomingAppointments(branch) {
  const now = Date.now();
  const start = ymd(new Date(now - 86400000));      // include yesterday for TZ safety
  const end = ymd(new Date(now + 90 * 86400000));   // up to ~3 months out
  const all = [];
  for (let page = 1; page <= 6; page++) {
    const res = await ssPost(branch, 'appointments.php', { start, end, page, per_page: 1000 });
    const items = res.appointments || Object.values(res).find(Array.isArray) || [];
    all.push(...items);
    const total = res.total_results ?? all.length;
    if (all.length >= total || items.length === 0) break;
  }
  return all;
}

async function toBooking(branch, appt) {
  const svc = await resolveServicePrice(branch, appt);
  const name = `${appt.client?.first_name || ''} ${appt.client?.last_name || ''}`.trim() || 'Guest';
  const phone = appt.client?.mobile || '';
  // SimpleSpa's appointment/client API exposes no credit or gift-card flag, so we rely on a
  // staff-controlled allow-list (see credit.js): listed numbers pay from account credit and
  // are NOT asked for a deposit — their booking is confirmed manually by staff.
  const creditExempt = isCreditClient(phone);
  const b = {
    id: makeBookingId(branch.id, appt.appointment_id),
    appointment_id: appt.appointment_id,
    branchId: branch.id,
    branchName: branch.name,
    service: appt.service?.service_name || svc.name || 'Your service',
    price: svc.price,
    priceSource: svc.source,
    therapist: appt.staff?.staff_name || '',
    datetime: appt.start,
    customer: { name, email: appt.client?.email || '', phone },
    status: 'pending',
    requireFull: serviceRequiresFull(appt.service?.service_name || svc?.name),
    creditExempt,
    // giftCardOrCredit drives the "no deposit" path in depositOptions; for credit clients it
    // is set from the allow-list above.
    giftCardOrCredit: creditExempt,
  };
  bookings.set(b.id, b);
  // This appointment has now been seen by our booking funnel → track it so the
  // release engine can hold/release it (walk-ins never seen here are left alone
  // in the default 'tracked' scope). Credit/gift-card routes need staff to
  // authorise → mark staffAuth so their deadline rolls into business hours.
  registerHold(b.appointment_id, { branchId: b.branchId, staffAuth: !!creditExempt });
  return b;
}

// --- Public API -----------------------------------------------------------

export function listBookings() { return [...bookings.values()]; }

export async function getBooking(id) {
  if (bookings.has(id)) return bookings.get(id);
  if (CONFIG.demoMode) return undefined;
  const sep = id.indexOf('~');
  if (sep === -1) return undefined;
  const branch = branchById(id.slice(0, sep));
  const apptId = id.slice(sep + 1);
  if (!branch) return undefined;
  const appt = (await fetchUpcomingAppointments(branch)).find((a) => a.appointment_id === apptId);
  return appt ? toBooking(branch, appt) : undefined;
}

// Find a customer's upcoming bookings at a branch by the mobile number they booked with
// (mirrors SimpleSpa's phone sign-in, since the email exposes no appointment-ID tag).
// Matches on the last 9 digits so country code / leading zero don't matter.
export async function lookupBookings({ branchId, phone }) {
  const ph = last9(phone);
  if (!ph) return [];
  if (CONFIG.demoMode) {
    return [...bookings.values()].filter((b) =>
      (!branchId || b.branchId === branchId) && b.status === 'pending' && last9(b.customer.phone) === ph);
  }
  const branch = branchById(branchId);
  if (!branch) return [];
  const appts = await fetchUpcomingAppointments(branch);
  const out = [];
  for (const a of appts) {
    if (SETTLED_STATUS.has(Number(a.status))) continue;   // already confirmed/paid/cancelled
    if (last9(a.client?.mobile) !== ph) continue;
    const bk = await toBooking(branch, a);
    if (bk.price > 0) out.push(bk);                        // no deposit to collect on a price-less booking
  }
  return out;
}

// Build the deposit choices (50% or full) for a booking.
export async function bookingDeposit(id) {
  const b = await getBooking(id);
  if (!b) return null;
  const d = depositOptions(b.price, { giftCardOrCredit: b.giftCardOrCredit, requireFull: b.requireFull });
  // Distinguish an account-credit exemption (staff confirms manually) from a plain one, so
  // the customer page can show the right wording.
  if (d.exempt && b.creditExempt) d.reason = 'account_credit';
  return { booking: b, ...d };
}

// Start a payment: validate the chosen amount, create a unique reference, and get the pay link.
// preferredGateway lets the customer pick the backup (e.g. expressPay); otherwise the primary
// is used with automatic failover to the backup.
export async function startDeposit(bookingId, optionId, preferredGateway) {
  const b = await getBooking(bookingId);
  if (!b) throw new Error('Booking not found');
  if (!(b.price > 0)) throw new Error('This booking has no price set — please contact the salon');
  const opts = depositOptions(b.price, { giftCardOrCredit: b.giftCardOrCredit, requireFull: b.requireFull });
  if (opts.exempt) throw new Error('This booking is covered by gift card/credit — no deposit required');

  const chosen = opts.options.find((o) => o.id === optionId) || opts.options[0];
  if (!isAmountAllowed(b.price, chosen.amount, { requireFull: b.requireFull })) throw new Error('Amount below the required minimum');

  const reference = makeReference(b.branchId, b.appointment_id);
  // For the international rail, show/charge in the foreign currency; deposit stays priced in GHS.
  const charge = preferredGateway === 'international'
    ? await convertFromGHS(chosen.amount, CONFIG.intlCurrency)
    : { amount: chosen.amount, currency: 'GHS' };

  const init = await initializeTransaction({
    email: b.customer.email,
    amount: chosen.amount,
    reference,
    chargeAmount: charge.amount,
    chargeCurrency: charge.currency,
    callbackUrl: `${CONFIG.publicUrl}/pay/callback?reference=${encodeURIComponent(reference)}`,
    // priceGHS travels with the payment so the gateway can say what the deposit is a deposit
    // TOWARDS. Without it Stripe can only show a pound figure, which answers nothing.
    metadata: { bookingId: b.id, appointment_id: b.appointment_id, branchId: b.branchId, type: chosen.id,
      priceGHS: b.price, customerName: b.customer.name, customerPhone: b.customer.phone },
  }, preferredGateway);

  payments.set(reference, { reference, bookingId: b.id, amount: chosen.amount, optionId: chosen.id,
    price: b.price, customer: b.customer?.name || '', service: b.service || '', startedAt: new Date().toISOString(),
    gateway: init.gateway, chargeAmount: charge.amount, chargeCurrency: charge.currency, chargeRate: charge.rate, status: 'pending' });
  savePayments();
  return { authorization_url: init.authorization_url, reference, amount: chosen.amount, gateway: init.gateway };
}

// Finalise: confirm the payment succeeded, auto-confirm the SimpleSpa appointment, mark booking.
export async function finalizeDeposit(reference) {
  const pay = payments.get(reference);
  if (!pay) throw new Error('Unknown payment reference');
  const b = await getBooking(pay.bookingId);

  const v = await verifyTransaction(reference, pay.gateway);
  // 'failed' here means "not paid YET" as often as it means "will never be paid" — a mobile
  // money payment can still be settling. Never overwrite a payment already recorded as paid.
  if (!v.success) { if (pay.status !== 'paid') { pay.status = 'failed'; savePayments(); } return { ok: false, reason: 'payment_not_successful' }; }
  pay.status = 'paid';
  pay.paidAt = pay.paidAt || new Date().toISOString();
  savePayments();

  // Payment is now authoritative. Auto-confirm the SimpleSpa appointment; if the write can't
  // go through (e.g. write API not enabled yet), confirmAppointment flags it rather than
  // throwing, so the customer still gets a success page and the deposit is recorded.
  const confirm = b
    ? await confirmAppointment(b.branchId, b.appointment_id, reference)
    : { confirmed: false, pending: true, reason: 'booking_not_found_at_finalize' };
  if (b) {
    b.status = confirm.confirmed ? 'confirmed' : 'paid_pending_confirm';
    b.paidAmount = pay.amount;
    b.paymentReference = reference;
    // Payment cleared → mark the hold secured so the release sweep never touches
    // it, even if the SimpleSpa confirm write is momentarily unavailable.
    markSecured(b.appointment_id, `deposit_ref:${reference}`);
  }
  recordPaidDeposit({
    reference, branchId: b?.branchId, appointment_id: b?.appointment_id,
    amount: pay.amount, gateway: pay.gateway, confirmed: !!confirm.confirmed,
    reason: confirm.error || confirm.reason, at: new Date().toISOString(),
    // What the deposit settles AGAINST, kept with the payment itself. Without the full price
    // here, nothing downstream can say what is still owed — and a customer paying from abroad
    // is charged in pounds, so the cedi figure and the rate that produced it have to be
    // written down at the moment of payment. Re-converting the pounds a week later gives a
    // different answer every day and would have the desk chasing shortfalls that do not exist.
    price: b?.price ?? null,
    optionId: pay.optionId || null,
    customer: b?.customer?.name || '',
    phone: b?.customer?.phone || '',
    service: b?.service || '',
    datetime: b?.datetime || '',
    chargeAmount: pay.chargeAmount ?? null,
    chargeCurrency: pay.chargeCurrency || 'GHS',
    chargeRate: pay.chargeRate ?? null,
    // What the gateway itself said was paid, so a mismatch between what we asked for and what
    // was taken is visible rather than assumed away.
    verifiedAmount: v.amount ?? null,
    verifiedCurrency: v.currency || null,
  });

  return { ok: true, booking: b, payment: pay, confirm };
}

export function getPayment(reference) { return payments.get(reference); }

// Customer self-selects "I'm paying with account credit" on the pay page. We take NO deposit
// and do NOT confirm the appointment — instead we flag it for staff, who verify the account
// truly has credit before confirming it manually in SimpleSpa. This is the controlled gate
// that lets a genuine credit-friend skip the deposit without letting anyone slip through.
export async function claimAccountCredit(bookingId) {
  return claimAlreadyPaid(bookingId, 'credit');
}

// The general case, added 29 Aug 2026 after Niobe reported the same customer question over
// and over: "I have been asked to make a deposit, but my package is already paid for and
// there is nowhere to give my voucher code."
//
// They were right, and the gap was ours. The deposit email had ONE button (pay), the pay
// page offered a gift card or account credit — and a PREPAID PACKAGE is neither of those
// words. A customer holding a package that says "100% DEPOSIT REQUIRED TO BOOK" on the
// receipt reads the page, finds nothing that describes them, and emails the branch.
//
// This cannot be detected automatically: a SimpleSpa appointment carries no money and no
// package link (verified against live data). So the honest design is to let the customer
// SAY it, take nothing, hold the slot, and put the evidence in front of staff.
const CLAIM_KINDS = {
  package: 'a prepaid package or treatment course',
  voucher: 'a gift card or voucher',
  credit: 'Niobe account credit',
};
export async function claimAlreadyPaid(bookingId, kind = 'package') {
  const b = await getBooking(bookingId);
  if (!b) return null;
  const k = CLAIM_KINDS[kind] ? kind : 'package';
  b.status = 'credit_claim_pending';
  b.creditClaim = { at: new Date().toISOString(), kind: k };
  // A self-claimed prepayment still needs staff to verify it before it counts as secured —
  // so we do NOT mark it secured here. staffAuth rolls the release deadline into business
  // hours, giving front desk a fair window to check before the slot would be released.
  registerHold(b.appointment_id, { branchId: b.branchId, staffAuth: true, reason: 'credit_claim_pending' });

  // The claim is recorded FIRST and the customer is answered immediately. The slot is
  // already held at this point, so nothing here is allowed to depend on SimpleSpa being
  // up or quick — paging six months of transactions took five seconds against live data.
  recordCreditClaim({
    kind: k, bookingId: b.id, appointment_id: b.appointment_id, branchId: b.branchId, branchName: b.branchName,
    customer: b.customer?.name, phone: b.customer?.phone, service: b.service, datetime: b.datetime,
    price: b.price, at: b.creditClaim.at,
  });

  // Then do the desk's lookup for them, in the background: what has this client actually
  // paid for lately? It lands as a second line against the same booking id.
  //
  // Evidence goes to the STAFF record ONLY. It is never rendered back to the person who
  // clicked, because the match is on a client NAME — showing it would tell one Grace
  // Mensah what the other Grace Mensah bought.
  const branch = branchById(b.branchId);

  // Tell the branch, exactly once, whether or not the lookup ever answers. A claim that
  // reaches nobody is the bug this whole flow exists to fix, so the email must not be
  // conditional on SimpleSpa: whichever happens first — the evidence or the deadline —
  // sends it, and the other is dropped.
  let notified = false;
  const tell = (evidence, note) => {
    if (notified) return;
    notified = true;
    notifyBranchOfClaim(b, k, evidence, note);
  };

  if (branch && b.customer?.name) {
    findClientPayments(branch, b.customer.name, { days: 180 })
      .then((evidence) => {
        recordClaimEvidence({ bookingId: b.id, appointment_id: b.appointment_id, branchId: b.branchId, customer: b.customer?.name, evidence });
        tell(evidence, null);
      })
      .catch((e) => {
        console.log(`[already-paid] evidence lookup failed for booking=${b.id}: ${e.message}`);
        tell(null, e.message);
      });
    setTimeout(() => tell(null, 'payment history still loading'), EVIDENCE_WAIT_MS).unref?.();
  } else {
    tell(null, branch ? 'no guest name on the booking' : 'unknown branch');
  }
  return b;
}

// How long the branch email waits for the payment history before going without it. The
// lookup took ~5s against live data; the desk hearing late is worse than hearing thin.
const EVIDENCE_WAIT_MS = Number(process.env.CLAIM_EVIDENCE_WAIT_MS || 12000);

async function notifyBranchOfClaim(b, kind, evidence, note) {
  const branch = branchById(b.branchId);
  const to = branch?.bookingEmail || CONFIG.bookingEmailFallback;
  if (!to) {
    // Loud on purpose. Silence here means a guest was told "our team will confirm" and
    // no team was told anything.
    console.log(`[already-paid] WARNING no booking inbox for branch=${b.branchId} — claim on booking=${b.id} was NOT emailed to anyone`);
    return;
  }
  const r = await sendAlreadyPaidEmail({
    to, kind, evidence, note,
    customer: b.customer?.name, phone: b.customer?.phone, email: b.customer?.email,
    branchName: b.branchName, service: b.service, datetime: b.datetime, price: b.price,
  });
  if (r.ok) console.log(`[already-paid] branch notified: ${to} booking=${b.id}`);
  else console.log(`[already-paid] WARNING branch NOT notified (${r.error || r.skipped}) to=${to} booking=${b.id}`);
}
