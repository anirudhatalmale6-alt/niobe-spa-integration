// Monthly top-ups and deductions (src/adjustments.js), against a throwaway staff list.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStaffMap } from '../src/payroll.js';
import { adjustmentsTemplate, parseAdjustments, applyAdjustments } from '../src/adjustments.js';
import { parseCsv } from '../src/csv.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); };

const dir = mkdtempSync(join(tmpdir(), 'niobe-adj-'));
const mapFile = join(dir, 'staff-map.json');
writeFileSync(mapFile, JSON.stringify({ people: [
  { name: 'Ama Serwaa Mensah', aliases: ['ama mensah'], commissionPct: 10 },
  { name: 'Priscilla Enyonam Zekpe', aliases: ['priscella zekpe'], commissionPct: 10 },
  { name: 'Esi Owusu', commissionPct: 10 },
  { name: 'Yaa Boateng', commissionPct: 10, leftOn: '2026-09-15' },
] }));
const staff = loadStaffMap(mapFile);

const tpl = adjustmentsTemplate(staff, '2026-10');
const tplRows = parseCsv(tpl);
ok(tplRows.some((r) => r[0] === 'Therapist') && ['Ama Serwaa Mensah', 'Esi Owusu', 'Priscilla Enyonam Zekpe'].every((n) => tplRows.some((r) => r[0] === n)), 'the blank sheet lists every current therapist');
ok(!tplRows.some((r) => r[0] === 'Yaa Boateng'), 'and leaves out someone who has left');
ok(parseAdjustments(tpl, staff).errors.length === 0 && parseAdjustments(tpl, staff).entries.size === 0, 'an untouched blank sheet reads as "no adjustments", not as errors');

const sheet = (lines) => ['Therapist,Top-up (GHS),Deductions (GHS),Note', ...lines].join('\r\n');
let r = parseAdjustments(sheet([
  'Ama Serwaa Mensah,200,,Bonus for September',
  'priscella zekpe,,"1,000.00",Advance repayment',
  'Esi Owusu,GHS 50,25.5,Transport top-up less shortage',
  ',,,',
]), staff);
ok(r.errors.length === 0, 'a correctly filled sheet has no errors');
ok(r.entries.get('Ama Serwaa Mensah')?.topUp === 200, 'top-up read');
ok(r.entries.get('Priscilla Enyonam Zekpe')?.deduction === 1000, 'an old spelling finds the right person, and "1,000.00" reads as 1000');
ok(r.entries.get('Esi Owusu')?.topUp === 50 && r.entries.get('Esi Owusu')?.deduction === 25.5, '"GHS 50" is accepted, and both columns on one line work');

const bad = parseAdjustments(sheet([
  'Ama Mensa,100,,typo in the name',
  'Esi Owusu,fifty,,',
  'Esi Owusu,-20,,',
  ',300,,',
  'Ama Serwaa Mensah,100,,',
  'ama mensah,50,,second line for the same person',
]), staff);
const has = (re) => bad.errors.some((e) => re.test(e));
ok(has(/"Ama Mensa" is not on the staff list/), 'a misspelt name is an error, not skipped');
ok(has(/"fifty" is not an amount/), 'words instead of a number is an error');
ok(has(/"-20" is not an amount/), 'a negative amount is an error (deductions go in their own column)');
ok(has(/an amount with no name/), 'an amount with no name is an error');
ok(has(/Ama Serwaa Mensah appears twice/), 'the same person twice (under two spellings) is an error');

// Onto the payroll rows.
const rows = [
  { name: 'Ama Serwaa Mensah', treatments: 40, serviceValue: 12000, commission: 1200, byBranch: {}, byCategory: {} },
  { name: 'Esi Owusu', treatments: 5, serviceValue: 200, commission: 20, byBranch: {}, byCategory: {} },
];
const leaverEntry = parseAdjustments(sheet(['Yaa Boateng,300,,final settlement']), staff).entries;
const A = applyAdjustments(rows, new Map([...r.entries, ...leaverEntry]));
const get = (n) => A.rows.find((x) => x.name === n);
ok(get('Ama Serwaa Mensah').payDue === 1400, 'commission 1,200 + top-up 200 = pay due 1,400');
ok(get('Priscilla Enyonam Zekpe') && get('Priscilla Enyonam Zekpe').treatments === 0, 'someone with no treatments this month still gets a row for their adjustment');
ok(get('Priscilla Enyonam Zekpe').payDue === -1000 && A.negative.some((n) => n.name === 'Priscilla Enyonam Zekpe'), 'deductions larger than pay are flagged, not hidden');
ok(get('Esi Owusu').payDue === 44.5, '20 + 50 − 25.50 = 44.50');
ok(A.leavers.length === 1 && !get('Yaa Boateng'), 'a leaver\'s adjustment is reported apart, not in the table');
ok(A.totals.topUp === 250 && A.totals.deduction === 1025.5 && A.totals.payDue === 1220 + 250 - 1025.5, 'totals exclude the leaver: top-ups 250, deductions 1,025.50');
ok(rows[0].payDue === undefined, 'the original payroll rows are not modified');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
