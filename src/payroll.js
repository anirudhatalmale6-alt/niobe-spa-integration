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

// --- Staff map + commission rates ------------------------------------------
// Shape (data/staff-map.json), built once from the sheet Niobe confirm:
//   {
//     "rates": {
//       "default": 10,
//       "byCategory": { "SPA PACKAGES": 12, "BODY MASSAGE": 10 },
//       "excludeCategories": ["GIFT CARD EXT FEE", "DELIVERY CHARGE"]
//     },
//     "people": [
//       { "name": "Elizabeth Nubueke", "aliases": ["elizabeth nubuake"],
//         "commissionPct": 12, "byCategory": { "FACIALS": 15 } },
//       { "name": "Amelia Nkansah", "former": true, "leftOn": "2026-07-15" }
//     ],
//     "exclude": ["niobe el service", "niobe staff 1"]
//   }
// aliases carry the alternate spellings; exclude carries the house/front-desk
// logins that are not people and must never appear on a payroll.
//
// `former` marks someone who has left. Deleting a leaver outright would be the
// obvious move and it is the wrong one: her treatments in the period are real
// work that was really paid for, so removing her makes the payroll stop
// reconciling against SimpleSpa's own takings, and quietly drops any commission
// she is still owed for the days she worked. So she is kept, computed, and
// reported in her OWN section — never mixed into the pay run, never dropped
// from the evidence. `leftOn` additionally lets us check for work booked under
// her login AFTER she left, which is how a reused login shows itself.
//
// Niobe described the rate as varying by experience AND by type of service, so
// rather than pick one, the rate is resolved most-specific-first and each layer
// is optional. Either model alone works, and so does the combination.
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
      byCategory: normaliseRates(p.byCategory),
      // A leaving date on its own implies "former" — nobody should have to
      // remember to set both, and forgetting the flag would pay a leaver.
      former: !!p.former || !!p.leftOn,
      leftOn: p.leftOn || null,
    };
    byName.set(normName(p.name), person);
    for (const a of p.aliases || []) byName.set(normName(a), person);
  }
  const rates = {
    default: raw?.rates?.default == null ? null : Number(raw.rates.default),
    byCategory: normaliseRates(raw?.rates?.byCategory),
    excludeCategories: new Set((raw?.rates?.excludeCategories || []).map(normName)),
  };
  return { byName, exclude, rates, loaded: !!raw };
}

const normaliseRates = (obj) => {
  const m = new Map();
  for (const [k, v] of Object.entries(obj || {})) if (v != null) m.set(normName(k), Number(v));
  return m;
};

// Most specific wins: this person on this kind of treatment, then this person,
// then this kind of treatment, then the house default. Returns null rather than 0
// when nothing matches — an unset rate must read as "needs a rate", never as
// "earned nothing", which is the difference between a visible gap and a silent
// underpayment.
export function rateFor(person, category, rates) {
  const c = normName(category);
  if (person?.byCategory?.has(c)) return person.byCategory.get(c);
  if (person?.commissionPct != null) return person.commissionPct;
  if (rates?.byCategory?.has(c)) return rates.byCategory.get(c);
  return rates?.default ?? null;
}

// --- Service categories ----------------------------------------------------
// Commission is set per kind of treatment, and SimpleSpa already groups the 266
// services into 12 categories via each service's `label` (SPA PACKAGES, BODY
// MASSAGE, FACIALS …), so that is the natural unit for a rate rather than asking
// Niobe to price 266 lines. Built across every branch and keyed by service_id
// with a name fallback, for the same reason bookings.js prices that way: a live
// appointment can reference a service_id the branch's current menu no longer has.
let categoryCache = { at: 0, byId: new Map(), byName: new Map() };
const CATEGORY_TTL_MS = 10 * 60 * 1000;

export async function serviceCategories(branches = BRANCHES) {
  if (Date.now() - categoryCache.at < CATEGORY_TTL_MS && categoryCache.byId.size) return categoryCache;
  const byId = new Map();
  const byName = new Map();
  for (const b of branches) {
    try {
      const res = await ssPost(b, 'services.php', { per_page: 1000 });
      for (const s of res.services || []) {
        const label = String(s.label || '').replace(/\s+/g, ' ').trim() || '(uncategorised)';
        byId.set(String(s.service_id), label);
        const k = normName(s.name);
        if (k && !byName.has(k)) byName.set(k, label);
      }
    } catch { /* a branch we can't read must not blank every category */ }
  }
  if (byId.size) categoryCache = { at: Date.now(), byId, byName };
  return categoryCache;
}

