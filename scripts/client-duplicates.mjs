// Find duplicate client records across Niobe's five SimpleSpa branches.
//
// WHY THIS IS NOT "GROUP BY PHONE NUMBER"
//
// The first version of this script did exactly that and reported 13,327 removable
// records. Looking at what it had actually counted killed the number:
//
//   0202009899 -> 20 records: Adabelle Otoo, Adelle Adjei, Afua Ntrakwah, Amber Smith,
//                 Catherine Hyde ... twenty different names, nineteen of them created
//                 on the SAME DAY with zero visits.
//
// That is one contact number attached to a bulk import — a school group, an office
// block booking, or a front desk putting its own number on every row. Twenty different
// people, not one person twenty times. "Merge these" would have fused twenty strangers
// into a single client record, and the same pattern accounted for every large set.
//
// Smaller sets fail the same way for a different reason. Sharing a phone is ordinary:
//   Access Bank (Beverlyn) / Beverley Quaynor  -> a corporate account and her own
//   Adelaide Osei / Rose Morrison              -> two people, one handset
// while these two really are one person:
//   Abuba Rayma / Rhyma Abuba                  -> name reversed and misspelled
//   Adelaide Benneh Prempeh / Adelaide Prempeh -> middle name dropped
//
// A matching phone number is therefore a REASON TO LOOK, never a verdict. The name has
// to agree as well. So this reports three tiers and never merges the lower ones:
//
//   CONFIRMED  — contact matches AND the names are the same person (exact, subset, or
//                a reordered/misspelt variant). Safe to merge.
//   REVIEW     — contact matches, names differ. A human has to decide. Most shared
//                handsets and corporate accounts land here, and so do a few genuine
//                duplicates where someone changed their name.
//   BULK       — a contact shared by many records created together with no visits.
//                Not duplicates at all. Listed so they can be recognised, not merged.
//
// The second, separate finding is cross-branch: the same person known independently at
// two or more branches. That is NOT a fault — each branch is its own SimpleSpa account
// with its own client list — but it is the thing that has to be solved for cross-branch
// booking and for any loyalty scheme. Deleting anything there would destroy a real
// branch's visit history.
//
// Read-only: reads the pulled snapshot, never calls or writes to SimpleSpa.
//
// Run:  node scripts/client-duplicates.mjs [path-to-clients-raw.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || join(ROOT, 'data', 'clients-raw.json');
const data = JSON.parse(readFileSync(SRC, 'utf8'));

// --- normalisers --------------------------------------------------------------
// Last nine digits, matching how the rest of this codebase identifies a caller:
// agnostic to +233 / 233 / a leading zero, which is the difference that creates a
// large share of these records in the first place.
const phoneKey = (raw) => {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length < 9) return '';
  const k = d.slice(-9);
  // Placeholders typed in when a customer won't give a number. Grouping on these
  // would merge unrelated strangers.
  if (/^(\d)\1+$/.test(k)) return '';
  if (['123456789', '000000000', '111111111', '277277277', '244242424'].includes(k)) return '';
  return k;
};
const emailKey = (raw) => {
  const e = String(raw || '').trim().toLowerCase();
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return '';
  if (/^(na|n\/a|none|no|nil|test|x|info|admin|reception)@/.test(e)) return '';
  return e;
};
const tokens = (c) => `${c.firstname || ''} ${c.lastname || ''}`
  .toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  .split(' ').filter((t) => t.length >= 2);
const nameKey = (c) => tokens(c).join(' ');
const hasContact = (c) => !!(phoneKey(c.mobile) || emailKey(c.email));

// Edit distance, capped — only ever used on single name tokens.
function within(a, b, max) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = cur;
    }
  }
  return prev[b.length] <= max;
}

// Are these two names the same person? Order-insensitive, because SimpleSpa's firstname
// and lastname fields are filled in whichever way round the person at the desk typed
// them ("Abuba Rayma" and "Rhyma Abuba" are one customer).
function sameName(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return false;
  const [small, big] = A.length <= B.length ? [A, B] : [B, A];
  // Every token of the shorter name must appear in the longer one, exactly or as a
  // near-miss. That accepts a dropped middle name and a one or two letter misspelling,
  // and rejects two people who merely share a surname.
  const used = new Set();
  let fuzzy = 0;
  for (const t of small) {
    let hit = -1;
    for (let i = 0; i < big.length; i++) {
      if (used.has(i)) continue;
      if (big[i] === t) { hit = i; break; }
    }
    if (hit === -1) {
      for (let i = 0; i < big.length; i++) {
        if (used.has(i)) continue;
        // Only fuzzy-match tokens long enough for it to mean something: at 4 letters,
        // an edit distance of 1 turns Mary into Mark.
        if (t.length >= 5 && big[i].length >= 5 && within(t, big[i], 2)) { hit = i; fuzzy++; break; }
      }
    }
    if (hit === -1) return false;
    used.add(hit);
  }
  // A single shared token is a coincidence, not an identity — "Grace" and
  // "Grace Mensah" are not evidence of the same person.
  if (small.length < 2 && big.length >= 2) return false;
  return fuzzy <= 1;
}

