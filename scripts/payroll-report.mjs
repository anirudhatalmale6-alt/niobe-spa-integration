#!/usr/bin/env node
// Monthly commission report.
//
//   node scripts/payroll-report.mjs 2026-07            -> writes data/payroll-2026-07.csv
//   node scripts/payroll-report.mjs 2026-07 --stdout   -> prints instead of writing
//
// Produces the "total summary for each staff" Niobe asked for: one line per
// therapist with her work consolidated across every branch she covered, which is
// the manual per-branch extract-and-stitch this replaces.
//
// CSV rather than a spreadsheet file on purpose — this app runs with no npm
// dependencies, and a CSV opens straight into Excel and into whatever the
// accountant uses. Written UTF-8 with a BOM so Excel keeps the GHS figures and
// any accented name intact instead of mangling them.
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runPayroll, loadStaffMap } from '../src/payroll.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const month = process.argv[2];
if (!/^\d{4}-\d{2}$/.test(month || '')) {
  console.error('Usage: node scripts/payroll-report.mjs YYYY-MM [--stdout]');
  process.exit(1);
}
const [y, m] = month.split('-').map(Number);
const start = `${month}-01`;
const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day of month

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (cells) => cells.map(esc).join(',');

const staffMap = loadStaffMap();
if (!staffMap.loaded) {
  console.error('No data/staff-map.json found — the confirmed staff list and commission rates must be in place first.');
  process.exit(1);
}

const r = await runPayroll({ start, end, staffMap });

// Categories actually worked this month, busiest first, so the columns are stable
// across the sheet and a therapist's split is readable at a glance.
const categories = [...new Set(r.rows.flatMap((row) => Object.keys(row.byCategory)))]
  .sort((a, b) => {
    const v = (c) => r.rows.reduce((n, row) => n + (row.byCategory[c]?.value || 0), 0);
    return v(b) - v(a);
  });

const out = [];
out.push(line([`Niobe Beauty — commission summary`]));
out.push(line([`Period`, `${start} to ${end}`]));
out.push(line([`Branches`, r.generatedFor.join(' / ')]));
out.push(line([`Counts`, `treatments completed and paid only`]));
out.push([]);

out.push(line([
  'Therapist', 'Treatments', 'Service value (GHS)', 'Commission (GHS)',
  'Branches worked', ...categories.map((c) => `${c} (GHS)`), 'Value with no rate set (GHS)',
]));

for (const row of r.rows) {
  out.push(line([
    row.name,
    row.treatments,
    row.serviceValue.toFixed(2),
    row.commission.toFixed(2),
    Object.keys(row.byBranch).join(' / '),
    ...categories.map((c) => (row.byCategory[c] ? row.byCategory[c].value.toFixed(2) : '')),
    row.unratedValue ? row.unratedValue.toFixed(2) : '',
  ]));
}

out.push([]);
out.push(line(['TOTAL', r.totals.treatments, r.totals.serviceValue.toFixed(2), r.totals.commission.toFixed(2)]));

// Everything that makes the number checkable rather than just plausible. These
// belong in the file itself — a caveat that lives only in a chat message is a
// caveat nobody sees at the point of paying.
out.push([]);
out.push(line(['CHECKS — read before paying']));
// Report a missing rate whenever one is missing — NOT only when it costs money
// this month. A rate can be absent while the affected treatments happen to carry
// no price, which nets to zero and would otherwise print a reassuring "OK" over a
// real gap; the moment those services are priced, the same gap underpays someone.
if (r.missingRates.length) {
  out.push(line(['NOT READY: treatments with no commission rate set']));
  if (r.totals.unratedValue) {
    out.push(line(['  value affected this period (GHS)', r.totals.unratedValue.toFixed(2)]));
  } else {
    out.push(line(['  value affected this period (GHS)', '0.00',
      'nil only because these services currently have no price — set the rate anyway']));
  }
  for (const mr of r.missingRates) out.push(line(['  needs a rate', mr.who, `${mr.treatments} treatment(s)`]));
} else {
  out.push(line(['Every treatment had a commission rate', 'OK']));
}
if (r.unpricedTreatments) {
  out.push(line(['Treatments whose service has no price in the menu', r.unpricedTreatments,
    'these earn nothing until a price is supplied']));
}
// Leavers are shown, never summed into the total above. Someone has to decide
// whether commission is still owed for the days they worked; the one thing that
// must not happen is the decision being made by omission.
if (r.formerStaff.length) {
  out.push([]);
  out.push(line(['LEFT THE BUSINESS — decide before paying, NOT included in the total above']));
  out.push(line(['Therapist', 'Left on', 'Treatments', 'Service value (GHS)', 'Commission if owed (GHS)', 'Branches worked']));
  for (const f of r.formerStaff) {
    out.push(line([
      f.name, f.leftOn || 'date not given', f.treatments,
      f.serviceValue.toFixed(2), f.commission.toFixed(2), Object.keys(f.byBranch).join(' / '),
    ]));
    if (f.afterLeaving) {
      out.push(line(['  CHECK', `${f.afterLeaving} treatment(s) dated AFTER her last day — her SimpleSpa login is still being used, so this work belongs to somebody else`]));
    }
  }
}
if (r.unmatchedStaff.length) {
  out.push([]);
  out.push(line(['Therapists NOT on the confirmed staff list — not paid below']));
  for (const u of r.unmatchedStaff) {
    out.push(line(['  unrecognised', u.name, u.branches.join(' / '), `${u.treatments} treatment(s)`, u.value.toFixed(2)]));
  }
}
if (r.branchErrors.length) {
  out.push(line(['BRANCH PROBLEMS — figures may be incomplete']));
  for (const b of r.branchErrors) out.push(line(['  ', b.branch, b.error]));
}
out.push([]);
out.push(line(['Excluded from commission']));
for (const [k, v] of Object.entries(r.skippedByStatus)) out.push(line(['  ', k, v]));

const csv = '﻿' + out.map((l) => (Array.isArray(l) ? '' : l)).join('\r\n') + '\r\n';

if (process.argv.includes('--stdout')) {
  process.stdout.write(csv);
} else {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const file = join(ROOT, 'data', `payroll-${month}.csv`);
  writeFileSync(file, csv);
  console.log(`Wrote ${file}`);
  console.log(`${r.totals.people} therapists, ${r.totals.treatments} treatments, GHS ${r.totals.serviceValue.toLocaleString()} of work, GHS ${r.totals.commission.toLocaleString()} commission.`);
  if (r.totals.unratedValue) console.log(`WARNING: GHS ${r.totals.unratedValue.toLocaleString()} of work has no commission rate — not ready to pay from.`);
  if (r.unmatchedStaff.length) console.log(`WARNING: ${r.unmatchedStaff.length} therapist(s) not on the confirmed staff list — see the file.`);
}
