import { depositOptions, isAmountAllowed, makeReference, serviceRequiresFull } from './deposit.js';
import { initializeTransaction, verifyTransaction } from './gateway.js';
import { confirmAppointment } from './confirm.js';
import { convertFromGHS } from './fx.js';
import { CONFIG, branchById } from './config.js';
import { ssPost } from './simplespa.js';

// A booking here is an existing SimpleSpa appointment that this service attaches a deposit
// payment to. Live (DEMO_MODE=false) it is read from SimpleSpa's appointments.php by the
// customer's branch + mobile number; in demo we seed a couple so the flow can be walked.
const bookings = new Map();      // booking id -> booking object (cache)
const payments = new Map();      // reference   -> payment record

// Statuses that mean the appointment is already dealt with (no deposit to collect):
// 15 Cancelled, 17 No-Show, 20 Confirmed, 25 Arrived, 30 Paid. Anything else (New,
// Rebooked, …) with a real client is a booking that can still take a deposit.
const SETTLED_STATUS = new Set([15, 17, 20, 25, 30]);

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
  for (const s of samples) bookings.set(s.id, { ...s, status: 'pending', giftCardOrCredit: false });
}
if (CONFIG.demoMode) seed();

// --- Live SimpleSpa reads -------------------------------------------------

// Per-branch service price map (appointments.php carries no price), cached briefly.
const serviceCache = new Map(); // branchId -> { at, map: Map(service_id -> { name, price }) }
const SERVICE_TTL_MS = 10 * 60 * 1000;
async function servicePriceMap(branch) {
  const hit = serviceCache.get(branch.id);
  if (hit && Date.now() - hit.at < SERVICE_TTL_MS) return hit.map;
  const res = await ssPost(branch, 'services.php', { per_page: 1000 });
  const arr = res.services || Object.values(res).find(Array.isArray) || [];
  const map = new Map(arr.map((s) => [String(s.service_id), { name: s.name, price: Number(s.price) || 0 }]));
  serviceCache.set(branch.id, { at: Date.now(), map });
  return map;
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
  const prices = await servicePriceMap(branch);
  const svc = prices.get(String(appt.service?.service_id));
  const name = `${appt.client?.first_name || ''} ${appt.client?.last_name || ''}`.trim() || 'Guest';
  const b = {
    id: makeBookingId(branch.id, appt.appointment_id),
    appointment_id: appt.appointment_id,
    branchId: branch.id,
    branchName: branch.name,
    service: appt.service?.service_name || svc?.name || 'Your service',
    price: svc ? svc.price : 0,
    therapist: appt.staff?.staff_name || '',
    datetime: appt.start,
    customer: { name, email: appt.client?.email || '', phone: appt.client?.mobile || '' },
    status: 'pending',
    requireFull: serviceRequiresFull(appt.service?.service_name || svc?.name),
    // SimpleSpa's API exposes no gift-card/credit flag on an appointment, so a deposit is
    // requested for all bookings sent the pay link. (Branches simply don't send gift-card
    // customers the link.) Can be refined if such a flag becomes available.
    giftCardOrCredit: false,
  };
  bookings.set(b.id, b);
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
    if (last9(a.client?.mobile) === ph) out.push(await toBooking(branch, a));
  }
  return out;
}

// Build the deposit choices (50% or full) for a booking.
export async function bookingDeposit(id) {
  const b = await getBooking(id);
  if (!b) return null;
  return { booking: b, ...depositOptions(b.price, { giftCardOrCredit: b.giftCardOrCredit, requireFull: b.requireFull }) };
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
    metadata: { bookingId: b.id, appointment_id: b.appointment_id, branchId: b.branchId, type: chosen.id,
      customerName: b.customer.name, customerPhone: b.customer.phone },
  }, preferredGateway);

  payments.set(reference, { reference, bookingId: b.id, amount: chosen.amount, optionId: chosen.id,
    gateway: init.gateway, chargeAmount: charge.amount, chargeCurrency: charge.currency, status: 'pending' });
  return { authorization_url: init.authorization_url, reference, amount: chosen.amount, gateway: init.gateway };
}

// Finalise: confirm the payment succeeded, auto-confirm the SimpleSpa appointment, mark booking.
export async function finalizeDeposit(reference) {
  const pay = payments.get(reference);
  if (!pay) throw new Error('Unknown payment reference');
  const b = await getBooking(pay.bookingId);

  const v = await verifyTransaction(reference, pay.gateway);
  if (!v.success) { pay.status = 'failed'; return { ok: false, reason: 'payment_not_successful' }; }
  pay.status = 'paid';

  const confirm = await confirmAppointment(b.branchId, b.appointment_id, reference);
  b.status = 'confirmed';
  b.paidAmount = pay.amount;
  b.paymentReference = reference;

  return { ok: true, booking: b, payment: pay, confirm };
}

export function getPayment(reference) { return payments.get(reference); }
