// Turns duplicates-with-history.csv into a side-by-side worksheet a human can
// actually work through in SimpleSpa, one branch at a time, highest value first.
//
// Two things this adds that the raw export does not:
//   * "check_before_merging" — the suggested KEEP is chosen by visit count, so
//     the OTHER record quite often holds the newer last visit or the only email
//     address. Merging blind loses it. Those rows are flagged.
//   * ordering — branch, then combined visits descending, so stopping halfway
//     still means the valuable ones are done.
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'data/duplicates-with-history.csv';
const OUT = 'data/merge-worksheet.csv';

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

const sets = new Map();
for (const r of recs) {
  if (!sets.has(r.set)) sets.set(r.set, []);
  sets.get(r.set).push(r);
}

const n = (s) => Number(s || 0) || 0;
const day = (s) => String(s || '').slice(0, 10);

const rows = [];
for (const [id, members] of sets) {
  const keep = members.find((m) => m.action === 'KEEP') || members[0];
  const others = members.filter((m) => m !== keep);
  const combined = members.reduce((s, m) => s + n(m.visits), 0);
  for (const o of others) {
    const notes = [];
    // The keeper is picked on visit count alone, so anything the other record
    // holds and the keeper does not has to be copied across by hand.
    if (day(o.last_visit) > day(keep.last_visit)) notes.push('other record has the NEWER last visit');
    if (o.email && !keep.email) notes.push('only the OTHER record has an email address');
    if (o.mobile && !keep.mobile) notes.push('only the OTHER record has a mobile');
    if (n(o.visits) === n(keep.visits)) notes.push('same visit count - either could be the keeper');
    rows.push({
      branch: keep.branch,
      combined_visits: combined,
      matched_on: keep.matched_on,
      keep_name: keep.name, keep_mobile: keep.mobile, keep_email: keep.email,
      keep_visits: keep.visits, keep_last_visit: day(keep.last_visit), keep_client_id: keep.client_id,
      merge_name: o.name, merge_mobile: o.mobile, merge_email: o.email,
      merge_visits: o.visits, merge_last_visit: day(o.last_visit), merge_client_id: o.client_id,
      check_before_merging: notes.join('; '),
      done: '',
      set: id,
    });
  }
}

rows.sort((a, b) =>
  a.branch.localeCompare(b.branch)
  || b.combined_visits - a.combined_visits
  || a.keep_name.localeCompare(b.keep_name));

const cols = Object.keys(rows[0]);
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
writeFileSync(OUT, [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n') + '\n');

const flagged = rows.filter((r) => r.check_before_merging).length;
console.log(`${OUT}: ${rows.length} merges across ${sets.size} sets, ${flagged} flagged for a look first`);
for (const b of [...new Set(rows.map((r) => r.branch))]) {
  console.log(`  ${b}: ${rows.filter((r) => r.branch === b).length}`);
}
