import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { BRANCHES } from './config.js';
import { ssPost } from './simplespa.js';
import { resolveServicePrice } from './bookings.js';

// Monthly commission summary per therapist, consolidated across every branch.
//
// Why this module exists at all: SimpleSpa keeps a SEPARATE staff list per branch,
// and the same therapist is issued a DIFFERENT staff_id at each one — verified on
// live data, where 118 staff logins across the five branches resolved to 44 real
// people and NOT ONE staff_id appeared at more than one branch. So a therapist who
// covers a shift elsewhere earns under an id this branch has never seen, which is
// exactly why Niobe were extracting each branch by hand and stitching it together.
//
// That leaves the name as the only join key, and the names are not written the same
// way at every branch ("Elizabeth Nubuake" at East Legon, "Elizabeth Nubueke" at the
// other four — same mobile, one person). Joining on the raw name would quietly pay
// her twice at half each, and every row would look perfectly reasonable. So we do
// NOT guess: a client-confirmed staff map is the authority, and anything it doesn't
// recognise is reported rather than dropped.

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const STAFF_MAP_FILE = join(DATA_DIR, 'staff-map.json');

// Appointment statuses. Commission is earned on work actually done and paid for.
// 30 = Paid. 25 = Arrived (in progress, not yet paid) — deliberately NOT counted,
// but reported so a month is never silently short without someone seeing why.
export const EARNING_STATUS = new Set(['30']);
const STATUS_LABEL = {
  '0': 'New', '5': 'Rebooked', '10': 'Online', '15': 'Cancelled',
  '17': 'No-Show', '20': 'Confirmed', '22': 'Confirmed (no SMS)',
  '25': 'Arrived', '30': 'Paid',
};

export const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// --- Staff map -------------------------------------------------------------
// Shape (data/staff-map.json), built once from the sheet Niobe confirm:
//   {
//     "people": [
//       { "name": "Elizabeth Nubueke", "aliases": ["elizabeth nubuake"], "commissionPct": 10 }
//     ],
//     "exclude": ["niobe el service", "niobe staff 1"]
//   }
// aliases carry the alternate spellings; exclude carries the house/front-desk
// logins that are not people and must never appear on a payroll.
export function loadStaffMap(file = STAFF_MAP_FILE) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { raw = null; }
  const byName = new Map();   // normalised name/alias -> person
  const exclude = new Set();
  for (const n of raw?.exclude || []) exclude.add(normName(n));
  for (const p of raw?.people || []) {
    const person = {
      name: p.name,
      commissionPct: p.commissionPct == null ? null : Number(p.commissionPct),
    };
    byName.set(normName(p.name), person);
    for (const a of p.aliases || []) byName.set(normName(a), person);
  }
  return { byName, exclude, loaded: !!raw };
}

// --- Appointment fetch -----------------------------------------------------
// SimpleSpa caps a page at 1000 rows however large per_page is asked for, and one
// branch alone billed 2,214 appointments in a single month. A naive single call
// would therefore pay staff for under half their work and look entirely correct,
// so we page until total_results is satisfied. Appointment ids are de-duplicated
// as a belt-and-braces guard: if paging ever drifts or overlaps we under-report
// rather than pay somebody twice for the same treatment.
export async function fetchAppointments(branch, start, end) {
  const seen = new Map();
  let total = Infinity;
  for (let page = 1; page <= 60; page++) {
    const res = await ssPost(branch, 'appointments.php', { start, end, page, per_page: 1000 });
    const items = res.appointments || Object.values(res).find(Array.isArray) || [];
    if (res.total_results != null) total = Number(res.total_results);
    for (const a of items) if (a?.appointment_id) seen.set(a.appointment_id, a);
    if (!items.length || seen.size >= total) break;
  }
  return { appointments: [...seen.values()], reportedTotal: total };
}

// --- The run ---------------------------------------------------------------
// start/end are inclusive YYYY-MM-DD. Returns per-person totals plus everything a
// human needs to trust the number: the per-branch split, what was excluded and why,
// and any therapist the staff map didn't recognise.
export async function runPayroll({ start, end, staffMap = loadStaffMap(), branches = BRANCHES } = {}) {
  const people = new Map();     // canonical person name -> row
  const unmatched = new Map();  // normalised name -> { name, branches:Set, treatments, value }
  const skipped = {};           // status label -> count
  const branchErrors = [];
  let unpriced = 0;

  for (const branch of branches) {
    let batch;
    try {
      batch = await fetchAppointments(branch, start, end);
    } catch (e) {
      // One unreachable branch must not silently produce a short payroll.
      branchErrors.push({ branch: branch.name, error: e.message });
      continue;
    }
    if (batch.appointments.length < batch.reportedTotal) {
      branchErrors.push({
        branch: branch.name,
        error: `only ${batch.appointments.length} of ${batch.reportedTotal} appointments retrieved`,
      });
    }

    for (const appt of batch.appointments) {
      const status = String(appt.status);
      if (!EARNING_STATUS.has(status)) {
        const label = STATUS_LABEL[status] || `Status ${status}`;
        skipped[label] = (skipped[label] || 0) + 1;
        continue;
      }
      const staffName = appt.staff?.staff_name || '';
      const key = normName(staffName);
      if (!key || staffMap.exclude.has(key)) continue;

      const { price, name: serviceName } = await resolveServicePrice(branch, appt);
      if (!price) unpriced += 1;

      const person = staffMap.byName.get(key);
      if (!person) {
        // Never drop a therapist just because the map is out of date — surface them.
        const u = unmatched.get(key) || { name: staffName, branches: new Set(), treatments: 0, value: 0 };
        u.branches.add(branch.name);
        u.treatments += 1;
        u.value += price;
        unmatched.set(key, u);
        continue;
      }

      const row = people.get(person.name) || {
        name: person.name,
        commissionPct: person.commissionPct,
        treatments: 0,
        serviceValue: 0,
        byBranch: {},
        services: {},
      };
      row.treatments += 1;
      row.serviceValue += price;
      const b = row.byBranch[branch.name] || { treatments: 0, value: 0 };
      b.treatments += 1; b.value += price;
      row.byBranch[branch.name] = b;
      row.services[serviceName] = (row.services[serviceName] || 0) + 1;
      people.set(person.name, row);
    }
  }

  const rows = [...people.values()].map((r) => ({
    ...r,
    serviceValue: round2(r.serviceValue),
    // A missing rate yields null, never 0 — a silent zero reads as "earned nothing".
    commission: r.commissionPct == null ? null : round2(r.serviceValue * r.commissionPct / 100),
    byBranch: Object.fromEntries(
      Object.entries(r.byBranch).map(([k, v]) => [k, { ...v, value: round2(v.value) }]),
    ),
  })).sort((a, b) => b.serviceValue - a.serviceValue);

  return {
    period: { start, end },
    generatedFor: branches.map((b) => b.name),
    rows,
    totals: {
      people: rows.length,
      treatments: rows.reduce((n, r) => n + r.treatments, 0),
      serviceValue: round2(rows.reduce((n, r) => n + r.serviceValue, 0)),
      commission: round2(rows.reduce((n, r) => n + (r.commission || 0), 0)),
      missingRates: rows.filter((r) => r.commissionPct == null).map((r) => r.name),
    },
    // Everything below is why the number can be trusted, not decoration.
    unmatchedStaff: [...unmatched.values()]
      .map((u) => ({ ...u, branches: [...u.branches], value: round2(u.value) }))
      .sort((a, b) => b.value - a.value),
    skippedByStatus: skipped,
    unpricedTreatments: unpriced,
    branchErrors,
    staffMapLoaded: staffMap.loaded,
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
