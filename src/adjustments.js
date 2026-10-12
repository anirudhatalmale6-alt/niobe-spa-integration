// Monthly pay adjustments: a top-up and/or a deduction per person, with a note.
//
// Niobe pays monthly and needs "a row for top-up and deductions if any". Commission comes
// from SimpleSpa; these come from Niobe, so they live in their own sheet per month
// (data/payroll-adjustments-YYYY-MM.csv) that the payroll report reads.
//
// The reader is strict on purpose. A name it cannot place, an amount it cannot read, or the
// same person entered twice STOPS the payroll rather than being skipped: a skipped deduction
// is money paid out that should not have been, and a skipped top-up is somebody short-paid,
// and either way the report would look complete.
import { readFileSync, existsSync } from 'fs';
import { parseCsv, csvRow, csvFile } from './csv.js';
import { normName } from './payroll.js';

export const HEAD = ['Therapist', 'Top-up (GHS)', 'Deductions (GHS)', 'Note'];

const money = (x) => Math.round(x * 100) / 100;

// Every person on the staff list once, current staff only, alphabetical.
export function currentStaff(staffMap) {
  const seen = new Set();
  const out = [];
  for (const p of staffMap.byName.values()) {
    if (seen.has(p.name) || p.former) continue;
    seen.add(p.name);
    out.push(p);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The blank sheet for a month, one row per current therapist so nobody has to type a name.
export function adjustmentsTemplate(staffMap, month) {
  const rows = [
    [`Niobe pay adjustments for ${month}. Fill in only the people who have one; leave the rest blank.`],
    ['Top-up = anything extra this month (bonus, allowance, a correction owed to them). Deductions = anything taken off (advance, loan repayment, shortage). Amounts in GHS, numbers only.'],
    [],
    HEAD,
    ...currentStaff(staffMap).map((p) => [p.name, '', '', '']),
  ];
  // csvRow carries the formula-injection guard: these names were typed by people.
  return csvFile(rows.map(csvRow));
}

function amount(raw) {
  const s = String(raw ?? '').trim().replace(/^GHS\s*/i, '').replace(/,/g, '');
  if (s === '') return { ok: true, value: 0 };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false };
  return { ok: true, value: Number(s) };
}

// Read and check one month's sheet. Returns { exists, entries: Map(name -> {topUp, deduction,
// note, person}), errors: [] }. `entries` only holds rows with a non-zero amount.
export function parseAdjustments(text, staffMap) {
  const rows = parseCsv(text);
  const errors = [];
  const entries = new Map();
  const h = rows.findIndex((r) => normName(r[0]) === 'therapist');
  if (h < 0) return { entries, errors: ['No "Therapist" header row — is this the adjustments sheet?'] };
  const col = (label) => rows[h].findIndex((c) => normName(c).startsWith(normName(label)));
  const iTop = col('Top-up'), iDed = col('Deductions'), iNote = col('Note');
  if (iTop < 0 || iDed < 0) return { entries, errors: ['The sheet needs both a "Top-up" and a "Deductions" column.'] };

  for (let r = h + 1; r < rows.length; r++) {
    const row = rows[r];
    const name = String(row[0] || '').trim();
    const top = amount(row[iTop]);
    const ded = amount(row[iDed]);
    const note = iNote >= 0 ? String(row[iNote] || '').trim() : '';
    const line = r + 1;
    if (!top.ok) errors.push(`Line ${line} (${name || 'no name'}): top-up "${row[iTop]}" is not an amount.`);
    if (!ded.ok) errors.push(`Line ${line} (${name || 'no name'}): deduction "${row[iDed]}" is not an amount.`);
    if (!top.ok || !ded.ok) continue;
    if (!top.value && !ded.value) continue;                       // nothing to apply
    if (!name) { errors.push(`Line ${line}: an amount with no name next to it.`); continue; }
    const person = staffMap.byName.get(normName(name));
    if (!person) { errors.push(`Line ${line}: "${name}" is not on the staff list. Check the spelling, or add them to the staff list first.`); continue; }
    if (entries.has(person.name)) {
      errors.push(`Line ${line}: ${person.name} appears twice. Put the total on one line so it is clear what was meant.`);
      continue;
    }
    entries.set(person.name, { topUp: money(top.value), deduction: money(ded.value), note, person });
  }
  return { entries, errors };
}

export function loadAdjustments(file, staffMap) {
  if (!existsSync(file)) return { exists: false, entries: new Map(), errors: [] };
  return { exists: true, ...parseAdjustments(readFileSync(file, 'utf8'), staffMap) };
}

// Put the adjustments onto the payroll rows. A person with an adjustment but no treatments
// this month still gets a row — a top-up for someone on leave must not vanish because
// SimpleSpa has nothing for them. Leavers' adjustments are reported apart and NOT totalled,
// exactly like leavers' commission: someone decides, nobody omits.
export function applyAdjustments(rows, entries) {
  const out = rows.map((row) => ({ ...row, topUp: 0, deduction: 0, adjustmentNote: '' }));
  const byName = new Map(out.map((r) => [r.name, r]));
  const leavers = [];
  for (const [name, a] of entries) {
    if (a.person.former) { leavers.push({ name, leftOn: a.person.leftOn, ...a }); continue; }
    let row = byName.get(name);
    if (!row) {
      row = { name, treatments: 0, serviceValue: 0, commission: 0, byBranch: {}, byCategory: {}, unratedValue: 0, topUp: 0, deduction: 0, adjustmentNote: '' };
      out.push(row); byName.set(name, row);
    }
    row.topUp = a.topUp; row.deduction = a.deduction; row.adjustmentNote = a.note;
  }
  for (const row of out) row.payDue = money(row.commission + row.topUp - row.deduction);
  const totals = {
    topUp: money(out.reduce((s, r) => s + r.topUp, 0)),
    deduction: money(out.reduce((s, r) => s + r.deduction, 0)),
    payDue: money(out.reduce((s, r) => s + r.payDue, 0)),
  };
  return { rows: out, totals, leavers, negative: out.filter((r) => r.payDue < 0) };
}
