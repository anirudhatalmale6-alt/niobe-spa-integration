// PAYE against figures worked out by hand from GRA's 2026 table (from 1 Sep 2026):
// first 588 nil, next 80 @5%, next 100 @10%, next 2,900 @17.5%, next 16,000 @25%,
// next 30,332 @30%, above 50,000 @35%. Cumulative tax at the top of each band:
//   588 -> 0 · 668 -> 4 · 768 -> 14 · 3,668 -> 521.50 · 19,668 -> 4,521.50 · 50,000 -> 13,621.10
import { payeMonthly, monthlyPay } from '../src/paye.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); };
const M = '2026-09';

for (const [income, tax] of [[0, 0], [588, 0], [668, 4], [768, 14], [3668, 521.5], [19668, 4521.5], [50000, 13621.1]]) {
  ok(payeMonthly(income, M).tax === tax, `GHS ${income} chargeable -> PAYE ${tax} (band edge)`);
}
ok(payeMonthly(1000, M).tax === 54.6, 'GHS 1,000 -> 54.60  (0 + 4 + 10 + 232 x 17.5%)');
ok(payeMonthly(60000, M).tax === 17121.1, 'GHS 60,000 -> 17,121.10  (13,621.10 + 10,000 x 35%)');
ok(payeMonthly(3492, M).tax === 490.7, 'GHS 3,492 -> 490.70');

const w = payeMonthly(1000, M).working;
ok(w.reduce((s, x) => s + x.tax, 0).toFixed(2) === '54.60' && w.length === 4, 'the band-by-band working adds up to the total');

ok(payeMonthly(1000, '2026-08').ok === false, 'August 2026 is REFUSED, not taxed on September\'s bands');
ok(payeMonthly(1000, '2026-12').tableFrom === '2026-09-01', 'a later month uses the table in force');

// Whole month: SSNIT 5.5% of BASIC only, then PAYE on the rest.
const p = monthlyPay({ month: M, basic: 2000, allowances: 300, commission: 1500 });
// gross 3,800; SSNIT 110; chargeable 3,690; PAYE 521.50 + 22 x 25% = 527.00; net 3,163.00
ok(p.gross === 3800 && p.ssnit === 110 && p.chargeable === 3690, 'SSNIT is 5.5% of basic (110), not of commission or allowances');
ok(p.paye === 527 && p.net === 3163, 'salary + allowances + commission taxed TOGETHER: PAYE 527.00, net 3,163.00');
const apart = payeMonthly(2190, M).tax + payeMonthly(1500, M).tax;
ok(apart < p.paye, `taxing commission separately would under-deduct (${apart.toFixed(2)} vs ${p.paye.toFixed(2)})`);

const c = monthlyPay({ month: M, commission: 3492, employment: 'casual' });
ok(c.paye === 174.6 && c.ssnit === 0, 'a casual worker: flat 5% (174.60 on 3,492), no SSNIT');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
