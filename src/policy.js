// Niobe's gift-card policy change, agreed 12 Oct 2026, in force from 1 December 2026:
//
//   1. Gift cards can no longer be extended — no paid extension, no free grace days, no
//      staff override. A card that expires ON or after the date is already affected, so it
//      cannot be extended in advance either. Extensions bought before the date stand.
//   2. A gift-card booking cancelled or rescheduled with less than 24 hours' notice, or not
//      turned up to, costs GHS 150 off the card — or whatever is left, if that is less.
//
// One place, so the desk, the reminder email, the balance page and the booking page can
// never disagree about the date. Ghana keeps UTC all year, so midnight UTC IS midnight in
// Accra and no timezone arithmetic is needed.
const startOf = (ymd) => Date.parse(`${ymd}T00:00:00Z`);

export const POLICY_FROM = process.env.GIFTCARD_POLICY_FROM || '2026-12-01';
export const LATE_FEE_GHS = Number(process.env.GIFTCARD_LATE_FEE_GHS || 150);
export const LATE_NOTICE_HOURS = Number(process.env.GIFTCARD_LATE_NOTICE_HOURS || 24);

export const POLICY_FROM_LABEL = new Date(startOf(POLICY_FROM))
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function policyInForce(now = new Date()) {
  return now.getTime() >= startOf(POLICY_FROM);
}

// Why this card cannot be extended, or null if it still can. Every extension path asks
// this — including the free grace and a manager's override, because a rule with a
// discretionary back door is a rule that quietly stops existing.
export function extensionBlocked(expiresAt, now = new Date()) {
  if (policyInForce(now)) return 'extensions_ended';
  if (expiresAt && Date.parse(expiresAt) >= startOf(POLICY_FROM)) return 'expires_after_cutoff';
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

// What a gift-card customer reads, and ticks, before the card is used. Worded for before
// the date ("From 1 December 2026, ...") and after it, so the page never needs editing.
export function lateFeeNotice(now = new Date()) {
  const lead = policyInForce(now) ? '' : `From ${POLICY_FROM_LABEL}, `;
  const body = `if you need to cancel or reschedule a gift card booking, please give us at least ${LATE_NOTICE_HOURS} hours' notice. A change with less notice, or a missed appointment, carries a GHS ${LATE_FEE_GHS} fee taken from your gift card balance (or whatever remains, if that is less).`;
  return lead ? lead + body : body.charAt(0).toUpperCase() + body.slice(1);
}
export const LATE_FEE_AGREE_LABEL = `I understand the ${LATE_NOTICE_HOURS}-hour notice policy and the GHS ${LATE_FEE_GHS} fee.`;
