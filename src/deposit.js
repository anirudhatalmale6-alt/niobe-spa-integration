import { CONFIG, branchRefCode } from './config.js';

// Deposit rule (Niobe): a customer must pay a MINIMUM of 50% of the service price
// to secure the slot, or they may pay in full. Same across all services and branches.
// Exception: if the booking is covered by a gift card or existing account credit,
// no upfront online payment is collected — the slot is already secured.
export function depositOptions(servicePrice, { giftCardOrCredit = false, requireFull = false } = {}) {
  const price = Math.round(Number(servicePrice) * 100) / 100;
  if (giftCardOrCredit) {
    return { price, exempt: true, reason: 'gift_card_or_credit', options: [] };
  }
  // Some Niobe services are flagged (in their name) as requiring 100% upfront — for those the
  // only option is pay-in-full; the 50% deposit is not offered.
  if (requireFull) {
    return { price, exempt: false, requireFull: true,
      options: [{ id: 'full', label: 'Pay in full (required for this service)', amount: price }] };
  }
  const pct = CONFIG.depositMinPercent;
  const half = Math.round(price * (pct / 100) * 100) / 100;
  return {
    price,
    exempt: false,
    options: [
      { id: 'deposit', label: `Pay ${pct}% deposit`, amount: half },
      { id: 'full',    label: 'Pay in full',          amount: price },
    ],
  };
}

// Does this service require the full amount upfront? Detected from the service name, which is
// where Niobe records it today (e.g. "... (100% DEPOSIT REQUIRED ...)").
export function serviceRequiresFull(serviceName) {
  return /100\s*%\s*deposit|deposit\s*required.*100|full\s*payment\s*required/i.test(String(serviceName || ''));
}

// Validate a chosen amount against the rule (guards against tampering with the pay link).
export function isAmountAllowed(servicePrice, amount, { requireFull = false } = {}) {
  const price = Number(servicePrice);
  const min = requireFull
    ? price
    : Math.round(price * (CONFIG.depositMinPercent / 100) * 100) / 100;
  const a = Number(amount);
  return a >= min - 0.001 && a <= price + 0.001;
}

// A short, unique payment reference (Hubtel caps clientReference length, so we keep it compact).
// The appointment/branch it belongs to is held in our own payment record, and the reference is
// also stamped into SimpleSpa's audit log via the confirm step. Format: NIOBE-<BR4>-<YYMMDDHHMMSS><seq>.
let seq = 0;
export function makeReference(branchId /* , appointmentId */) {
  seq = (seq + 1) % 1000;
  const t = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(2, 14); // YYMMDDHHMMSS
  // Same helper the payment adapters use to read the branch back out of a
  // reference, so settlement and status-check always resolve the same account.
  const b = branchRefCode(branchId) || 'BR';
  return `NIOBE-${b}-${t}${String(seq).padStart(3, '0')}`;
}
