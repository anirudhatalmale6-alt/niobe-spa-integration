// Build the gift-card package list from SimpleSpa, so the prices on the checkout are the same
// prices the branches charge and nobody has to retype them.
//
// Niobe, 4 Sep 2026: "will send the real package list with prices, but that is available from
// SimpleSpa if we could hook it up". It is, and this is the hook-up.
//
//   node scripts/sync-packages.mjs                 # show what it would write, write nothing
//   node scripts/sync-packages.mjs --write         # write data/gift-packages.json
//   node scripts/sync-packages.mjs --top 12        # rank by what actually SELLS, keep the top 12
//   node scripts/sync-packages.mjs --write --only "FACIAL,MASSAGE"   # just these
//   node scripts/sync-packages.mjs --write --min 200 --max 1500
//
// --top is the one worth using. SimpleSpa lists 264 priced treatments, which is a staff menu,
// not a gift menu — nobody buying a present wants to scroll past "Acrylic Dissolve". Ranking by
// the last 180 days of till receipts picks the shortlist from evidence instead of taste, the
// same way the voucher designs are ordered by how often each was actually chosen.
//
// READ ONLY against SimpleSpa: it calls services.php and nothing else. Nothing it does can
// change a booking, a price or a client record.
//
// It never writes the file the server is reading without being told to. A sync that silently
// republishes a price list is a sync that can silently reprice every gift card on the site the
// next time somebody edits a treatment in SimpleSpa.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// Load .env the same way the service does, so this script talks to the same five branches
// with the same keys and cannot accidentally read a different environment's prices.
const ENV = join(ROOT, '.env');
if (existsSync(ENV)) {
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
// Demo mode would hand back mock services and this would cheerfully write them to the real
// price list. Whatever the .env says, a sync reads the live API or it does not run.
process.env.DEMO_MODE = 'false';

const { BRANCHES } = await import('../src/config.js');
const { ssPost } = await import('../src/simplespa.js');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const WRITE = has('--write');
const MIN = Number(val('--min', 0));
const MAX = Number(val('--max', Infinity));
const TOP = Number(val('--top', 0));
const DAYS = Number(val('--days', 180));
const ONLY = String(val('--only', '')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const OUT = process.env.GIFTCARD_PACKAGES_FILE || join(ROOT, 'data', 'gift-packages.json');

const money = (n) => Math.round(Number(n) * 100) / 100;

// Match a till receipt to a treatment. SimpleSpa's transaction descriptions are free text and
// drift from the service names in three ways that all split one treatment's sales into two
// rows: a stray double space, an HTML-escaped ampersand, and an internal booking note glued
// onto the name. Left alone, "ELEMIS FREESTYLE  DEEP TISSUE MASSAGE" (1,550 sales) and
// "ELEMIS FREESTYLE DEEP TISSUE MASSAGE" (223) rank as two mediocre treatments instead of one
// of the best-sellers in the business.
const matchKey = (s) => String(s || '')
  .replace(/&amp;/gi, '&')
  .replace(/\s*\(100%\s*DEPOSIT\s*REQUIRED\s*TO\s*BOOK\)?/ig, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toUpperCase();

// Things that are on a till receipt but are not a treatment anybody would gift.
const NOT_A_GIFT = [
  /^CREDIT$/, /DISSOLVE/, /^TIDY/, /DELIVERY CHARGE/, /^DEPOSIT/, /^REFUND/, /^BALANCE/,
  // Waxing sells well and is a perfectly good service; it is not what a present looks like.
  /WAX(ING)?$/, /^UNDERARM/, /^CHIN\b/, /^UPPER LIP/, /^BIKINI/, /^BRAZILIAN/,
  // Niobe may disagree with any line here — it is a judgement about what reads as a
  // present, not a fact about the business. Edit the list, or edit the file it writes.
];

// --- pull -------------------------------------------------------------------
const perBranch = {};
for (const b of BRANCHES) {
  if (!b.key) { console.log(`  ${b.name}: no API key configured — skipped`); continue; }
  try {
    const r = await ssPost(b, 'services.php', { per_page: 1000 });
    const list = r.data || r.services || (Array.isArray(r) ? r : []);
    perBranch[b.id] = list.map((s) => ({
      name: String(s.name || '').trim(),
      price: Number(s.price) || 0,
      mins: Number(s.duration_minutes) || 0,
    }));
    console.log(`  ${b.name}: ${list.length} services`);
  } catch (e) {
    // A branch that did not answer is not a branch with no services. Writing a price list
    // assembled from four branches out of five, as though it were complete, is how a treatment
    // quietly disappears from the checkout.
    console.log(`  ${b.name}: ERROR ${e.message}`);
    console.log('\nRefusing to build a package list from an incomplete pull. Nothing written.');
    process.exit(1);
  }
}
const ids = Object.keys(perBranch);
if (!ids.length) { console.log('\nNo branch answered. Nothing written.'); process.exit(1); }

// --- do the branches agree? -------------------------------------------------
// A gift card is not tied to a branch — it is bought online and redeemed wherever the holder
// walks in. So a treatment priced differently at different branches has no single correct
// price here, and the only safe choice is the HIGHEST: a card that covers the dearest branch
// covers all of them, and the holder is never short at the desk. Under-price it and the
// customer is asked for a top-up on a present, which is the complaint we are avoiding.
// Clean the name ONCE, here, and carry the clean one everywhere afterwards. SimpleSpa's names
// are staff-facing: block capitals, HTML-escaped ampersands, stray double spaces, and internal
// booking instructions glued on the end. "(100% DEPOSIT REQUIRED TO BOOK)" is an instruction to
// a receptionist; on a gift checkout it reads as a condition attached to the present.
//
// The double space is not cosmetic. "ELEMIS FREESTYLE  DEEP TISSUE MASSAGE" at GHS 400 and
// "ELEMIS FREESTYLE DEEP TISSUE MASSAGE" at GHS 520 are one treatment at two lengths, stored
// under what look like two different names. Without collapsing it they come out as two
// unrelated packages a buyer cannot tell apart - and the same split hides 1,550 of that
// treatment's 1,773 sales from any report that groups by name.
const clean = (s) => String(s || '')
  .replace(/&amp;/gi, '&')
  .replace(/\s*\(\s*100%\s*DEPOSIT\s*REQUIRED\s*TO\s*BOOK\s*\)?/ig, '')
  .replace(/\s+/g, ' ')
  .trim();

const key = (s) => clean(s.name).toUpperCase() + '|' + s.mins;
const prices = new Map();          // clean name + duration -> { name, mins, byBranch: {} }
for (const [bid, list] of Object.entries(perBranch)) {
  for (const s of list) {
    if (!clean(s.name)) continue;
    if (!prices.has(key(s))) prices.set(key(s), { name: clean(s.name), mins: s.mins, byBranch: {} });
    prices.get(key(s)).byBranch[bid] = s.price;
  }
}
const disagreements = [];
for (const rec of prices.values()) {
  const vals = [...new Set(Object.values(rec.byBranch))];
  if (vals.length > 1) disagreements.push({ ...rec, vals });
}
if (disagreements.length) {
  console.log(`\n${disagreements.length} treatment(s) priced differently between branches — taking the highest:`);
  for (const d of disagreements.slice(0, 20)) {
    console.log(`  ${d.name} (${d.mins}m): ${Object.entries(d.byBranch).map(([b, p]) => `${b}=${p}`).join(' ')}`);
  }
}

// --- the same name at two lengths -------------------------------------------
// Five treatments are listed twice per branch under ONE name at TWO durations and two prices
// (the ELEMIS massages at 60 and 90 minutes, and eyebrow threading). On a dropdown that is two
// identical-looking lines at different prices, and in the package file both would slugify to
// the same id — so one would be dropped and the customer would silently lose the option.
// Naming the duration fixes the label and the id in one go, and only where it is needed:
// putting "(60 min)" on all 261 would be noise on the 256 that have only one length.
const byName = new Map();
for (const rec of prices.values()) {
  const k = rec.name.toUpperCase();
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(rec);
}

// --- build ------------------------------------------------------------------
const dropped = [];
const items = [];
for (const [, recs] of byName) {
  const name = recs[0].name;              // the cleaned name, not the upper-cased map key
  const needsDuration = recs.length > 1;
  for (const rec of recs) {
    const price = money(Math.max(...Object.values(rec.byBranch)));
    if (!(price > 0)) { dropped.push(`${name} — no price set in SimpleSpa`); continue; }
    if (price < MIN || price > MAX) { dropped.push(`${name} — GHS ${price} outside --min/--max`); continue; }
    if (ONLY.length && !ONLY.some((k) => name.toUpperCase().includes(k))) continue;
    items.push({
      name: needsDuration && rec.mins ? `${titleCase(name)} (${rec.mins} min)` : titleCase(name),
      value: price,
    });
  }
}
items.sort((a, b) => a.name.localeCompare(b.name));

// --- rank by what actually sells --------------------------------------------
if (TOP > 0) {
  const end = new Date();
  const start = new Date(Date.now() - DAYS * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const sold = new Map();
  let rows = 0;
  console.log(`\nReading ${DAYS} days of till receipts to rank them…`);
  for (const b of BRANCHES) {
    if (!b.key) continue;
    for (let page = 1; page <= 30; page++) {
      let d;
      try { d = await ssPost(b, 'transactions.php', { start: iso(start), end: iso(end), page, per_page: 1000 }); }
      catch (e) { console.log(`  ${b.name}: ERROR ${e.message} — ranking without it`); break; }
      const list = d.data || d.transactions || (Array.isArray(d) ? d : []);
      if (!list.length) break;
      rows += list.length;
      for (const t of list) {
        const k = matchKey(t.description);
        if (!k) continue;
        sold.set(k, (sold.get(k) || 0) + (Number(t.qty) || 1));
      }
      if (list.length < 1000) break;
    }
  }
  console.log(`  ${rows.toLocaleString()} receipts, ${sold.size.toLocaleString()} distinct descriptions.`);

  // A treatment nobody bought in six months is not evidence of anything, so it sorts to the
  // bottom rather than being silently dropped — the list is still complete, just ordered.
  for (const it of items) it.sold = sold.get(matchKey(stripDuration(it.name))) || 0;
  const giftable = items.filter((it) => !NOT_A_GIFT.some((re) => re.test(matchKey(stripDuration(it.name)))));

  // Rank TREATMENTS, not rows. A treatment offered at 60 and 90 minutes is one thing a buyer
  // recognises and one line on the shortlist — ranking the rows would spend two of twelve slots
  // on it, and print the treatment's whole sales figure twice as though each length had sold
  // that many. Both lengths are still offered; they just share a place in the ranking.
  const byTreatment = new Map();
  for (const it of giftable) {
    const t = matchKey(stripDuration(it.name));
    if (!byTreatment.has(t)) byTreatment.set(t, { sold: it.sold, rows: [] });
    byTreatment.get(t).rows.push(it);
  }
  const ranked = [...byTreatment.values()].sort((a, b) =>
    b.sold - a.sold || a.rows[0].name.localeCompare(b.rows[0].name));

  const keptGroups = ranked.slice(0, TOP);
  const kept = keptGroups.flatMap((g) => g.rows.sort((a, b) => a.value - b.value));
  console.log(`\nTop ${keptGroups.length} treatments by units sold in ${DAYS} days:`);
  for (const g of keptGroups) {
    const label = g.rows.length > 1
      ? `${stripDuration(g.rows[0].name)} — ${g.rows.map((r) => `GHS ${r.value}`).join(' / ')}`
      : `${g.rows[0].name} — GHS ${g.rows[0].value}`;
    console.log(`  ${String(g.sold).padStart(5)}  ${label}`);
  }
  const cut = ranked.length - keptGroups.length;
  // Never let a cap look like completeness. If 240 treatments were left out, say 240.
  if (cut > 0) console.log(`\n  (${cut} other giftable treatments not included, plus ${items.length - giftable.length} rows filtered as not gift material)`);

  items.length = 0;
  items.push(...kept.map(({ name, value }) => ({ name, value })));
}

// The duration suffix is ours, added for the dropdown — it is not in SimpleSpa's data, so it
// has to come off again before matching a name against a till receipt.
function stripDuration(n) { return n.replace(/\s*\(\d+\s*min\)$/i, ''); }

// SimpleSpa stores names in block capitals. Shouting a treatment name at a customer who is
// buying a present reads as an invoice, not a gift, so they are cased for display — with the
// brand names left alone, because "Elemis" and "Opi" are how those are written.
function titleCase(s) {
  // Brand and technique names are written this way and are not words to be re-cased.
  const keep = { ELEMIS: 'ELEMIS', OPI: 'OPI', LED: 'LED', IPL: 'IPL', RF: 'RF', CACI: 'CACI' };
  // Real title case, not word-by-word capitals: "Head, Back and Neck Massage", not "And Neck".
  // Never the first word, which is capitalised whatever it is.
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
  let first = true;
  return s.toLowerCase().replace(/\b[\w']+\b/g, (w) => {
    const up = w.toUpperCase();
    const wasFirst = first; first = false;
    if (keep[up]) return keep[up];
    if (!wasFirst && small.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
}

console.log(`\n${items.length} package(s) built from ${prices.size} treatment listings.`);
if (dropped.length) {
  console.log(`${dropped.length} not offered:`);
  for (const d of dropped.slice(0, 20)) console.log(`  ${d}`);
}

// A 261-line dropdown is not a gift-buying experience; it is a price list. Say so rather than
// writing it and letting the checkout become unusable without anyone deciding that it should.
if (items.length > 40 && !ONLY.length) {
  console.log(`\nNOTE: ${items.length} packages is far too many for a gift-card dropdown. Narrow it with`);
  console.log('      --only "FACIAL,MASSAGE" or --min/--max, or hand-edit the file afterwards.');
  console.log('      A buyer choosing a present wants a short list of good options, not a menu.');
}

if (!WRITE) {
  console.log('\nDry run — nothing written. Re-run with --write to save.');
  console.log(`Would write: ${OUT}`);
  console.log('\nFirst 10:');
  for (const i of items.slice(0, 10)) console.log(`  ${i.name} — GHS ${i.value}`);
  process.exit(0);
}

// Keep the previous list. This file IS the price list the checkout sells from, and a sync that
// overwrites it with something worse should be one `mv` away from being undone.
if (existsSync(OUT)) {
  renameSync(OUT, `${OUT}.bak`);
  console.log(`\nPrevious list kept as ${OUT}.bak`);
}
writeFileSync(OUT, JSON.stringify({ items }, null, 1));
console.log(`Wrote ${items.length} packages to ${OUT}`);
console.log('The server re-reads it within 30 seconds; no restart needed.');
