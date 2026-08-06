import { BRANCHES, CONFIG, branchById } from './config.js';
import { ssPost } from './simplespa.js';
import { mockAvailabilityData } from './mockData.js';

// ---------------------------------------------------------------------------
// Unified booking availability across all branches.
//
// SimpleSpa exposes NO availability/slots endpoint (and no create-appointment
// endpoint), so we COMPUTE open slots ourselves from three live reads per branch:
//   • staff.php        — each therapist's weekly working hours
//   • services.php     — the requested service's duration (+ downtime)
//   • appointments.php — existing bookings that block a therapist's time
// A start time is "available" at a branch if at least one on-shift therapist is
// free for the full service duration without overlapping an existing booking.
//
// Determined empirically against Niobe's live data:
//   • staff `hours[].day` uses 0 = Monday … 6 = Sunday.
//   • A booking blocks a therapist when its status is one of BLOCKING_STATUS;
//     cancellations (15) and no-shows (17) free the slot.
// SimpleSpa's API has no service→therapist capability map, so v1 treats every
// on-shift therapist as able to perform the service (branch-level "is anyone
// free?"). If Niobe later wants per-therapist skills, that is the one place to
// refine — the slot maths stays the same.
// ---------------------------------------------------------------------------

// Appointment statuses that occupy a therapist's time (everything except a
// cancellation (15) or a no-show (17), which leave the slot open). Includes
// 10 Online and 22 Confirmed (No SMS) — both real bookings that block a slot;
// omitting them would let availability double-book over an online reservation.
const BLOCKING_STATUS = new Set([0, 5, 10, 20, 22, 25, 30]);

// Map a JS weekday (0 = Sunday … 6 = Saturday) to SimpleSpa's (0 = Monday … 6 = Sunday).
const toSpaDay = (jsDay) => (jsDay + 6) % 7;

const pad2 = (n) => String(n).padStart(2, '0');
const hmToMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const minToHm = (mins) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
// SimpleSpa datetimes are "YYYY-MM-DD HH:MM:SS" wall-clock (Ghana = GMT year-round).
const dtToMin = (s) => { const t = String(s).split(' ')[1] || '00:00:00'; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const dateOf = (s) => String(s).split(' ')[0];

// Parse "YYYY-MM-DD" to a JS weekday without any timezone drift.
function jsWeekday(dateStr) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D)).getUTCDay();
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function fetchAppointments(branch, date) {
  const res = await ssPost(branch, 'appointments.php', { start: date, end: date, per_page: 1000 });
  return res.appointments || Object.values(res).find(Array.isArray) || [];
}
async function fetchStaff(branch) {
  const res = await ssPost(branch, 'staff.php', { per_page: 1000 });
  return res.staff || Object.values(res).find(Array.isArray) || [];
}
async function fetchServices(branch) {
  const res = await ssPost(branch, 'services.php', { per_page: 1000 });
  return res.services || Object.values(res).find(Array.isArray) || [];
}

// Working windows [{start,end} in minutes] for a therapist on a given SimpleSpa day.
function windowsForDay(staff, spaDay) {
  return (staff.hours || [])
    .filter((h) => String(h.day) === String(spaDay))
    .map((h) => ({ start: hmToMin(h.startTime), end: hmToMin(h.endTime) }))
    .filter((w) => w.end > w.start);
}

// Busy blocks [{start,end} in minutes] for a therapist on `date`.
function busyForStaff(appointments, staffId, date) {
  return appointments
    .filter((a) => a.staff?.staff_id === staffId && dateOf(a.start) === date && BLOCKING_STATUS.has(Number(a.status)))
    .map((a) => ({ start: dtToMin(a.start), end: dtToMin(a.end) }));
}

const overlaps = (aS, aE, blocks) => blocks.some((b) => aS < b.end && b.start < aE);

