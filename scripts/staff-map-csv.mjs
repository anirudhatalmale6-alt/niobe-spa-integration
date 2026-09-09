#!/usr/bin/env node
// The staff list as a SPREADSHEET, so Niobe can edit it without touching JSON.
//
//   node scripts/staff-map-csv.mjs --export              -> data/staff-map.csv
//   node scripts/staff-map-csv.mjs --import data/staff-map.csv          (checks only)
//   node scripts/staff-map-csv.mjs --import data/staff-map.csv --write  (saves it)
//
// Niobe, 8 Sep 2026: "How do I save the staff map to enable editing?" — and separately,
// "we are in the process of ensuring all staff names tally at all branches and commission is
// accurate for next month". That second job is exactly this file: one row per therapist, her
// rate, and every spelling of her name that any branch is actually using.
//
// JSON was the wrong thing to hand him. It is the right storage format and a terrible editing
// format for anyone who is not a programmer: one missing comma and the file stops parsing,
// with no clue which line. A spreadsheet cannot be broken that way, and he already has Excel.
//
// The export pulls the CURRENT staff names live from all five branches, so the sheet shows
// which branch spells each person which way. That turns "make the names tally" from an
// exercise in memory into one of reading a column.
//
// Importing NEVER overwrites without --write, and refuses outright on any error. This file
// decides who gets paid; a half-valid import is worse than no import.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_FILE = process.env.STAFF_MAP_FILE || join(ROOT, 'data', 'staff-map.json');
const CSV_FILE = join(ROOT, 'data', 'staff-map.csv');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valAfter = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// A CSV parser rather than split(',') — an alias list is comma-separated and therefore lives
// inside quotes, and splitting on commas would tear it apart into fragments that each look
// like a real column. Excel writes quotes correctly; the reader has to honour them.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const HEAD = ['Therapist', 'Commission %', 'Still employed?', 'Left on (YYYY-MM-DD)',
  'Other spellings seen (comma separated)', 'Currently in SimpleSpa as', 'Branches'];

// --- live names, so the sheet reflects reality rather than the map's memory of it ---
async function liveStaffNames() {
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
  process.env.DEMO_MODE = 'false';
  const { BRANCHES } = await import('../src/config.js');
  const { ssPost } = await import('../src/simplespa.js');
  const byName = new Map();   // normalised -> { display, branches:Set }
  const failed = [];
  for (const b of BRANCHES) {
    if (!b.key) { failed.push(`${b.name} (no key)`); continue; }
    try {
      const r = await ssPost(b, 'staff.php', { per_page: 500 });
      for (const s of (r.data || r.staff || [])) {
        const display = `${s.firstname || ''} ${s.lastname || ''}`.replace(/\s+/g, ' ').trim();
        if (!display) continue;
        const k = norm(display);
        if (!byName.has(k)) byName.set(k, { display, branches: new Set() });
        byName.get(k).branches.add(b.short || b.name);
      }
    } catch (e) { failed.push(`${b.name} (${e.message})`); }
  }
  return { byName, failed };
}

// --- export -----------------------------------------------------------------
if (has('--export') || !argv.length) {
  const raw = JSON.parse(readFileSync(JSON_FILE, 'utf8'));
  const live = has('--no-live') ? { byName: new Map(), failed: [] } : await liveStaffNames();
  if (live.failed.length) {
    // Say it rather than producing a sheet whose "Currently in SimpleSpa as" column is
    // blank for a whole branch — blank would read as "she is not there any more".
    console.log(`WARNING could not read: ${live.failed.join(', ')}`);
    console.log('The SimpleSpa columns are incomplete. Fix that before using this to tidy names.');
  }

  const out = [HEAD.map(esc).join(',')];
  const claimed = new Set();
  for (const p of (raw.people || []).sort((a, b) => a.name.localeCompare(b.name))) {
    const keys = [norm(p.name), ...(p.aliases || []).map(norm)];
    keys.forEach((k) => claimed.add(k));
    const hits = keys.map((k) => live.byName.get(k)).filter(Boolean);
    const spellings = [...new Set(hits.map((h) => h.display))];
    const branches = [...new Set(hits.flatMap((h) => [...h.branches]))];
    out.push([
      p.name,
      p.commissionPct ?? '',
      p.former ? 'No' : 'Yes',
      p.leftOn || '',
      (p.aliases || []).join(', '),
      spellings.join(' / ') || (live.byName.size ? 'not found in SimpleSpa' : ''),
      branches.join(', '),
    ].map(esc).join(','));
  }

  // Anyone SimpleSpa knows about who is on no row of the map. These are the new starters
  // that would otherwise turn up as "unrecognised" on a payroll — the point of the exercise
  // Niobe is doing this month, so the sheet may as well hand him the list.
  // The house and front-desk logins are deliberately ignored, and must NOT appear under a
  // heading that says "add a row for anyone real" — that invites somebody to put a till
  // account on the payroll. They get their own block, stating that they are already handled.
  const excluded = new Set((raw.exclude || []).map(norm));
  const missing = [...live.byName.entries()].filter(([k]) => !claimed.has(k) && !excluded.has(k));
  const ignored = [...live.byName.entries()].filter(([k]) => excluded.has(k));

  if (missing.length) {
    out.push('');
    out.push(esc('NEW — in SimpleSpa but not on the payroll. Fill in a name and a commission % for anyone real.'));
    for (const [, v] of missing.sort((a, b) => a[1].display.localeCompare(b[1].display))) {
      out.push(['', '', '', '', '', v.display, [...v.branches].join(', ')].map(esc).join(','));
    }
  }
  if (ignored.length) {
    out.push('');
    out.push(esc('IGNORED ON PURPOSE — house and front-desk logins, not people. Nothing to do; listed so you can see they were not forgotten.'));
    for (const [, v] of ignored.sort((a, b) => a[1].display.localeCompare(b[1].display))) {
      out.push(['', '', '', '', '', v.display, [...v.branches].join(', ')].map(esc).join(','));
    }
  }

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(CSV_FILE, '﻿' + out.join('\r\n') + '\r\n');
  console.log(`Wrote ${CSV_FILE}`);
  console.log(`${(raw.people || []).length} therapist(s).${missing.length ? ` ${missing.length} NEW in SimpleSpa and not on the payroll — see the bottom of the file.` : ''}`);
  if (ignored.length) console.log(`${ignored.length} house/front-desk login(s) ignored on purpose.`);
  process.exit(0);
}

