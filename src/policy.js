// Niobe's gift-card policy. Two rules with their OWN dates (client, 12 + 22 Oct 2026):
//
//   1. No more extensions — from 1 April 2027 (moved from 1 December 2026 so corporate and
//      festive-season buyers can still be helped). Until then staff may extend at their
//      discretion from the card desk, but NOTHING online offers or mentions an extension
//      (reminder email, balance page). From the date, every path refuses: paid, free grace and
//      manager override, and a card expiring on/after the date cannot be extended in advance.
//   2. Late-change / no-show fee — from 1 December 2026: GHS 150 off the card, or whatever is
//      left if that is less.
//
// One place, so the desk, the email, the balance page and the booking page can never disagree.
// Ghana keeps UTC all year, so midnight UTC IS midnight in Accra.
const startOf = (ymd) => Date.parse(`${ymd}T00:00:00Z`);
const label = (ymd) => new Date(startOf(ymd)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export const EXTENSIONS_END = process.env.GIFTCARD_EXTENSIONS_END || '2027-04-01';
export const LATE_FEE_FROM = process.env.GIFTCARD_LATE_FEE_FROM || process.env.GIFTCARD_POLICY_FROM || '2026-12-01';
export const EXTENSIONS_END_LABEL = label(EXTENSIONS_END);
export const LATE_FEE_FROM_LABEL = label(LATE_FEE_FROM);
export const LATE_FEE_GHS = Number(process.env.GIFTCARD_LATE_FEE_GHS || 150);
export const LATE_NOTICE_HOURS = Number(process.env.GIFTCARD_LATE_NOTICE_HOURS || 24);
// "Remove all signs of extension online" — customers are never offered one in writing. Staff
// still can, case by case, until EXTENSIONS_END.
export const OFFER_EXTENSIONS_ONLINE = String(process.env.GIFTCARD_OFFER_EXTENSIONS_ONLINE || '').toLowerCase() === 'true';

export const extensionsEnded = (now = new Date()) => now.getTime() >= startOf(EXTENSIONS_END);
export const lateFeeInForce = (now = new Date()) => now.getTime() >= startOf(LATE_FEE_FROM);

// Why this card cannot be extended, or null if it still can. Every extension path asks this —
// including the free grace and a manager's override.
export function extensionBlocked(expiresAt, now = new Date()) {
  if (extensionsEnded(now)) return 'extensions_ended';
  if (expiresAt && Date.parse(expiresAt) >= startOf(EXTENSIONS_END)) return 'expires_after_cutoff';
  return null;
}

// The fee comes off the card, and never more than the card holds.
export function lateFeeFor(balance) {
  const b = Number(balance);
  return b > 0 ? Math.min(LATE_FEE_GHS, b) : 0;
}

export const LATE_KINDS = {
  late_cancel: 'Cancelled with less than 24 hours\' notice',
  late_reschedule: 'Rescheduled with less than 24 hours\' notice',
  no_show: 'Did not attend',
};

// What a gift-card customer reads, and ticks, before the card is used.
export function lateFeeNotice(now = new Date()) {
  const lead = lateFeeInForce(now) ? '' : `From ${LATE_FEE_FROM_LABEL}, `;
  const body = `if you need to cancel or reschedule a gift card booking, please give us at least ${LATE_NOTICE_HOURS} hours' notice. A change with less notice, or a missed appointment, carries a GHS ${LATE_FEE_GHS} fee taken from your gift card balance (or whatever remains, if that is less).`;
  return lead ? lead + body : body.charAt(0).toUpperCase() + body.slice(1);
}
export const LATE_FEE_AGREE_LABEL = `I understand the ${LATE_NOTICE_HOURS}-hour notice policy and the GHS ${LATE_FEE_GHS} fee.`;