// Compute the open start times for one service at one branch on one date.
// Returns { slots:[{time, staffCount, staff:[names]}], staffOnShift, error? }.
export async function branchAvailability({ branch, service, date, granularity, fromMinute = 0 }) {
  const staff = await fetchStaff(branch);
  const appointments = await fetchAppointments(branch, date);
  const spaDay = toSpaDay(jsWeekday(date));
  const duration = Number(service.duration_minutes) || 0;
  const downtime = Number(service.downtime_minutes) || 0;
  const step = granularity || CONFIG.slotGranularity;

  const slotMap = new Map(); // startMinute -> Set(staffName)
  let onShift = 0;
  for (const st of staff) {
    const windows = windowsForDay(st, spaDay);
    if (!windows.length) continue;
    onShift++;
    const busy = busyForStaff(appointments, st.staff_id, date);
    const name = `${st.firstname || ''} ${st.lastname || ''}`.trim() || 'Therapist';
    for (const w of windows) {
      // Candidate starts on the granularity grid; the service (+ downtime) must
      // finish within the working window and not overlap an existing booking.
      const first = Math.ceil(Math.max(w.start, fromMinute) / step) * step;
      for (let t = first; t + duration <= w.end; t += step) {
        if (overlaps(t, t + duration + downtime, busy)) continue;
        if (!slotMap.has(t)) slotMap.set(t, new Set());
        slotMap.get(t).add(name);
      }
    }
  }

  const slots = [...slotMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, names]) => ({ time: minToHm(t), staffCount: names.size, staff: [...names] }));
  return { slots, staffOnShift: onShift };
}

// Match a service across branches: exact service_id if the branch was named,
// otherwise by normalised name (service_ids differ per branch portal).
function findService(services, { serviceId, serviceName }) {
  if (serviceId) { const s = services.find((x) => x.service_id === serviceId); if (s) return s; }
  if (serviceName) { const n = norm(serviceName); return services.find((x) => norm(x.name) === n); }
  return null;
}

// The unified feed: for a service (by name) + date, what's open at every branch.
export async function getUnifiedAvailability({ serviceName, serviceId, date, branchId, granularity }) {
  if (!date) throw new Error('A date (YYYY-MM-DD) is required');

  if (CONFIG.demoMode) return mockAvailabilityData({ serviceName, date, branchId });

  const targetBranches = branchId ? BRANCHES.filter((b) => b.id === branchId) : BRANCHES;
  const results = await Promise.all(targetBranches.map(async (branch) => {
    try {
      const services = await fetchServices(branch);
      const service = findService(services, { serviceId, serviceName });
      if (!service) return { id: branch.id, name: branch.name, ok: true, offered: false, slots: [] };
      const { slots, staffOnShift } = await branchAvailability({ branch, service, date, granularity });
      return {
        id: branch.id, name: branch.name, ok: true, offered: true,
        service: { name: service.name, duration_minutes: Number(service.duration_minutes) || 0, price: Number(service.price) || 0 },
        staffOnShift, slots,
      };
    } catch (err) {
      return { id: branch.id, name: branch.name, ok: false, offered: false, slots: [], error: err.message };
    }
  }));

  return {
    generatedAt: new Date().toISOString(),
    demoMode: CONFIG.demoMode,
    query: { serviceName: serviceName || null, date, branchId: branchId || null },
    dayOfWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][toSpaDay(jsWeekday(date))],
    branches: results,
    summary: {
      branchesOffering: results.filter((b) => b.offered).length,
      totalOpenSlots: results.reduce((s, b) => s + b.slots.length, 0),
    },
  };
}

// Distinct service names across all branches, for the picker. Merged by name so
// "Swedish Massage" at three branches appears once.
export async function listServiceNames() {
  if (CONFIG.demoMode) return mockAvailabilityData({ list: true });
  const all = await Promise.all(BRANCHES.map(async (b) => {
    try { return await fetchServices(b); } catch { return []; }
  }));
  const map = new Map();
  for (const list of all) {
    // Count DISTINCT branches per service name — a branch that lists the same
    // service twice (e.g. under two categories) must only count once.
    const seenHere = new Set();
    for (const s of list) {
      const key = norm(s.name);
      if (!map.has(key)) map.set(key, { name: s.name, duration_minutes: Number(s.duration_minutes) || 0, branches: 0 });
      if (!seenHere.has(key)) { map.get(key).branches++; seenHere.add(key); }
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