// --- import -----------------------------------------------------------------
if (has('--import')) {
  const file = valAfter('--import');
  if (!file || !existsSync(file)) { console.error(`Cannot read ${file}`); process.exit(1); }
  const rows = parseCsv(readFileSync(file, 'utf8'));
  if (!rows.length) { console.error('That file has no rows.'); process.exit(1); }

  const head = rows[0].map((h) => norm(h));
  const col = (want) => head.findIndex((h) => h.startsWith(norm(want)));
  const iName = col('therapist'), iPct = col('commission'), iEmp = col('still employed'),
    iLeft = col('left on'), iAlias = col('other spellings');
  if (iName < 0) { console.error('No "Therapist" column — is this the exported sheet?'); process.exit(1); }

  const errors = [], warnings = [], people = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = String(row[iName] || '').replace(/\s+/g, ' ').trim();
    // The "not on the list" block at the bottom has no name in the Therapist column. Skipping
    // it is correct — those are suggestions, and a suggestion must not become a payee just
    // because it was in the file.
    if (!name) continue;
    if (/^(NEW —|NEW -|IGNORED ON PURPOSE|NOT ON THE LIST)/i.test(name)) continue;

    const pctRaw = String(row[iPct] ?? '').trim();
    let pct = null;
    if (pctRaw !== '') {
      pct = Number(pctRaw.replace('%', ''));
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        errors.push(`Row ${r + 1} (${name}): commission "${pctRaw}" is not a percentage between 0 and 100.`);
      }
    } else {
      // Not an error — the house default can cover it — but it is worth saying, because an
      // empty rate is indistinguishable on the sheet from a rate of zero.
      warnings.push(`Row ${r + 1} (${name}): no commission % — she will use the house default, or be reported as having no rate.`);
    }

    const employed = norm(row[iEmp] ?? 'yes');
    const former = ['no', 'n', 'left', 'former', 'false'].includes(employed);
    const leftOn = String(row[iLeft] || '').trim();
    if (leftOn && !/^\d{4}-\d{2}-\d{2}$/.test(leftOn)) {
      errors.push(`Row ${r + 1} (${name}): "Left on" must be YYYY-MM-DD, got "${leftOn}".`);
    }
    if (former && !leftOn) {
      warnings.push(`Row ${r + 1} (${name}): marked as left with no date — her work still gets reported separately, but nothing can check for bookings made after she left.`);
    }

    const aliases = String(row[iAlias] || '').split(',').map(norm).filter(Boolean);
    people.push({ name, commissionPct: pct, aliases, former, leftOn: leftOn || null, row: r + 1 });
  }

  if (!people.length) errors.push('No therapists found in that file.');

  // THE CHECK THAT MATTERS. Two people sharing a name or an alias means one lookup key with
  // two owners, and the later entry silently wins — so one therapist is paid for another's
  // work and nothing on the payroll looks wrong.
  const owner = new Map();
  for (const p of people) {
    for (const k of [norm(p.name), ...p.aliases]) {
      if (owner.has(k) && owner.get(k).name !== p.name) {
        errors.push(`"${k}" is claimed by BOTH "${owner.get(k).name}" (row ${owner.get(k).row}) and "${p.name}" (row ${p.row}). One name cannot belong to two people — whoever comes second would be paid for the other's work.`);
      } else owner.set(k, p);
    }
  }

  console.log(`${people.length} therapist(s) read from ${file}.`);
  for (const w of warnings) console.log(`  note: ${w}`);
  if (errors.length) {
    console.log(`\n${errors.length} problem(s) — NOTHING has been saved:`);
    for (const e of errors) console.log(`  ${e}`);
    process.exit(2);
  }
  console.log('No problems found.');

  if (!has('--write')) {
    console.log('\nChecked only. Re-run with --write to save it.');
    process.exit(0);
  }

  const existing = existsSync(JSON_FILE) ? JSON.parse(readFileSync(JSON_FILE, 'utf8')) : {};
  const next = {
    ...existing,
    people: people.map((p) => ({
      name: p.name,
      aliases: p.aliases,
      ...(p.commissionPct == null ? {} : { commissionPct: p.commissionPct }),
      ...(p.former ? { former: true } : {}),
      ...(p.leftOn ? { leftOn: p.leftOn } : {}),
    })),
  };
  if (existsSync(JSON_FILE)) {
    renameSync(JSON_FILE, `${JSON_FILE}.bak`);
    console.log(`Previous list kept as ${JSON_FILE}.bak`);
  }
  writeFileSync(JSON_FILE, JSON.stringify(next, null, 1));
  console.log(`Wrote ${JSON_FILE} — ${next.people.length} therapist(s).`);
  console.log('Re-run the payroll report to see it applied.');
  process.exit(0);
}

console.log('Usage:');
console.log('  node scripts/staff-map-csv.mjs --export');
console.log('  node scripts/staff-map-csv.mjs --import data/staff-map.csv [--write]');
