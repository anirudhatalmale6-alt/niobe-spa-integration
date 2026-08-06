import { appendFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { BRANCHES, CONFIG, branchById } from './config.js';
import { ssPost } from './simplespa.js';
import { isCreditClient } from './credit.js';
import { isReleasable, releaseDeadline } from './hours.js';

// ---------------------------------------------------------------------------
// Secure-or-release engine — the no-show fix.
//
// The loophole: a client books online (which creates a "New" appointment in
// SimpleSpa) but skips the payment step and never turns up, holding a slot that
// a paying client could have had. SimpleSpa's API cannot CREATE or RESCHEDULE an
// appointment — the only write it allows is a STATUS change. So we close the
// loophole with the one lever we have:
//
//   • SECURE  → flip the appointment to Confirmed (20)  [handled in confirm.js
//               on payment clear, and here for the manual routes]
//   • RELEASE → flip the appointment to Cancelled (15), freeing the therapist's
//               slot, once an unsecured hold passes its (business-hours-aware)
//               deadline.
//
// A booking is treated as SECURED if any of these is true:
//   1. a deposit / full payment has cleared (booking marked in bookings.js),
//   2. the client is on the account-credit allow-list (credit.js),
//   3. staff have already moved it on in SimpleSpa (Confirmed/Arrived/Paid…),
//   4. it is part of a prepaid package / gift-card redemption that front desk
//      has flagged (registered here as secured).
// Everything else that is still "New"/"Rebooked" past its deadline is a stale,
// unsecured hold and is a release candidate.
//
// SAFETY. This module NEVER cancels a real booking unless explicitly armed:
//   • DRY_RUN (default true) → it only REPORTS what it would release, writing
//     nothing to SimpleSpa. This lets Niobe watch the loophole being caught on
//     their live data before any auto-cancel goes live, and protects us during
//     testing.
//   • releaseScope 'tracked' (default) → only releases holds our own booking
//     funnel has seen, so a walk-in or phone booking created straight in
//     SimpleSpa is never touched. 'all' additionally releases any unsecured
//     New/Rebooked past deadline (fuller loophole closure; pairs with the
//     front-desk policy of confirming/taking payment for their own bookings).
// Every release (real or dry-run) is written to data/releases.log for the audit
// trail (spec point 10).
// ---------------------------------------------------------------------------

const STATUS_CANCELLED = 15; // SimpleSpa: 15 = Cancelled (frees the slot)
const STATUS_CONFIRMED = 20; // SimpleSpa: 20 = Confirmed

// Statuses that mean the slot is NOT an open, unsecured hold anymore.
// 15 Cancelled, 17 No-Show, 20 Confirmed, 25 Arrived, 30 Paid.
const SETTLED_STATUS = new Set([15, 17, 20, 25, 30]);
// Statuses that ARE an unsecured hold we may release: 0 New, 5 Rebooked.
const HOLD_STATUS = new Set([0, 5]);

// A real client booking, as opposed to a staff time-block. SimpleSpa "blocks"
// share status 0 (New) but are marked by client.first_name === "_block", carry a
// null mobile and an empty service name — they are deliberate staff reservations
// and must NEVER be auto-released. A genuine bookable hold has a real client with
// a mobile number (also required for the deposit-link lookup). Verified against
// live data: 92 of 93 "New" East Legon appointments were blocks, 1 real booking.
function isClientBooking(appt) {
  const first = String(appt.client?.first_name || '').trim().toLowerCase();
  if (first === '_block') return false;
  return !!(appt.client && appt.client.mobile);
}

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
function auditRelease(entry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, 'releases.log'), JSON.stringify(entry) + '\n');
  } catch { /* logging must never break the sweep */ }
}

// --- Hold registry --------------------------------------------------------
// In-memory record of the holds our funnel has seen, keyed by appointment_id.
// A hold is registered when a client lands on our secure page (or a deposit
// link is followed), and marked secured when they pay / are verified. Group
// bookings share a groupId so they secure and release together.
const holds = new Map(); // appointment_id -> { branchId, groupId, secured, staffAuth, registeredAt, reason }

