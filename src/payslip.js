// From "what each person earned" to "what each person is paid": basic salary, commission and
// top-up make gross pay; SSNIT (5.5% of BASIC, only for those registered) and PAYE come off;
// then the month's deductions. Tax rules live in paye.js — this file only assembles the slip.
//
// Niobe's therapists are commission only (basic 0) and employees, so PAYE uses GRA's bands on
// their commission plus any top-up. Salaried staff — reception, managers — have no treatments
// in SimpleSpa at all, so they would never appear on a report built from appointments; every
// current person with a basic salary gets a row whether SimpleSpa knows about them or not.
//
// Deductions (advances, loan repayments, shortages) come off AFTER tax. That is an assumption
// stated to Niobe and printed on the report for the accountant to confirm.
import { monthlyPay, tableFor } from './paye.js';
import { normName } from './payroll.js';
import { currentStaff } from './adjustments.js';

const money = (x) => Math.round(x * 100) / 100;

export function buildPay(rows, staffMap, month) {
  const table = tableFor(month);
  const out = rows.map((r) => ({ ...r }));
  const have = new Set(out.map((r) => r.name));
  for (const p of currentStaff(staffMap)) {
    if (!have.has(p.name) && p.basicSalary > 0) {
      out.push({ name: p.name, treatments: 0, serviceValue: 0, commission: 0, byBranch: {}, byCategory: {}, unratedValue: 0, topUp: 0, deduction: 0, adjustmentNote: '' });
      have.add(p.name);
    }
  }
  const notes = { noSalaryEntered: [], noSsnitStatus: [], noTable: !table };
  for (const r of out) {
    const person = staffMap.byName.get(normName(r.name)) || {};
    r.position = person.position || '';
    r.basic = person.basicSalary ?? 0;
    if (person.basicSalary == null) notes.noSalaryEntered.push(r.name);
    if (person.ssnit == null) notes.noSsnitStatus.push(r.name);
    r.ssnitRegistered = person.ssnit === true;
    const pay = monthlyPay({
      month, basic: r.basic, commission: r.commission || 0, allowances: r.topUp || 0,
      employment: 'employee', ssnit: r.ssnitRegistered,
    });
    r.gross = money(r.basic + (r.commission || 0) + (r.topUp || 0));
    if (pay.ok) {
      r.ssnitAmt = pay.ssnit; r.paye = pay.paye; r.taxed = true;
      r.net = money(pay.net - (r.deduction || 0));
    } else {
      // No verified tax table for this month: say so in the cells rather than print a net
      // pay that silently skipped the tax.
      r.ssnitAmt = null; r.paye = null; r.taxed = false; r.net = null;
    }
  }
  const sum = (k) => money(out.reduce((s, r) => s + (r[k] || 0), 0));
  const totals = { basic: sum('basic'), gross: sum('gross'), ssnit: sum('ssnitAmt'), paye: sum('paye'), net: table ? sum('net') : null };
  return { rows: out, totals, notes, table };
}
