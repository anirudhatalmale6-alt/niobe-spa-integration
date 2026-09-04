import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CONFIG } from './config.js';

// Niobe's OWN gift-card package list — what the buyer picks from when WE are the issuer.
//
// Today the packages on the checkout are read live out of GiftUp's dashboard. That is the
// one thing that cannot survive going independent: if the list lives in GiftUp's account,
// the account has to stay open and paid for, and "managed solely by us" is not true. So
// this module is the replacement, and it deliberately answers in the SAME shape
// giftup.js's getCatalog() answers — { groups, items, customItemId } — so the page that
// renders it and the code that prices a selection need no changes at all. Which issuer is
// in use becomes a one-line choice in giftcards.js instead of a rewrite.
//
// The list is a JSON file rather than code, because it is a price list. It changes when
// Niobe changes a treatment price, and that must never require me to deploy.

const DATA_DIR = process.env.NIOBE_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = process.env.GIFTCARD_PACKAGES_FILE || join(DATA_DIR, 'gift-packages.json');

// The fallback if no file has been supplied yet. Amounts ONLY — deliberately no invented
// treatment names. I do not know Niobe's package list (it is in a GiftUp dashboard I have
// no login for), and a plausible-looking guess is worse than an honest gap: a wrong
// treatment name on a voucher is something a customer turns up to a branch and claims.
// Round amounts are safe to guess because they are not a claim about anything.
const DEFAULT_ITEMS = [
  { name: 'GHS 200 gift card', value: 200 },
  { name: 'GHS 300 gift card', value: 300 },
  { name: 'GHS 500 gift card', value: 500 },
  { name: 'GHS 1,000 gift card', value: 1000 },
];

// A package id has to outlive an edit to the list. If ids were array positions, deleting
// the second package would silently re-point every card ever sold against the third one,
// and the sales report would rewrite its own history. So the id is derived from the name
// and is stable as long as the name is.
const slug = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60);

const money = (n) => Math.round(Number(n) * 100) / 100;

// Read the file, or fall back. Never throws: a malformed price list must not take the
// checkout down, it must take ITSELF down and say so loudly in the log.
function readFile() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    if (Array.isArray(raw)) return { groups: [], items: raw };
    if (raw && typeof raw === 'object') {
      return { groups: Array.isArray(raw.groups) ? raw.groups : [], items: Array.isArray(raw.items) ? raw.items : [] };
    }
    console.log(`[packages] WARNING ${FILE} is not a list or an object — using the built-in amounts.`);
    return null;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.log(`[packages] WARNING could not read ${FILE} (${e.message}) — using the built-in amounts.`);
    }
    return null;
  }
}

// THE RULE THIS FUNCTION EXISTS FOR: a package with no usable price is DROPPED, never
// defaulted. An entry whose price is missing, blank, zero or unparseable is somebody
// halfway through editing the list — and the cost of guessing is not a display bug, it is
// a gift card the buyer is charged nothing for and which is then worth GHS 0 at the till.
// Both sides of that are real money, so the entry is refused and named in the log.
function usable(raw, index) {
  const name = String(raw?.name || '').trim();
  if (!name) {
    console.log(`[packages] DROPPED entry ${index + 1}: it has no name.`);
    return null;
  }
  // `?? ` and not `||`: a price of 0 must reach the check below and be REJECTED there by
  // name, not fall through to `amount` and be reported as a missing field.
  const value = money(raw.value ?? raw.amount ?? raw.price);
  if (!Number.isFinite(value) || value <= 0) {
    console.log(`[packages] DROPPED "${name}": its price is ${JSON.stringify(raw.value ?? raw.amount ?? raw.price)}.`
      + ' A package with no price would sell a card worth nothing, so it is not offered.');
    return null;
  }
  if (value < CONFIG.giftCardMinAmount || value > CONFIG.giftCardMaxAmount) {
    console.log(`[packages] DROPPED "${name}": GHS ${value} is outside the permitted`
      + ` GHS ${CONFIG.giftCardMinAmount}–${CONFIG.giftCardMaxAmount} range.`);
    return null;
  }
  return {
    id: String(raw.id || '').trim() || slug(name),
    name,
    value,
    // What the BUYER pays for this package, if it differs from the face value — a package
    // sold at a discount. Null means "the same as the value", which is the normal case.
    // Priced later by priceGiftPurchase; kept here only so the list can express it.
    price: Number.isFinite(Number(raw.price)) && Number(raw.price) > 0 && raw.price !== raw.value
      ? money(raw.price) : null,
    groupId: String(raw.groupId || raw.group || '').trim() || null,
  };
}

// Cached only so an unchanged file is not re-read and re-validated on every page load.
// Short, because the whole point of a file is that Niobe can edit it and see the change.
let cache = { at: 0, data: null };
const TTL_MS = Number(process.env.GIFTCARD_PACKAGES_TTL_MS || 30_000);

export function getOwnCatalog({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;

  const file = readFile();
  const rawItems = file?.items?.length ? file.items : DEFAULT_ITEMS;
  const usingDefaults = !file?.items?.length;

  const items = rawItems.map(usable).filter(Boolean);

  // Two packages sharing an id is one package as far as every lookup is concerned, and the
  // loser is unsellable in a way nobody can see from the list. Say which one won.
  const seen = new Map();
  const unique = [];
  for (const it of items) {
    if (seen.has(it.id)) {
      console.log(`[packages] DROPPED "${it.name}": its id "${it.id}" is already used by "${seen.get(it.id)}".`
        + ' Give one of them an explicit "id".');
      continue;
    }
    seen.set(it.id, it.name);
    unique.push(it);
  }

  // Only groups that actually have a package in them. An empty category renders as an
  // empty heading on the checkout, which reads as something failing to load.
  const used = new Set(unique.map((i) => i.groupId).filter(Boolean));
  const groups = (file?.groups || [])
    .map((g) => ({ id: String(g.id || slug(g.name)).trim(), name: String(g.name || '').trim() }))
    .filter((g) => g.id && g.name && used.has(g.id));

  if (usingDefaults) {
    console.log(`[packages] no package list at ${FILE} — offering the built-in amounts only`
      + ` (${unique.length}). Drop Niobe's real list in there to replace them.`);
  }

  // customItemId is GiftUp's mechanism for making a free-amount card inherit an item's
  // design and terms. We have no such indirection — a custom amount is simply an amount —
  // so it is null, and resolveSelection's custom-amount branch needs no item at all.
  const data = { groups, items: unique, customItemId: null, source: usingDefaults ? 'default' : 'file' };
  cache = { at: Date.now(), data };
  return data;
}

export function findOwnItem(catalog, itemId) {
  return (catalog?.items || []).find((i) => i.id === itemId) || null;
}

export const _fileForTests = FILE;