// Register (or refresh) an online hold that came through our funnel. `staffAuth`
// marks routes that need a person to authorise them (credit / existing gift card
// / bank transfer / prepaid package) so the deadline rolls into business hours.
export function registerHold(appointmentId, { branchId, groupId = null, staffAuth = false, reason = '' } = {}) {
  if (!appointmentId) return;
  const existing = holds.get(appointmentId);
  holds.set(appointmentId, {
    branchId, groupId, staffAuth,
    secured: existing?.secured || false,
    reason: reason || existing?.reason || '',
    registeredAt: existing?.registeredAt || new Date().toISOString(),
  });
}

// Mark a hold (and every sibling in its group) secured, so the sweep never
// releases it. Called when a payment clears, credit/prepaid is verified, etc.
export function markSecured(appointmentId, reason = 'secured') {
  const h = holds.get(appointmentId);
  if (h) { h.secured = true; h.reason = reason; }
  // Secure the whole group together.
  if (h?.groupId) {
    for (const [id, other] of holds) {
      if (other.groupId === h.groupId) { other.secured = true; other.reason = reason; }
    }
  }
}

export function getHold(appointmentId) { return holds.get(appointmentId); }
export function listHolds() { return [...holds.entries()].map(([id, h]) => ({ appointment_id: id, ...h })); }

// --- Live reads -----------------------------------------------------------

const ymd = (d) => d.toISOString().slice(0, 10);

// Pull a branch's current New/Rebooked appointments over a sensible window
// (yesterday for TZ safety → ~7 days out; a stale hold is always near-term).
async function fetchOpenHolds(branch) {
  const now = Date.now();
  const start = ymd(new Date(now - 86400000));
  const end = ymd(new Date(now + 7 * 86400000));
  const all = [];
  for (let page = 1; page <= 6; page++) {
    const res = await ssPost(branch, 'appointments.php', { start, end, page, per_page: 1000 });
    const items = res.appointments || Object.values(res).find(Array.isArray) || [];
    all.push(...items);
    const total = res.total_results ?? all.length;
    if (all.length >= total || items.length === 0) break;
  }
  // Only New/Rebooked appointments that are real client bookings — staff blocks
  // (status 0, no client) are intentional and never release candidates.
  return all.filter((a) => HOLD_STATUS.has(Number(a.status)) && isClientBooking(a));
}

// Is this appointment secured by something other than the release engine?
// (paid deposit is reflected via our hold registry / SimpleSpa status; credit
// allow-list is checked live so a number added after booking still counts.)
function securedByRule(appt) {
  const h = holds.get(appt.appointment_id);
  if (h?.secured) return { secured: true, reason: h.reason || 'secured' };
  if (isCreditClient(appt.client?.mobile)) return { secured: true, reason: 'account_credit_allowlist' };
  return { secured: false };
}

// Decide the fate of one open hold as of `now`.
function assess(branch, appt, now) {
  const createdAt = new Date(String(appt.created_at || appt.start).replace(' ', 'T') + 'Z');
  const tracked = holds.has(appt.appointment_id);
  const staffAuth = holds.get(appt.appointment_id)?.staffAuth || false;

  const sec = securedByRule(appt);
  if (sec.secured) return { action: 'keep', reason: sec.reason, tracked };

  const deadline = releaseDeadline(createdAt, branch, { staffAuth });
  const due = isReleasable(createdAt, branch, now, { staffAuth });

  // Scope guard: in 'tracked' mode we only ever release holds our funnel saw.
  const inScope = CONFIG.releaseScope === 'all' || tracked;

  if (!due) return { action: 'wait', reason: 'within_grace', deadline, tracked };
  if (!inScope) return { action: 'skip', reason: 'untracked_not_in_scope', deadline, tracked };
  return { action: 'release', reason: 'unsecured_past_deadline', deadline, tracked };
}

