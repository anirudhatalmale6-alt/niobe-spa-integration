// Turn the duplicate report into CSVs the front desk can actually work from.
// Output goes to data/ — customer PII, gitignored.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = JSON.parse(readFileSync(join(ROOT, 'data', 'client-duplicates.json'), 'utf8'));

const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const HEAD = ['set','branch','matched_on','action','client_id','name','mobile','email','visits','created','last_visit'];

function rows(pick) {
  const out = [];
  let n = 0;
  for (const b of Object.values(r.branches)) {
    for (const g of b.confirmed) {
      if (!pick(g)) continue;
      n++;
      for (const m of g.members) {
        out.push([n, b.name, g.basis, m.id === g.keep ? 'KEEP' : 'merge into KEEP',
          m.id, m.name, m.mobile, m.email, m.visits, m.created, m.lastVisit].map(q).join(','));
      }
    }
  }
  return [HEAD.join(','), ...out].join('\n');
}

writeFileSync(join(ROOT, 'data', 'duplicates-with-history.csv'), rows((g) => g.visitsOnOthers > 0));
writeFileSync(join(ROOT, 'data', 'duplicates-all-confirmed.csv'), rows(() => true));

// The needs-a-human pile, kept separate on purpose: these share a phone or email but
// the names differ, so they are shared handsets, corporate accounts and family members
// as often as they are duplicates. Merging this file unread would fuse strangers.
const rev = [['set','branch','matched_on','client_id','name','mobile','email','visits','created'].join(',')];
let n = 0;
for (const b of Object.values(r.branches)) {
  for (const g of b.review) {
    n++;
    for (const m of g.members) rev.push([n, b.name, g.basis, m.id, m.name, m.mobile, m.email, m.visits, m.created].map(q).join(','));
  }
}
writeFileSync(join(ROOT, 'data', 'duplicates-needs-review.csv'), rev.join('\n'));
console.log('written: duplicates-with-history.csv, duplicates-all-confirmed.csv, duplicates-needs-review.csv');
