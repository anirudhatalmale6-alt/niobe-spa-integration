// Is each branch actually taking money right now?
//
// Written to settle a specific question: Hubtel reported collection account 2021439
// (Cantonments) last active 01 Aug 2025, while the other four branch accounts showed
// today. That is either a dead account on a trading branch, or a branch that has gone
// quiet. Those two have completely different consequences, and the Hubtel dates cannot
// tell them apart — only the till can.
//
// READ ONLY. transactions.php with a date window; nothing is written anywhere.
import { BRANCHES } from '../src/config.js';
import { ssPost } from '../src/simplespa.js';

const DAYS = Number(process.argv[2] || 30);
const end = new Date();
const start = new Date(end.getTime() - DAYS * 86400000);
const iso = (d) => d.toISOString().slice(0, 10);

console.log(`\nTill activity per branch, ${iso(start)} to ${iso(end)} (${DAYS} days)\n`);

for (const branch of BRANCHES) {
  if (!branch.key) { console.log(`${branch.name.padEnd(22)} no API key configured here`); continue; }
  try {
    const rows = [];
    for (let page = 1; page <= 20; page++) {
      const data = await ssPost(branch, 'transactions.php', { start: iso(start), end: iso(end), page, per_page: 1000 });
      const items = data.transactions || Object.values(data).find(Array.isArray) || [];
      rows.push(...items);
      const total = data.total_results ?? rows.length;
      if (rows.length >= total || items.length === 0) break;
    }
    // Sum the money, not the row count: a branch can log many zero-value lines.
    const money = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const last = rows.map((r) => String(r.timestamp || '')).sort().pop() || '';
    console.log(
      `${branch.name.padEnd(22)} ${String(rows.length).padStart(5)} transactions   ` +
      `GHS ${money.toFixed(2).padStart(12)}   last ${last.slice(0, 16) || 'none in window'}`
    );
  } catch (e) {
    // A branch that failed to answer is UNKNOWN, not zero — say so rather than
    // letting a blank line read as "this branch sold nothing".
    console.log(`${branch.name.padEnd(22)} QUERY FAILED - ${e.message} (activity unknown, not zero)`);
  }
}
console.log('');
