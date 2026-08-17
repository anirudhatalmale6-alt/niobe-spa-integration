import { BRANCHES, CONFIG } from './config.js';
import { fetchBranchProducts } from './simplespa.js';
import { mockBranchProducts } from './mockData.js';

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
// Group the same product across branches. product_id FIRST: SimpleSpa issues one id per
// product and repeats it at every branch, so it is the real identity.
//
// SKU is not. Two different Elemis products were found sharing barcode 641628007257
// (DYNAMIC RESURFACING GEL MASK and TRI-ENZYME RESURFACING GEL MASK) and two more
// sharing 641628601875 — somebody reused a barcode when adding the replacement product.
// Keyed on SKU those pairs merged into one row: the row kept the first product's name
// and the second product's quantities, so a branch holding 2 of one of them showed 0.
// Fall back to SKU, then name, only for rows with no product_id.
const groupKey = (p) => (p.product_id ? `id:${p.product_id}`
  : (p.sku && p.sku.trim()) ? `sku:${norm(p.sku)}`
  : `name:${norm(p.name)}`);

// Fetch every branch in parallel; never let one failing branch sink the whole view.
async function collect() {
  const results = await Promise.all(BRANCHES.map(async (branch) => {
    try {
      const products = CONFIG.demoMode
        ? mockBranchProducts(branch)
        : await fetchBranchProducts(branch);
      return { branch, products, ok: true };
    } catch (err) {
      return { branch, products: [], ok: false, error: err.message };
    }
  }));
  return results;
}

