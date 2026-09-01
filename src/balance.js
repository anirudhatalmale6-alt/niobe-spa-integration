// The public "check my gift card balance" endpoint.
//
// Niobe's customers currently have no way to answer the question "how much is left on
// this card?" without telephoning a branch — and not getting through to a branch by
// phone is the specific complaint that runs through this whole project. So this page is
// small but it removes a real phone call.
//
// It is also the ONLY page in this service an anonymous stranger can drive with input
// of their own choosing, which changes what it has to defend against. The rules:
//
//   - Rate limited per address, short window and long window (see ratelimit.js).
//   - The code is shape-checked BEFORE any upstream call, so junk cannot be used to
//     bounce traffic off this page into SimpleSpa's API.
//   - The reply never contains the full code, only the last four characters. Whoever
//     can read a gift-card code can spend it, so a page that echoes it back turns a
//     shoulder-surf or a screenshot into a theft.
//   - "We could not check" is never rendered as "that card does not exist". They are
//     opposite messages to someone holding a real gift: one says try again in a minute,
//     the other says your present is worthless. lookupAnyCard already distinguishes
//     them; this module's job is to not throw that distinction away.
//   - An unpaid (reserved) card is not reported at all — handled inside lookupAnyCard,
//     restated here because it is the rule most easily broken by a well-meaning edit.

import { lookupAnyCard, EXTENSION_DAYS, quoteExtension } from './cards.js';
import { createLimiter } from './ratelimit.js';

// Two windows. The minute window stops a burst; the hour window stops the patient
// version of the same attack. Both are generous for a human — a customer who genuinely
// cannot read their own handwriting gets six goes a minute — and hopeless for a script:
// 40 an hour against even a short legacy code is not an enumeration strategy.
const limiter = createLimiter([
  { ms: 60_000, max: Number(process.env.BALANCE_RATE_PER_MIN || 6), label: 'minute' },
  { ms: 3_600_000, max: Number(process.env.BALANCE_RATE_PER_HOUR || 40), label: 'hour' },
]);

// A separate, much larger limiter for the whole endpoint regardless of address. A
// distributed attempt from many addresses defeats the per-IP limit by design; this is
// the backstop that keeps the branches' own SimpleSpa API usable while it happens.
// Deliberately high enough that ordinary traffic — including a busy Christmas week —
// will never reach it.
const globalLimiter = createLimiter([
  { ms: 60_000, max: Number(process.env.BALANCE_RATE_GLOBAL_PER_MIN || 120), label: 'minute' },
]);

// Characters a gift-card code can contain, across all three ledgers: ours (A-Z, 2-9,
// hyphens), GiftUp's (alphanumeric) and SimpleSpa's older dashed codes (which DO contain
// the 0/O/1/I characters ours deliberately avoids). Anything outside this set was not
// typed off a voucher.
const CODE_SHAPE = /^[A-Z0-9-]{4,32}$/;

// Strip the things people paste along with a code — spaces, the surrounding quotes from
// a WhatsApp forward, a stray full stop at the end of a sentence. Doing this before the
// shape check means a legitimate paste is not rejected for punctuation the customer
// cannot see.
export function normaliseCode(raw) {
  return String(raw || '')
    .trim()
    .replace(/^["'`]+|["'`.,;]+$/g, '')
    .replace(/[\s_]+/g, '')
    .toUpperCase();
}

// Everything the balance page needs to render, and nothing it does not.
//
// Note what is deliberately absent: the buyer's name, the recipient's name, the gift
// message, the order reference. All of those sit on the card record and none of them
// belong on a page anyone can reach by typing a code — a guessed code should never
// disclose who bought a present for whom.
function presentable(r) {
  const money = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);
  return {
    found: true,
    source: r.source,                    // 'niobe' | 'giftup' | 'simplespa'
    // Last four LETTERS AND DIGITS, not last four characters: the legacy SimpleSpa
    // codes are short and dashed, so DPB-QO0 would otherwise render as "•••• -QO0"
    // with a stray hyphen where the mask meets the code.
    last4: String(r.code || '').replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase(),
    balance: money(r.balance),
    initialBalance: money(r.initialBalance),
    currency: r.currency || 'GHS',
    status: r.status,
    expired: !!r.expired,
    expiresAt: r.expiresAt || null,
    daysLeft: r.daysLeft ?? null,
    valid: !!r.valid,
    // A legacy SimpleSpa card is real money but cannot be deducted online, because
    // SimpleSpa exposes no gift-card write API. The page must say so plainly rather
    // than implying a card can be spent on the website when it can only be spent at
    // the desk.
    selfService: r.selfService !== false,
    branchName: r.branchName || null,
    // Set when the customer's typed code did not exist but a single plausible
    // mis-reading of it did. The page says so, because silently answering about a
    // different code than the one typed is how someone ends up reassured about a
    // card that is not the one in their hand.
    corrected: !!r.correctedFrom,
    extendable: !!r.extendable,
    extendFeeGHS: r.extendFeeGHS ?? null,
    extendDays: r.extendDays ?? EXTENSION_DAYS,
    // Only our own ledger can be extended, and only that ledger can quote a price.
    tiers: r.source === 'niobe' && r.expired ? (quoteExtension(r.code)?.tiers || null) : null,
  };
}

export async function publicBalanceCheck({ code, ip }) {
  // Global backstop first: if the endpoint as a whole is being hammered, the cheapest
  // possible response is the right one, and it should not depend on the address.
  const g = globalLimiter.check('all');
  if (!g.ok) return { found: false, reason: 'busy', retryAfterSec: g.retryAfterSec };

  const rl = limiter.check(ip || 'unknown');
  if (!rl.ok) {
    return { found: false, reason: 'rate_limited', retryAfterSec: rl.retryAfterSec, window: rl.window };
  }

  const c = normaliseCode(code);
  if (!c) return { found: false, reason: 'no_code' };
  // Shape-checked before anything leaves this process. A code that cannot exist is
  // answered without asking GiftUp or five branches about it.
  if (!CODE_SHAPE.test(c)) return { found: false, reason: 'bad_shape' };

  let r;
  try {
    // Smaller variant cap than the staff and booking flows: see the note on
    // lookupAnyCard. Two speculative re-readings is enough to catch a genuine O/0
    // confusion without turning one public request into fifty upstream calls.
    r = await lookupAnyCard(c, { variantCap: 2 });
  } catch (e) {
    // An exception here is our fault, not the customer's, and must not be rendered as
    // an invalid card.
    return { found: false, reason: 'unavailable', errors: [{ source: 'lookup', error: e.message }] };
  }

  if (r.found) return presentable(r);

  // Pass the reason through unchanged. 'unavailable' (a ledger did not answer) and
  // 'not_found' (every ledger answered, and none of them had it) look similar in the
  // code and mean opposite things to the customer.
  return {
    found: false,
    reason: r.reason || 'not_found',
    errors: r.errors || [],
    // Which systems failed, for the staff-facing log — never rendered to the customer.
    unchecked: (r.errors || []).map((e) => e.source).filter(Boolean),
  };
}

export const _limiterForTests = { limiter, globalLimiter };
