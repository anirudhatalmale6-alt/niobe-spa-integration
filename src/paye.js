// Ghana PAYE for resident individuals — the monthly calculation.
//
// Source: GRA, "PAYE Tax Bands for Year of Assessment 2026", in force from 1 September 2026
// (https://gra.gov.gh/?p=6167), checked 12 Oct 2026 against the copy Niobe sent. A third-party
// summary of the same table had the sixth band as 30,334; GRA's own page says 30,332, which is
// also the only figure that makes the bands add up to the 50,000 where 35% starts.
//
// Each table carries the date it took effect, and a month before the earliest table is REFUSED
// rather than computed with the nearest rates: tax worked out on the wrong year's bands looks
// exactly as plausible as the right answer, and nobody would know until GRA did.
//
// Also from GRA's PAYE guidance: the employee's SSNIT contribution, 5.5% of BASIC salary, is
// deducted before PAYE is worked out; a payment to a casual worker carries a flat 5% instead.
export const TABLES = [
  {
    from: '2026-09-01',
    source: 'https://gra.gov.gh/?p=6167',
    monthly: [
      { band: 588, rate: 0 },
      { band: 80, rate: 0.05 },
      { band: 100, rate: 0.10 },
      { band: 2900, rate: 0.175 },
      { band: 16000, rate: 0.25 },
      { band: 30332, rate: 0.30 },
      { band: Infinity, rate: 0.35 },
    ],
  },
];

export const SSNIT_EMPLOYEE_RATE = 0.055;
export const CASUAL_WITHHOLDING_RATE = 0.05;

const pesewas = (x) => Math.round(x * 100) / 100;

// The table in force on the first day of the pay month ('YYYY-MM'), or null if none is known.
export function tableFor(month) {
  const day = `${month}-01`;
  return [...TABLES].sort((a, b) => b.from.localeCompare(a.from)).find((t) => t.from <= day) || null;
}

// PAYE on one month's chargeable income, with the working shown band by band — a payslip
// figure nobody can reproduce is one nobody can check.
export function payeMonthly(chargeable, month) {
  const table = tableFor(month);
  if (!table) return { ok: false, reason: 'no_table_for_month', month };
  let left = Math.max(0, Number(chargeable) || 0);
  let tax = 0;
  const working = [];
  for (const { band, rate } of table.monthly) {
    if (left <= 0) break;
    const slice = Math.min(left, band);
    tax += slice * rate;
    working.push({ slice: pesewas(slice), rate, tax: pesewas(slice * rate) });
    left -= slice;
  }
  return { ok: true, tax: pesewas(tax), working, tableFrom: table.from };
}

// One person's month. Commission is employment income, so it is taxed together with salary
// and allowances, not on its own — taxing it separately would start every slice at nil again.
// SSNIT is on BASIC salary only, never on commission or allowances.
export function monthlyPay({ month, basic = 0, allowances = 0, commission = 0, employment = 'employee', ssnit = true }) {
  const gross = pesewas(Number(basic) + Number(allowances) + Number(commission));
  if (employment === 'casual') {
    const tax = pesewas(gross * CASUAL_WITHHOLDING_RATE);
    return { ok: true, employment, gross, ssnit: 0, chargeable: gross, paye: tax, net: pesewas(gross - tax), basis: 'casual worker, 5% withholding' };
  }
  const ssnitAmt = ssnit ? pesewas(Number(basic) * SSNIT_EMPLOYEE_RATE) : 0;
  const chargeable = pesewas(gross - ssnitAmt);
  const p = payeMonthly(chargeable, month);
  if (!p.ok) return p;
  return { ok: true, employment, gross, ssnit: ssnitAmt, chargeable, paye: p.tax, net: pesewas(gross - ssnitAmt - p.tax), working: p.working, tableFrom: p.tableFrom };
}
