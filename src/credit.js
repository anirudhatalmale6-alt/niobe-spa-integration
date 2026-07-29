import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Clients who pay from Niobe account credit (or a gift card) and therefore must NOT be
// asked for an online deposit. Their appointment is confirmed MANUALLY by staff — this
// list only SUPPRESSES the deposit request, it never auto-confirms anything. It is a
// controlled allow-list so an ordinary client can't skip payment by claiming credit:
// only numbers Niobe adds here are exempt; everyone else still pays as normal.
//
// Two sources, merged (both matched on the LAST 9 DIGITS so +233 / a leading zero / spaces
// don't matter):
//   1. CREDIT_CLIENTS env var    — comma-separated numbers (good for a fixed handful)
//   2. data/credit-clients.json  — a JSON array of numbers, editable on the server with no
//                                  redeploy (kept out of git; it is customer PII)
const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'credit-clients.json');

const last9 = (s) => String(s || '').replace(/\D/g, '').slice(-9);

const envSet = new Set(
  String(process.env.CREDIT_CLIENTS || '').split(',').map(last9).filter(Boolean),
);

// The file is re-read at most every 15s, so staff edits take effect without a restart
// while we still avoid hitting disk on every request.
let fileCache = { at: 0, set: new Set() };
const FILE_TTL_MS = 15 * 1000;
function fileSet() {
  if (Date.now() - fileCache.at < FILE_TTL_MS) return fileCache.set;
  let set = new Set();
  try {
    const arr = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(arr)) set = new Set(arr.map(last9).filter(Boolean));
  } catch { /* file absent or malformed => empty allow-list (everyone pays) */ }
  fileCache = { at: Date.now(), set };
  return set;
}

export function isCreditClient(phone) {
  const p = last9(phone);
  if (!p) return false;
  return envSet.has(p) || fileSet().has(p);
}
