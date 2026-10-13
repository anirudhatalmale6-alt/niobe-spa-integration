// Gross-to-net (src/payslip.js) on a throwaway staff list. Figures worked by hand from GRA's
// 2026 bands: 588 nil · 80@5% · 100@10% · 2,900@17.5% … (tax at 768 = 14.00).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStaffMap } from '../src/payroll.js';
import { buildPay } from '../src/payslip.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); };

const dir = mkdtempSync(join(tmpdir(), 'niobe-slip-'));
const file = join(dir, 'staff-map.json');
writeFileSync(file, JSON.stringify({ people: [
  { name: 'Ama Therapist', commissionPct: 10, basicSalary: 0, ssnit: true, position: 'Therapist' },
  { name: 'Esi Therapist', commissionPct: 10 },                                   // salary + SSNIT not entered
  { name: 'Akua Reception', basicSalary: 2000, ssnit: true, position: 'Receptionist' },
  { name: 'Abena Enrolling', basicSalary: 1500, ssnit: false, position: 'Supervisor' },
  { name: 'Yaa Left', basicSalary: 3000, ssnit: true, leftOn: '2026-09-01' },
] }));
const staff = loadStaffMap(file);
const rows = [
  { name: 'Ama Therapist', treatments: 80, serviceValue: 34920, commission: 3492, byBranch: {}, byCategory: {}, topUp: 0, deduction: 0 },
  { name: 'Esi Therapist', treatments: 30, serviceValue: 12000, commission: 1200, byBranch: {}, byCategory: {}, topUp: 200, deduction: 100 },
];
const P = buildPay(rows, staff, '2026-09');
const get = (n) => P.rows.find((r) => r.name === n);

const a = get('Ama Therapist');
ok(a.gross === 3492 && a.ssnitAmt === 0 && a.paye === 490.7 && a.net === 3001.3, 'commission only, SSNIT registered: no basic so SSNIT 0; PAYE 490.70; net 3,001.30');

const e = get('Esi Therapist');
// gross 1,400 (1,200 + 200 top-up); PAYE 14 + 632 × 17.5% = 124.60; net 1,400 − 124.60 − 100 = 1,175.40
ok(e.gross === 1400 && e.paye === 124.6 && e.net === 1175.4, 'top-up is taxed with commission (PAYE 124.60); the deduction comes off after tax (net 1,175.40)');

const k = get('Akua Reception');
// gross 2,000; SSNIT 110; chargeable 1,890; PAYE 14 + 1,122 × 17.5% = 210.35; net 1,679.65
ok(k && k.treatments === 0, 'a salaried receptionist with no treatments still gets a row');
ok(k.ssnitAmt === 110 && k.paye === 210.35 && k.net === 1679.65, 'SSNIT 110 off a 2,000 basic before tax; PAYE 210.35; net 1,679.65');

const b = get('Abena Enrolling');
// gross 1,500; no SSNIT; PAYE 14 + 732 × 17.5% = 142.10; net 1,357.90
ok(b.ssnitAmt === 0 && b.paye === 142.1 && b.net === 1357.9, 'still enrolling with SSNIT: nothing deducted for it (PAYE 142.10, net 1,357.90)');

ok(!get('Yaa Left'), 'someone who has left gets no salary row');
ok(P.notes.noSalaryEntered.includes('Esi Therapist') && !P.notes.noSalaryEntered.includes('Ama Therapist'), 'salary NOT ENTERED is reported by name; 0 (commission only) is not');
ok(P.notes.noSsnitStatus.includes('Esi Therapist') && !P.notes.noSsnitStatus.includes('Abena Enrolling'), 'SSNIT not entered is reported; "No" is a real answer and is not');
ok(P.totals.net === 3001.3 + 1175.4 + 1679.65 + 1357.9 && P.totals.paye === 490.7 + 124.6 + 210.35 + 142.1, 'totals add up');
ok(rows[0].net === undefined, 'the payroll rows passed in are not modified');

const aug = buildPay(rows, staff, '2026-08');
ok(aug.notes.noTable && aug.rows.every((r) => r.paye === null && r.net === null) && aug.totals.net === null, 'August 2026 (before the verified table): no PAYE, no net — shown as n/a, never a tax-free net');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