const categoryOf = (cats, appt) =>
  cats.byId.get(String(appt.service?.service_id))
  || cats.byName.get(normName(appt.service?.service_name))
  || '(service no longer in menu)';

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
  const formerPeople = new Map(); // same, for staff who have left — reported, never paid
  const unmatched = new Map();  // normalised name -> { name, branches:Set, treatments, value }
  const skipped = {};           // status label -> count
  const branchErrors = [];
  const missingRateFor = new Map(); // "person / category" -> count
  const cats = await serviceCategories(branches);
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

      const category = categoryOf(cats, appt);
      // Fees and charges are not treatments and nobody performs them.
      if (staffMap.rates.excludeCategories.has(normName(category))) {
        skipped[`Not a treatment: ${category}`] = (skipped[`Not a treatment: ${category}`] || 0) + 1;
        continue;
      }

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

      // A leaver's work is computed exactly like anyone else's, into a separate
      // ledger. Same maths, different destination — so her figures are there to
      // settle if she is owed them, without her ever landing in the pay run.
      const target = person.former ? formerPeople : people;
      const row = target.get(person.name) || {
        name: person.name,
        treatments: 0,
        serviceValue: 0,
        commission: 0,
        byBranch: {},
        byCategory: {},
        services: {},
        unratedValue: 0,
        leftOn: person.leftOn,
        afterLeaving: 0,
      };
      row.treatments += 1;
      row.serviceValue += price;
      // Treatments logged under a leaver's login after her last day mean the
      // login is still in use by somebody — that misattributes real work, and
      // it is invisible unless something looks for it.
      if (person.leftOn && String(appt.start).slice(0, 10) > person.leftOn) row.afterLeaving += 1;

      // Commission is worked out per treatment at that treatment's own rate, then
      // summed — NOT a single rate applied to the month's total, which would be
      // wrong the moment a therapist does two kinds of work.
      const pct = rateFor(person, category, staffMap.rates);
      if (pct == null) {
        row.unratedValue += price;
        const k = `${person.name} / ${category}`;
        missingRateFor.set(k, (missingRateFor.get(k) || 0) + 1);
      } else {
        row.commission += price * pct / 100;
      }

      const b = row.byBranch[branch.name] || { treatments: 0, value: 0 };
      b.treatments += 1; b.value += price;
      row.byBranch[branch.name] = b;

      const c = row.byCategory[category] || { treatments: 0, value: 0, commission: 0, pct };
      c.treatments += 1; c.value += price;
      if (pct != null) c.commission += price * pct / 100;
      row.byCategory[category] = c;

      row.services[serviceName] = (row.services[serviceName] || 0) + 1;
      target.set(person.name, row);
    }
  }

  const shape = (map) => [...map.values()].map((r) => ({
    ...r,
    serviceValue: round2(r.serviceValue),
    commission: round2(r.commission),
    // Value this person did that no rate covers. Non-zero means their commission
    // is understated and a rate is missing — never present that as a final figure.
    unratedValue: round2(r.unratedValue),
    byBranch: Object.fromEntries(
      Object.entries(r.byBranch).map(([k, v]) => [k, { ...v, value: round2(v.value) }]),
    ),
    byCategory: Object.fromEntries(
      Object.entries(r.byCategory).map(([k, v]) => [k, { ...v, value: round2(v.value), commission: round2(v.commission) }]),
    ),
  })).sort((a, b) => b.serviceValue - a.serviceValue);

  const rows = shape(people);
  const formerStaff = shape(formerPeople);

  return {
    period: { start, end },
    generatedFor: branches.map((b) => b.name),
    rows,
    totals: {
      people: rows.length,
      treatments: rows.reduce((n, r) => n + r.treatments, 0),
      serviceValue: round2(rows.reduce((n, r) => n + r.serviceValue, 0)),
      commission: round2(rows.reduce((n, r) => n + (r.commission || 0), 0)),
      // Loud on purpose: if this is non-zero the payroll is NOT ready to pay from.
      unratedValue: round2(rows.reduce((n, r) => n + r.unratedValue, 0)),
    },
    missingRates: [...missingRateFor.entries()]
      .map(([k, treatments]) => ({ who: k, treatments }))
      .sort((a, b) => b.treatments - a.treatments),
    // Staff who have left but did paid work in the period. Deliberately OUTSIDE
    // totals — this is a decision to make, not a figure to pay automatically.
    formerStaff,
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
