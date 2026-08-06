import { CONFIG } from './config.js';

// ---------------------------------------------------------------------------
// Business hours + the "secure-or-release" deadline maths.
//
// The no-show fix releases an unsecured slot if it isn't secured within a grace
// window (default 60 min). But a naive "created_at + 60 min" is wrong across the
// two edge cases Niobe raised:
//
//   • A booking lands DURING closing hours (e.g. 22:40, or on a Sunday). If the
//     hold is one of the routes that needs a person to authorise it (account
//     credit, an existing SimpleSpa gift card, a bank transfer, a prepaid
//     package), there is no staff on shift to action it — so the clock must not
//     burn down while the spa is shut. We roll the deadline to `grace` minutes
//     AFTER the next business open, giving front desk a fair window in the
//     morning before anything is released.
//
//   • A booking lands just before close. Same rule — the remaining minutes
//     before close plus the morning grace keep the client from being unfairly
//     released while nobody could act.
//
// Online card / mobile-money deposits DON'T rely on this: the payment webhook
// auto-confirms 24/7 the instant funds clear, so those secure themselves at any
// hour. The business-hours roll only matters for the staff-authorised routes.
//
// Ghana is UTC+0 all year, so "wall-clock" == UTC and there is no timezone drift
// to reason about; we do all maths in UTC.
// ---------------------------------------------------------------------------

// Default weekly opening hours, keyed by JS weekday (0 = Sunday … 6 = Saturday).
// null = closed that day. Overridable per deployment via BUSINESS_HOURS (JSON),
// and per branch via a branch.hours override. These are sensible salon defaults;
// the exact per-branch hours are confirmed with Niobe before go-live.
const DEFAULT_HOURS = {
  0: null,                         // Sunday — closed
  1: { open: '09:00', close: '19:00' },
  2: { open: '09:00', close: '19:00' },
  3: { open: '09:00', close: '19:00' },
  4: { open: '09:00', close: '19:00' },
  5: { open: '09:00', close: '19:00' },
  6: { open: '09:00', close: '18:00' }, // Saturday — shorter
};

function parseHoursEnv() {
  if (!process.env.BUSINESS_HOURS) return null;
  try {
    const parsed = JSON.parse(process.env.BUSINESS_HOURS);
    // Accept either a flat {0:..,1:..} map or {default:{...}, branchId:{...}}.
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
const HOURS_ENV = parseHoursEnv();

// Resolve the weekly hours table for a branch: branch override → env → default.
function hoursTable(branch) {
  if (branch && branch.hours) return branch.hours;
  if (HOURS_ENV) {
    if (branch && HOURS_ENV[branch.id]) return HOURS_ENV[branch.id];
    if (HOURS_ENV.default) return HOURS_ENV.default;
    // A flat map (keys 0-6) applies to every branch.
    if (Object.keys(HOURS_ENV).some((k) => /^[0-6]$/.test(k))) return HOURS_ENV;
  }
  return DEFAULT_HOURS;
}

const hmToMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const dayWindow = (branch, jsDay) => hoursTable(branch)[jsDay] || null;

// Minutes-since-midnight (UTC) for a Date.
const minOfDay = (d) => d.getUTCHours() * 60 + d.getUTCMinutes();

// Is the branch open at instant `d`?
export function isOpenAt(branch, d) {
  const w = dayWindow(branch, d.getUTCDay());
  if (!w) return false;
  const m = minOfDay(d);
  return m >= hmToMin(w.open) && m < hmToMin(w.close);
}

// The next instant the branch opens at or after `d`. If the branch is open at
// `d`, returns `d` itself. Walks forward day-by-day to the next open day.
export function nextOpen(branch, d) {
  if (isOpenAt(branch, d)) return new Date(d.getTime());
  // Same day, before opening → this morning's open.
  const today = dayWindow(branch, d.getUTCDay());
  if (today && minOfDay(d) < hmToMin(today.open)) {
    const o = new Date(d.getTime());
    o.setUTCHours(0, hmToMin(today.open), 0, 0);
    return o;
  }
  // Otherwise scan up to a fortnight ahead for the next open day.
  for (let i = 1; i <= 14; i++) {
    const day = new Date(d.getTime() + i * 86400000);
    const w = dayWindow(branch, day.getUTCDay());
    if (w) {
      const o = new Date(day.getTime());
      o.setUTCHours(0, hmToMin(w.open), 0, 0);
      return o;
    }
  }
  // Fully closed config (shouldn't happen) → fall back to `d` so nothing hangs.
  return new Date(d.getTime());
}

// The close instant of the branch on the same UTC day as `d` (or null if closed
// that day / `d` is already past close).
function closeInstant(branch, d) {
  const w = dayWindow(branch, d.getUTCDay());
  if (!w) return null;
  const c = new Date(d.getTime());
  c.setUTCHours(0, hmToMin(w.close), 0, 0);
  return c > d ? c : null;
}

// Advance `minutes` of OPEN time forward from `start`, counting only minutes the
// branch is actually open. So a 60-minute window that begins 15 minutes before
// close spends those 15, then resumes the next morning for the remaining 45.
// This is what keeps a staff-authorised hold from quietly burning down its grace
// while the spa is shut.
function addBusinessMinutes(branch, start, minutes) {
  let cur = new Date(start.getTime());
  let remaining = minutes;
  for (let i = 0; i < 60 && remaining > 0; i++) {
    if (!isOpenAt(branch, cur)) { cur = nextOpen(branch, cur); continue; }
    const close = closeInstant(branch, cur);
    const availMin = close ? (close.getTime() - cur.getTime()) / 60000 : remaining;
    if (remaining <= availMin) return new Date(cur.getTime() + remaining * 60000);
    remaining -= availMin;
    cur = close;                    // jump to close; loop rolls to next open
  }
  return cur;
}

// Compute when an unsecured hold should be released.
//
//   createdAt   — when the booking was made (Date)
//   branch      — branch config (for its hours)
//   opts.graceMinutes  — window length (default CONFIG.releaseGraceMinutes)
//   opts.staffAuth     — true for routes a person must authorise (credit /
//                        existing gift card / bank transfer / prepaid package).
//                        For these the grace is counted in BUSINESS minutes, so
//                        an overnight/closing-hours hold isn't released before
//                        staff have had a fair window open. For self-securing
//                        online deposits (staffAuth=false) the window runs in
//                        plain wall-clock from createdAt (the payment webhook
//                        confirms 24/7, so the hour of day doesn't matter).
//
// Returns a Date: the earliest instant the hold may be auto-released.
export function releaseDeadline(createdAt, branch, opts = {}) {
  const grace = Number(opts.graceMinutes ?? CONFIG.releaseGraceMinutes) || 60;
  return opts.staffAuth
    ? addBusinessMinutes(branch, createdAt, grace)
    : new Date(createdAt.getTime() + grace * 60000);
}

// Convenience: has an unsecured hold created at `createdAt` passed its deadline
// as of `now`?
export function isReleasable(createdAt, branch, now, opts = {}) {
  return now.getTime() >= releaseDeadline(createdAt, branch, opts).getTime();
}