// Actually flip an appointment to Cancelled(15) in SimpleSpa (unless DRY_RUN).
async function doRelease(branch, appt, deadline) {
  const reason = `auto-release: deposit not secured by ${deadline.toISOString()}`;
  const entry = {
    at: new Date().toISOString(), branchId: branch.id, branchName: branch.name,
    appointment_id: appt.appointment_id, start: appt.start,
    client: `${appt.client?.first_name || ''} ${appt.client?.last_name || ''}`.trim(),
    phone: appt.client?.mobile || '', service: appt.service?.service_name || '',
    deadline: deadline.toISOString(), dryRun: CONFIG.releaseDryRun,
  };
  if (CONFIG.releaseDryRun) {
    entry.result = 'dry_run_would_release';
    auditRelease(entry);
    return { released: false, dryRun: true, entry };
  }
  try {
    await ssPost(branch, 'write/appointments-status.php', {
      appointment_id: appt.appointment_id, status: STATUS_CANCELLED, reason,
    });
    entry.result = 'released';
    auditRelease(entry);
    const h = holds.get(appt.appointment_id);
    if (h) h.reason = 'released';
    return { released: true, entry };
  } catch (err) {
    entry.result = 'error'; entry.error = err.message;
    auditRelease(entry);
    return { released: false, error: err.message, entry };
  }
}

// Sweep one branch: assess every open hold, release those due (respecting
// DRY_RUN + scope), and return a summary of what happened / would happen.
export async function sweepBranch(branch, now = new Date()) {
  let open;
  try { open = await fetchOpenHolds(branch); }
  catch (err) { return { branchId: branch.id, name: branch.name, ok: false, error: err.message }; }

  const released = [], candidates = [], kept = [], waiting = [], skipped = [];
  for (const appt of open) {
    const a = assess(branch, appt, now);
    const row = {
      appointment_id: appt.appointment_id, start: appt.start,
      client: `${appt.client?.first_name || ''} ${appt.client?.last_name || ''}`.trim(),
      phone: appt.client?.mobile || '', service: appt.service?.service_name || '',
      status_label: appt.status_label, deadline: a.deadline?.toISOString(), tracked: a.tracked,
    };
    if (a.action === 'release') {
      const r = await doRelease(branch, appt, a.deadline);
      // In dry-run a "release" is a candidate (would-release); live, it's released.
      (r.released ? released : candidates).push({ ...row, result: r.entry.result, error: r.error });
    } else if (a.action === 'skip') {
      // Out of scope (untracked, and scope='tracked') — a walk-in / phone booking
      // we never originated. Reported for visibility but NEVER auto-cancelled.
      skipped.push({ ...row, reason: a.reason });
    } else if (a.action === 'wait') {
      waiting.push(row);
    } else {
      kept.push({ ...row, reason: a.reason });
    }
  }
  return {
    branchId: branch.id, name: branch.name, ok: true,
    openHolds: open.length,
    released, candidates, waiting, kept, skipped,
    counts: { released: released.length, candidates: candidates.length, waiting: waiting.length, kept: kept.length, skipped: skipped.length },
  };
}

// A deterministic, PII-free sample sweep for DEMO_MODE — lets the no-show
// dashboard be shown/tested without touching live data or exposing real clients.
function demoSweep(now) {
  const iso = (mins) => new Date(now.getTime() + mins * 60000).toISOString();
  const row = (o) => ({ appointment_id: o.id, start: o.start, client: o.client, phone: o.phone, service: o.service, status_label: 'New', deadline: o.deadline, tracked: true, ...o.extra });
  const east = {
    branchId: 'east_legon', name: 'East Legon', ok: true, openHolds: 4,
    candidates: [row({ id: 'D1', start: iso(180), client: 'Ama Boateng', phone: '0244 000 111', service: 'Deep Tissue Massage (60m)', deadline: iso(-25), extra: { result: 'dry_run_would_release' } })],
    released: [],
    waiting: [row({ id: 'D2', start: iso(300), client: 'Kojo Mensah', phone: '0209 222 333', service: 'Classic Facial (45m)', deadline: iso(35) })],
    kept: [row({ id: 'D3', start: iso(240), client: 'Efua Sarpong', phone: '0277 444 555', service: 'Hot Stone Massage (90m)', deadline: iso(-10), extra: { reason: 'deposit paid' } })],
    skipped: [{ appointment_id: 'D4' }],
    counts: { released: 0, candidates: 1, waiting: 1, kept: 1, skipped: 1 },
  };
  const cant = {
    branchId: 'cantonments', name: 'Cantonments', ok: true, openHolds: 2,
    candidates: [row({ id: 'D5', start: iso(120), client: 'Yaw Owusu', phone: '0201 666 777', service: 'Swedish Massage (60m)', deadline: iso(-40), extra: { result: 'dry_run_would_release' } })],
    released: [], waiting: [],
    kept: [row({ id: 'D6', start: iso(400), client: 'Adjoa Nyarko', phone: '0555 888 999', service: 'Manicure + Pedicure', deadline: iso(-5), extra: { reason: 'account credit' } })],
    skipped: [],
    counts: { released: 0, candidates: 1, waiting: 0, kept: 1, skipped: 0 },
  };
  return {
    generatedAt: now.toISOString(), dryRun: CONFIG.releaseDryRun, scope: CONFIG.releaseScope,
    graceMinutes: CONFIG.releaseGraceMinutes,
    branches: [east, cant],
    totals: { released: 0, candidates: 2, waiting: 1, kept: 2, skipped: 1, openHolds: 6, errors: 0 },
  };
}

