import { BRANCHES, CONFIG } from './config.js';
import { fetchBranchProducts } from './simplespa.js';
import { mockBranchProducts } from './mockData.js';

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
// Group products across branches by SKU when present, else by normalised name.
const groupKey = (p) => (p.sku && p.sku.trim()) ? `sku:${norm(p.sku)}` : `name:${norm(p.name)}`;

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
  const branchStatus = perBranch.map(({ branch, ok, error }) => ({
    id: branch.id, name: branch.name, ok, error: error || null,
  }));

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
      const qty = Math.max(0, raw);
      row.byBranch[branch.id] = { qty, raw, oversold: raw < 0, product_id: p.product_id };
      row.total += qty;
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
