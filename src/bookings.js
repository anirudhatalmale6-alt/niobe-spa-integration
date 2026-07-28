import { depositOptions, isAmountAllowed, makeReference } from './deposit.js';
import { initializeTransaction, verifyTransaction } from './gateway.js';
import { confirmAppointment } from './confirm.js';
import { CONFIG } from './config.js';

// In a live deployment a booking is created in SimpleSpa's own online-booking step; this
// service then attaches the deposit payment to it. For the demo we seed a couple of
// pending bookings so the whole pay -> confirm flow can be walked through end-to-end.
const bookings = new Map();
const payments = new Map(); // reference -> { reference, bookingId, amount, optionId, status }

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
seed();

export function listBookings() { return [...bookings.values()]; }
export function getBooking(id) { return bookings.get(id); }

// Build the deposit choices (50% or full) for a booking.
export function bookingDeposit(id) {
  const b = getBooking(id);
  if (!b) return null;
  return { booking: b, ...depositOptions(b.price, { giftCardOrCredit: b.giftCardOrCredit }) };
}

// Start a payment: validate the chosen amount, create a unique reference, and get the pay link.
// preferredGateway lets the customer pick the backup (e.g. expressPay); otherwise the primary
// is used with automatic failover to the backup.
export async function startDeposit(bookingId, optionId, preferredGateway) {
  const b = getBooking(bookingId);
  if (!b) throw new Error('Booking not found');
  const opts = depositOptions(b.price, { giftCardOrCredit: b.giftCardOrCredit });
  if (opts.exempt) throw new Error('This booking is covered by gift card/credit — no deposit required');

  const chosen = opts.options.find((o) => o.id === optionId) || opts.options[0];
  if (!isAmountAllowed(b.price, chosen.amount)) throw new Error('Amount below the required minimum');

  const reference = makeReference(b.branchId, b.appointment_id);
  const init = await initializeTransaction({
    email: b.customer.email,
    amount: chosen.amount,
    reference,
    callbackUrl: `${CONFIG.publicUrl}/pay/callback?reference=${encodeURIComponent(reference)}`,
    metadata: { bookingId: b.id, appointment_id: b.appointment_id, branchId: b.branchId, type: chosen.id,
      customerName: b.customer.name, customerPhone: b.customer.phone },
  }, preferredGateway);

  payments.set(reference, { reference, bookingId: b.id, amount: chosen.amount, optionId: chosen.id, gateway: init.gateway, status: 'pending' });
  return { authorization_url: init.authorization_url, reference, amount: chosen.amount, gateway: init.gateway };
}

// Finalise: confirm the payment succeeded, auto-confirm the SimpleSpa appointment, mark booking.
export async function finalizeDeposit(reference) {
  const pay = payments.get(reference);
  if (!pay) throw new Error('Unknown payment reference');
  const b = getBooking(pay.bookingId);

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
