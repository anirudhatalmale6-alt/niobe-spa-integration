// Cuts the 8,317-set review pile down to the sets where a human decision
// actually changes an outcome, and orders those by how likely they are to be
// the same person.
//
// The review pile is everything that matched on phone or email but whose names
// did not agree enough for the detector to call it. Verifying all of it by hand
// is thousands of decisions. Most of those decisions are free either way:
//
//   * no member of the set has any visit history -> merging recovers nothing,
//     and getting it wrong destroys nothing. Not worth a minute of anyone's time.
//   * exactly one member has history -> merging recovers nothing either, but a
//     wrong call quietly deletes a real (dormant) customer. Low value, real risk.
//   * two or more members have history -> this is the only tier where the split
//     is costing something AND a mistake is expensive. This is the queue.
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'data/duplicates-needs-review.csv';
const OUT = 'data/review-worklist.csv';
const OUT_LOW = 'data/review-lower-priority.csv';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}

const [head, ...body] = parseCsv(readFileSync(SRC, 'utf8'));
const recs = body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
const n = (s) => Number(s || 0) || 0;
const day = (s) => String(s || '').slice(0, 10);

const sets = new Map();
for (const r of recs) {
  const k = `${r.branch}::${r.set}`;
  if (!sets.has(k)) sets.set(k, []);
  sets.get(k).push(r);
}

// --- name similarity, only used to ORDER the queue, never to decide it -------
const tokens = (s) => String(s || '').toLowerCase()
  .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1);

function dist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Returns a label describing how the two names relate. The label is the whole
// point: "shares surname Attrams" tells a human what to look at, "0.82" does not.
function relate(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return { rank: 4, why: 'one record has no usable name' };
  const setA = new Set(A), setB = new Set(B);
  const shared = A.filter((t) => setB.has(t));
  const sameSet = A.length === B.length && A.every((t) => setB.has(t));
  if (sameSet) return { rank: 0, why: 'same name, words in a different order' };
  if (shared.length && (A.every((t) => setB.has(t)) || B.every((t) => setA.has(t)))) {
    const short = A.length <= B.length ? A : B;
    // Overwhelmingly this is a record entered as a first name only, not a
    // middle name - saying "middle name" would send someone looking for one.
    return short.length === 1
      ? { rank: 0, why: `one record is just the first name "${short[0]}"` }
      : { rank: 0, why: `one name is the other with an extra word (shares ${shared.join(' ')})` };
  }
  const fuzzy = A.filter((t) => t.length >= 5 && !setB.has(t) && B.some((u) => u.length >= 5 && dist(t, u, 1) <= 1));
  if (shared.length >= 1 && fuzzy.length >= 1)
    return { rank: 1, why: `shares ${shared.join(' ')}, likely spelling of ${fuzzy.join(' ')}` };
  if (shared.length >= 1) return { rank: 2, why: `shares only "${shared.join(' ')}"` };
  if (fuzzy.length >= 1) return { rank: 2, why: `close spelling: ${fuzzy.join(' ')}` };
  // Every word close to a word in the other name, none identical: transliterated
  // names (Zaid Salen / Ziad Solem) land here. No single token is a match, so
  // without this they would be filed as "different" on an initials test.
  if (A.length === B.length && A.length >= 2) {
    const pool = [...B];
    const paired = A.every((t) => {
      const i = pool.findIndex((u) => dist(t, u, 2) <= 2);
      if (i < 0) return false;
      pool.splice(i, 1);
      return true;
    });
    if (paired) return { rank: 2, why: 'every word is a close spelling of the other name - possible transliteration' };
  }
  const initials = (x) => x.map((t) => t[0]).sort().join('');
  if (initials(A) === initials(B)) return { rank: 3, why: 'same initials, otherwise different' };
  return { rank: 4, why: 'no part of the names matches' };
}

// Both records last visited on the same day. This does NOT settle the question,
// and it is worth knowing why: it happens when two people come in together on
// one phone number (Johnbull and Stacy Omorefe, 21 Aug 2026), and it happens
// when the desk creates a second record for a returning customer and puts that
// day's visit on the new one. Same evidence, opposite conclusions - so it is
// surfaced as something to look at, and deliberately does not move the row's
// place in the queue.
function sameDayNote(a, b) {
  const da = day(a.last_visit || ''), db = day(b.last_visit || '');
  if (!da || !db || da !== db) return '';
  return `both last visited on ${da} - either two people who came in together, or one visit filed on a new record`;
}

const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function write(path, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  writeFileSync(path, [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n') + '\n');
}

const queue = [], lower = [];
let noHistory = 0;

for (const [, members] of sets) {
  const withVisits = members.filter((m) => n(m.visits) > 0);
  if (!withVisits.length) { noHistory++; continue; }
  const sorted = [...members].sort((a, b) => n(b.visits) - n(a.visits));
  const first = sorted[0];
  for (const other of sorted.slice(1)) {
    const rel = relate(first.name, other.name);
    const row = {
      branch: first.branch,
      // Descriptive, not a verdict. An earlier version labelled ranks 3 and 4
      // "probably different" and Zaid Salen / Ziad Solem sat in it - a label
      // that reads as a decision gets acted on as one.
      order: ['1 - almost certainly one person', '2 - likely one person', '3 - needs a look',
        '4 - only the initials match', '5 - names share nothing'][rel.rank],
      why: rel.why,
      matched_on: first.matched_on,
      shared_value: first.matched_on === 'email' ? (first.email || '') : (first.mobile || ''),
      name_a: first.name, visits_a: first.visits, last_visit_a: day(first.last_visit || ''),
      mobile_a: first.mobile, email_a: first.email, client_id_a: first.client_id,
      name_b: other.name, visits_b: other.visits, last_visit_b: day(other.last_visit || ''),
      mobile_b: other.mobile, email_b: other.email, client_id_b: other.client_id,
      note: sameDayNote(first, other),
      decision: '',
    };
    (n(other.visits) > 0 ? queue : lower).push({ ...row, _rank: rel.rank });
  }
}

const order = (a, b) => a._rank - b._rank
  || (n(b.visits_a) + n(b.visits_b)) - (n(a.visits_a) + n(a.visits_b))
  || a.branch.localeCompare(b.branch);
queue.sort(order); lower.sort(order);
const strip = (r) => { const { _rank, ...rest } = r; return rest; };

write(OUT, queue.map(strip));
write(OUT_LOW, lower.map(strip));

const tally = (rows) => rows.reduce((m, r) => (m[r.order] = (m[r.order] || 0) + 1, m), {});
console.log(`${sets.size} review sets in`);
console.log(`  ${noHistory} have no visit history on any record - not worth verifying either way`);
console.log(`${OUT}: ${queue.length} pairs where BOTH records carry history`);
console.log('  ', tally(queue));
console.log(`${OUT_LOW}: ${lower.length} pairs where only one side has history`);
console.log('  ', tally(lower));