// Sweep every branch. Runs branches in parallel; each is independent.
export async function sweepAll(now = new Date()) {
  if (CONFIG.demoMode) return demoSweep(now);
  const branches = await Promise.all(BRANCHES.map((b) => sweepBranch(b, now)));
  const totals = branches.reduce((t, b) => {
    if (!b.ok) { t.errors++; return t; }
    t.released += b.counts.released; t.candidates += b.counts.candidates;
    t.waiting += b.counts.waiting; t.kept += b.counts.kept;
    t.skipped += b.counts.skipped; t.openHolds += b.openHolds;
    return t;
  }, { released: 0, candidates: 0, waiting: 0, kept: 0, skipped: 0, openHolds: 0, errors: 0 });
  return {
    generatedAt: now.toISOString(),
    dryRun: CONFIG.releaseDryRun, scope: CONFIG.releaseScope,
    graceMinutes: CONFIG.releaseGraceMinutes,
    branches, totals,
  };
}

// Secure a hold via a staff-authorised route (credit / gift card / prepaid /
// bank transfer) AND confirm the appointment in SimpleSpa in one step. Used when
// front desk verifies a non-cash secure. Confirms the whole group together.
export async function secureAndConfirm(appointmentId, { branchId, reason = 'staff_secured' } = {}) {
  markSecured(appointmentId, reason);
  const branch = branchById(branchId) || branchById(holds.get(appointmentId)?.branchId);
  if (!branch) return { confirmed: false, error: 'unknown_branch' };
  if (CONFIG.releaseDryRun) return { confirmed: false, dryRun: true, appointment_id: appointmentId };
  try {
    await ssPost(branch, 'write/appointments-status.php', {
      appointment_id: appointmentId, status: STATUS_CONFIRMED, reason: `secured:${reason}`,
    });
    return { confirmed: true, appointment_id: appointmentId };
  } catch (err) {
    return { confirmed: false, error: err.message, appointment_id: appointmentId };
  }
}

// Start the periodic sweep loop. Returns a stop() handle. No-op unless armed.
let timer = null;
export function startSweepLoop() {
  if (!CONFIG.releaseEnabled) {
    console.log('[holds] release engine DISABLED (RELEASE_ENABLED=false) — not sweeping');
    return () => {};
  }
  const everyMs = CONFIG.releaseSweepMs;
  console.log(`[holds] release engine ON — sweep every ${Math.round(everyMs / 1000)}s, dryRun=${CONFIG.releaseDryRun}, scope=${CONFIG.releaseScope}, grace=${CONFIG.releaseGraceMinutes}m`);
  const run = async () => {
    try {
      const r = await sweepAll();
      if (r.totals.released || r.totals.candidates) {
        console.log(`[holds] sweep: ${r.totals.released} released, ${r.totals.candidates} candidate(s), ${r.totals.waiting} within grace (dryRun=${r.dryRun})`);
      }
    } catch (e) { console.log(`[holds] sweep error: ${e.message}`); }
  };
  timer = setInterval(run, everyMs);
  if (timer.unref) timer.unref();
  run(); // run once at startup
  return () => { if (timer) clearInterval(timer); timer = null; };
}