// Build the consolidated cross-branch catalogue.
export async function getConsolidatedStock() {
  const perBranch = await collect();
  // Stock views read in selling order — the branches that actually move product first,
  // the two hotel sites last — so the Monday cross-check starts where the numbers are.
  const branchStatus = perBranch
    .map(({ branch, ok, error }) => ({
      id: branch.id, name: branch.name, short: branch.short || branch.name,
      stockOrder: branch.stockOrder ?? 99, ok, error: error || null,
    }))
    .sort((a, b) => a.stockOrder - b.stockOrder);

  const map = new Map();
  for (const { branch, products } of perBranch) {
    for (const p of products) {
      const key = groupKey(p);
      if (!map.has(key)) {
        map.set(key, {
          key,
          name: p.name,
          sku: p.sku || '',
          label: p.label || p.category || 'Uncategorised',
          price: Number(p.price) || 0,
          image_url: p.image_url || null,
          byBranch: {},
          total: 0,
        });
      }
      const row = map.get(key);
      // SimpleSpa reports `stock` as a signed integer. A negative value means the branch is
      // OVERSOLD (sales outran recorded inventory) — there is nothing on the shelf to sell, so
      // availability is 0. Keep the raw figure so staff can see/reconcile the oversold amount,
      // but never let a negative count inflate (understate) the sellable total.
      const raw = Math.trunc(Number(p.stock)) || 0;
      // If a branch ever lands two rows on one key, ADD them. Assigning would drop the
      // first while the total still counted it, and a total that disagrees with the
      // columns beside it is exactly what makes people stop trusting a stock sheet.
      const prev = row.byBranch[branch.id];
      const branchRaw = (prev?.raw || 0) + raw;
      row.byBranch[branch.id] = {
        qty: Math.max(0, branchRaw), raw: branchRaw, oversold: branchRaw < 0, product_id: p.product_id,
      };
      row.total += Math.max(0, branchRaw) - (prev?.qty || 0);
      // Prefer a populated image / real price if the first branch lacked it.
      if (!row.image_url && p.image_url) row.image_url = p.image_url;
      if (!row.price && p.price) row.price = Number(p.price);
    }
  }

  const th = CONFIG.lowStockThreshold;
  const products = [...map.values()]
    .map((row) => {
      // Flags are evaluated PER BRANCH — a stockout at one location is what staff need to see.
      // A branch that doesn't carry the item, one that carries it at zero, and one that is
      // oversold (negative) are all "out" for the shopper; oversold is surfaced separately so
      // staff can reconcile inventory.
      const outBranches = branchStatus.filter((b) => (row.byBranch[b.id]?.qty ?? 0) === 0).map((b) => b.name);
      const lowBranches = branchStatus.filter((b) => {
        const q = row.byBranch[b.id]?.qty ?? 0; return q > 0 && q <= th;
      }).map((b) => b.name);
      const oversoldBranches = branchStatus.filter((b) => row.byBranch[b.id]?.oversold).map((b) => b.name);
      return {
        ...row,
        outBranches,
        lowBranches,
        oversoldBranches,
        anyOut: outBranches.length > 0,
        anyLow: lowBranches.length > 0,
        anyOversold: oversoldBranches.length > 0,
        outOfStock: row.total === 0,          // no sellable units at any branch
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    demoMode: CONFIG.demoMode,
    lowStockThreshold: CONFIG.lowStockThreshold,
    branches: branchStatus,
    products,
    summary: {
      distinctProducts: products.length,
      totalUnits: products.reduce((s, p) => s + p.total, 0),
      lowAtBranch: products.filter((p) => p.anyLow).length,
      outAtBranch: products.filter((p) => p.anyOut).length,
      oversoldAtBranch: products.filter((p) => p.anyOversold).length,
    },
  };
}

// ---------------------------------------------------------------------------
// CSV export — a stocktake sheet staff can open in Excel and count against.
// ---------------------------------------------------------------------------

// A cell beginning = + - @ is executed as a formula by Excel/Sheets when the file is
// opened. Product names come from the SimpleSpa dashboard, so a name someone typed as
// "-Elemis sample" would run as one. Prefix those with an apostrophe: Excel shows the
// text and never evaluates it. Numbers we generate ourselves are exempt.
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const csvRow = (cells) => cells.map(csvCell).join(',');

// Reconciliation must show the SIGNED figure. The dashboard shows an oversold branch as
// 0 because nothing is sellable, but a stocktake needs to see "the system thinks -3" —
// that discrepancy is the entire reason someone is counting the shelf.
export function stockCsv(data, { branchId = '', category = '', search = '', availability = '', includeZero = true } = {}) {
  const branch = data.branches.find((b) => b.id === branchId) || null;
  const q = String(search || '').trim().toLowerCase();

  let rows = data.products.filter((p) => {
    if (category && p.label !== category) return false;
    if (availability === 'low' && !p.anyLow) return false;
    if (availability === 'out' && !p.anyOut) return false;
    if (q && !(p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q))) return false;
    return true;
  });

  // A single-branch sheet listing 100 lines of zero for a branch that stocks four items
  // is why people give up on the export, so a branch sheet can drop the lines it does
  // not carry. "Carries none of it" and "carries it, counted zero" are the same row here
  // — SimpleSpa shares one catalogue across branches, so absence is only ever a 0.
  if (branch && !includeZero) rows = rows.filter((p) => (p.byBranch[branch.id]?.raw ?? 0) !== 0);

  const stamp = data.generatedAt;
  const lines = [];

  if (branch) {
    lines.push(csvRow([`Niobe Beauty — stock take — ${branch.name}`]));
    lines.push(csvRow([`Generated ${stamp} · figures are live from SimpleSpa at that moment`]));
    lines.push(csvRow(['Fill in the Counted column from the shelf; Difference = Counted minus System qty.']));
    lines.push('');
    lines.push(csvRow(['SKU', 'Product', 'Category', 'Unit price (GHS)', 'System qty', 'Stock value (GHS)', 'Counted', 'Difference', 'Notes']));
    let units = 0;
    let value = 0;
    for (const p of rows) {
      const raw = p.byBranch[branch.id]?.raw ?? 0;
      units += raw;
      value += raw * (Number(p.price) || 0);
      lines.push(csvRow([
        p.sku || '', p.name, p.label,
        (Number(p.price) || 0).toFixed(2),
        raw,
        (raw * (Number(p.price) || 0)).toFixed(2),
        '', '',
        raw < 0 ? `OVERSOLD by ${-raw} — system has sold more than it recorded receiving` : '',
      ]));
    }
    lines.push('');
    lines.push(csvRow(['', `TOTAL — ${rows.length} products`, '', '', units, value.toFixed(2), '', '', '']));
  } else {
    lines.push(csvRow(['Niobe Beauty — stock, all branches']));
    lines.push(csvRow([`Generated ${stamp} · figures are live from SimpleSpa at that moment`]));
    // The columns are headed the way the branches say them, so spell them out once here
    // rather than leave anyone guessing what AR or C18 refers to.
    lines.push(csvRow([`Branch columns: ${data.branches.map((b) => (b.short === b.name ? b.name : `${b.short} = ${b.name}`)).join(' · ')}`]));
    lines.push('');
    lines.push(csvRow([
      'SKU', 'Product', 'Category', 'Unit price (GHS)',
      ...data.branches.map((b) => b.short),
      'Total units', 'Total value (GHS)',
    ]));
    for (const p of rows) {
      const price = Number(p.price) || 0;
      const per = data.branches.map((b) => p.byBranch[b.id]?.raw ?? 0);
      const total = per.reduce((s, n) => s + n, 0);
      lines.push(csvRow([p.sku || '', p.name, p.label, price.toFixed(2), ...per, total, (total * price).toFixed(2)]));
    }
  }

  // A branch that failed to answer contributes zeros that look exactly like real zeros,
  // so say so in the file itself — the person reconciling may never see the dashboard.
  const down = data.branches.filter((b) => !b.ok);
  if (down.length) {
    lines.push('');
    lines.push(csvRow([`WARNING: no data from ${down.map((b) => `${b.name} (${b.error || 'unavailable'})`).join('; ')} — their figures below/above read as 0 but are UNKNOWN.`]));
  }

  // BOM so Excel reads it as UTF-8, CRLF because that is what Excel writes.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function stockCsvFilename(data, branchId) {
  const branch = data.branches.find((b) => b.id === branchId);
  const day = data.generatedAt.slice(0, 10);
  return `niobe-stock-${branch ? branch.id : 'all-branches'}-${day}.csv`;
}