// --- grouping -----------------------------------------------------------------
function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].filter(([, v]) => v.length > 1);
}

// A contact shared by several records that were all created together and never used.
// The signature of an import, not of one customer booking repeatedly.
function isBulk(members) {
  if (members.length < 4) return false;
  const byDay = new Map();
  for (const m of members) {
    const d = String(m.created || '').slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  const biggest = Math.max(...byDay.values());
  const noVisits = members.every((m) => !(m.completed_visits > 0));
  return biggest >= 4 && noVisits;
}

// Split a contact-matched set into the sub-groups that are actually the same person.
function splitByName(members) {
  const out = [];
  for (const m of members) {
    const bucket = out.find((g) => g.some((x) => sameName(x, m)));
    if (bucket) bucket.push(m); else out.push([m]);
  }
  return out;
}

// Which record survives a merge: the one carrying the history, since that is the one
// whose loss actually costs something.
const pickKeeper = (rows) => [...rows].sort((a, b) =>
  (b.completed_visits || 0) - (a.completed_visits || 0)
  || (hasContact(b) ? 1 : 0) - (hasContact(a) ? 1 : 0)
  || String(a.created || '').localeCompare(String(b.created || '')))[0];

const brief = (m) => ({
  id: m.client_id,
  name: `${m.firstname || ''} ${m.lastname || ''}`.trim() || '(no name)',
  mobile: m.mobile || '', email: m.email || '',
  visits: m.completed_visits || 0, created: m.created, lastVisit: m.last_visit || '',
});

const report = { generatedFrom: SRC, branches: {}, crossBranch: {}, totals: {} };

for (const [id, branch] of Object.entries(data)) {
  const rows = branch.rows;
  const confirmed = [], review = [], bulk = [];
  const claimed = new Set();

  const consider = (sets, basis) => {
    for (const [key, members] of sets) {
      const fresh = members.filter((m) => !claimed.has(m.client_id));
      if (fresh.length < 2) continue;
      const shownKey = basis === 'email' ? key.replace(/^(.).*(@.*)$/, '$1***$2') : key;

      if (isBulk(fresh)) {
        fresh.forEach((m) => claimed.add(m.client_id));
        bulk.push({ basis, key: shownKey, size: fresh.length,
          createdOn: String(fresh[0].created || '').slice(0, 10), members: fresh.map(brief) });
        continue;
      }

      const byPerson = splitByName(fresh);
      // Sub-groups of 2+ agree on both contact AND name.
      for (const g of byPerson.filter((g) => g.length > 1)) {
        g.forEach((m) => claimed.add(m.client_id));
        const keeper = pickKeeper(g);
        confirmed.push({
          basis, key: shownKey, size: g.length,
          keep: keeper.client_id,
          visitsOnKeeper: keeper.completed_visits || 0,
          visitsOnOthers: g.filter((m) => m.client_id !== keeper.client_id)
            .reduce((s, m) => s + (m.completed_visits || 0), 0),
          members: g.map(brief),
        });
      }
      // Two or more distinct people on one contact: shared handset, family, corporate
      // account — or a genuine duplicate under a changed name. Never auto-merged.
      const singles = byPerson.filter((g) => g.length === 1).flat();
      if (singles.length > 1) {
        singles.forEach((m) => claimed.add(m.client_id));
        review.push({ basis, key: shownKey, size: singles.length,
          visits: singles.reduce((s, m) => s + (m.completed_visits || 0), 0),
          members: singles.map(brief) });
      }
    }
  };

  consider(groupBy(rows, (c) => phoneKey(c.mobile)), 'mobile');
  consider(groupBy(rows, (c) => emailKey(c.email)), 'email');

  // Same name, no shared contact detail at all. Weakest signal in the file — a common
  // Ghanaian name repeats often — so it is counted but never listed as actionable.
  const nameOnly = groupBy(rows.filter((c) => !claimed.has(c.client_id)), (c) => nameKey(c))
    .filter(([, v]) => v.length > 1).length;

  report.branches[id] = {
    name: branch.name,
    clients: rows.length,
    apiTotal: branch.total,
    complete: rows.length === branch.total,
    confirmedSets: confirmed.length,
    confirmedRemovable: confirmed.reduce((s, g) => s + g.size - 1, 0),
    confirmedStrandedVisits: confirmed.reduce((s, g) => s + g.visitsOnOthers, 0),
    confirmedWithHistory: confirmed.filter((g) => g.visitsOnOthers > 0).length,
    reviewSets: review.length,
    reviewRecords: review.reduce((s, g) => s + g.size, 0),
    bulkSets: bulk.length,
    bulkRecords: bulk.reduce((s, g) => s + g.size, 0),
    sameNameNoContact: nameOnly,
    noContactRecords: rows.filter((c) => !hasContact(c)).length,
    neverVisited: rows.filter((c) => !(c.completed_visits > 0)).length,
    confirmed, review, bulk,
  };
}

// --- across branches ----------------------------------------------------------
{
  const seen = new Map();
  for (const [id, branch] of Object.entries(data)) {
    for (const c of branch.rows) {
      const k = phoneKey(c.mobile);
      if (!k) continue;
      if (!seen.has(k)) seen.set(k, new Map());
      seen.get(k).set(id, c);
    }
  }
  // Only count it as one person across branches if the NAMES agree too — otherwise a
  // shared handset at two branches reads as a travelling customer.
  let people = 0; const spread = {};
  for (const [, perBranch] of seen) {
    if (perBranch.size < 2) continue;
    const recs = [...perBranch.values()];
    const agree = recs.every((r) => sameName(r, recs[0]));
    if (!agree) continue;
    people++;
    spread[perBranch.size] = (spread[perBranch.size] || 0) + 1;
  }
  report.crossBranch = {
    peopleAtMoreThanOneBranch: people,
    byBranchCount: spread,
    note: 'Not duplicates. Each branch is a separate SimpleSpa account with its own client list.',
  };
}

const sum = (f) => Object.values(report.branches).reduce((s, b) => s + f(b), 0);
report.totals = {
  clientRecords: sum((b) => b.clients),
  confirmedSets: sum((b) => b.confirmedSets),
  confirmedRemovable: sum((b) => b.confirmedRemovable),
  confirmedStrandedVisits: sum((b) => b.confirmedStrandedVisits),
  confirmedWithHistory: sum((b) => b.confirmedWithHistory),
  reviewSets: sum((b) => b.reviewSets),
  reviewRecords: sum((b) => b.reviewRecords),
  bulkRecords: sum((b) => b.bulkRecords),
  noContactRecords: sum((b) => b.noContactRecords),
};

writeFileSync(join(ROOT, 'data', 'client-duplicates.json'), JSON.stringify(report, null, 2));

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => Number(n).toLocaleString('en-GB');
console.log('\nNiobe — duplicate client records\n');
console.log(pad('Branch', 22) + pad('Clients', 10) + pad('Confirmed', 11) + pad('of those', 10) + pad('Review', 9) + pad('Bulk', 8) + 'No contact');
console.log(pad('', 22) + pad('', 10) + pad('to merge', 11) + pad('w/ history', 10) + pad('by hand', 9) + pad('imports', 8));
for (const b of Object.values(report.branches)) {
  console.log(pad(b.name, 22) + pad(num(b.clients), 10) + pad(num(b.confirmedRemovable), 11)
    + pad(num(b.confirmedWithHistory), 10) + pad(num(b.reviewSets), 9) + pad(num(b.bulkRecords), 8)
    + num(b.noContactRecords) + (b.complete ? '' : '  *** INCOMPLETE PULL ***'));
}
const t = report.totals;
console.log('\n' + pad('TOTAL', 22) + pad(num(t.clientRecords), 10) + pad(num(t.confirmedRemovable), 11)
  + pad(num(t.confirmedWithHistory), 10) + pad(num(t.reviewSets), 9) + pad(num(t.bulkRecords), 8) + num(t.noContactRecords));
console.log(`\nVisit history sitting on records a merge would fold away: ${num(t.confirmedStrandedVisits)}`);
console.log(`Same person at 2+ branches (name agrees too): ${num(report.crossBranch.peopleAtMoreThanOneBranch)} ${JSON.stringify(report.crossBranch.byBranchCount)}`);
console.log('  ^ NOT duplicates. Separate branch accounts. Never merge or delete these.\n');
