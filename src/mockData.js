// Demo catalogue mirroring the SimpleSpa products.php response shape.
// Used only while DEMO_MODE=true (before live API secrets are supplied).
// Stock varies per branch deterministically so screenshots are stable.

const CATALOGUE = [
  { sku: 'ELE-PRO-CLEANSE', name: 'Elemis Pro-Collagen Cleansing Balm', label: 'Skincare', price: 480 },
  { sku: 'ELE-MARINE-CREAM', name: 'Elemis Pro-Collagen Marine Cream', label: 'Skincare', price: 720 },
  { sku: 'MUR-VITC-SERUM',  name: 'Murad Vita-C Glycolic Serum', label: 'Skincare', price: 650 },
  { sku: 'MUR-CLARIFY',     name: 'Murad Clarifying Cleanser', label: 'Skincare', price: 310 },
  { sku: 'LOR-ABSOLUT-SH',  name: "L'Oréal Pro Absolut Repair Shampoo 300ml", label: 'Hair Care', price: 190 },
  { sku: 'LOR-ABSOLUT-MK',  name: "L'Oréal Pro Absolut Repair Mask 250ml", label: 'Hair Care', price: 240 },
  { sku: 'LOR-METAL-DX',    name: "L'Oréal Pro Metal Detox Shampoo", label: 'Hair Care', price: 210 },
  { sku: 'OPI-INF-BASE',    name: 'OPI Infinite Shine Base Coat', label: 'Nails', price: 120 },
  { sku: 'OPI-INF-TOP',     name: 'OPI Infinite Shine Top Coat', label: 'Nails', price: 120 },
  { sku: 'OPI-BIG-APPLE',   name: 'OPI Nail Lacquer — Big Apple Red', label: 'Nails', price: 95 },
  { sku: 'OPI-BUBBLE',      name: 'OPI Nail Lacquer — Bubble Bath', label: 'Nails', price: 95 },
  { sku: 'NIO-BODY-OIL',    name: 'Niobe Signature Lavender Body Oil', label: 'Body', price: 150 },
  { sku: 'NIO-SCRUB',       name: 'Niobe Shea & Coffee Body Scrub', label: 'Body', price: 130 },
  { sku: 'NIO-GIFT-100',    name: 'Niobe Gift Card GHS100', label: 'Gift Cards', price: 100 },
];

// Small deterministic hash so each branch/product pair yields a stable qty.
function seeded(branchId, sku) {
  let h = 2166136261;
  const s = `${branchId}:${sku}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

// A handful of intentional gaps so the staff view has something to flag.
// Niobe stock a max of ~3 units per product (limited shelf space), so demo qtys stay 0–3.
const FORCED = {
  'cantonments:ELE-MARINE-CREAM': 0,
  'hfc_c18:OPI-BIG-APPLE': 0,
  'african_regent:MUR-CLARIFY': 0,
  'east_legon:MUR-VITC-SERUM': 1,
  'alisa_hotel:NIO-SCRUB': 1,
};

// --- Demo data for the unified availability feed (DEMO_MODE=true) ---------
const DEMO_SERVICES = [
  { name: 'Swedish Massage (60 min)', duration_minutes: 60, price: 400 },
  { name: 'Deep Tissue Massage (60 min)', duration_minutes: 60, price: 450 },
  { name: 'Classic Facial (45 min)', duration_minutes: 45, price: 300 },
  { name: 'Manicure & Pedicure', duration_minutes: 75, price: 250 },
];
const DEMO_BRANCHES = [
  { id: 'east_legon', name: 'East Legon' },
  { id: 'cantonments', name: 'Cantonments' },
  { id: 'african_regent', name: 'African Regent Hotel' },
  { id: 'hfc_c18', name: 'HFC Community 18' },
  { id: 'alisa_hotel', name: 'Alisa Hotel Tema' },
];

// Deterministic pseudo-open-slots so demo screenshots are stable.
function demoSlots(branchId, date, duration) {
  const base = seeded(branchId, date) % 3; // small per-branch offset
  const times = ['09:00', '10:30', '12:00', '13:30', '15:00', '16:30'];
  return times
    .filter((_, i) => (seeded(branchId, date + i) % 4) !== 0) // punch a few holes
    .slice(base, base + 5)
    .map((time) => ({ time, staffCount: 1 + (seeded(branchId, time) % 3), staff: ['Ama', 'Efua', 'Yaa'].slice(0, 1 + (seeded(branchId, time) % 3)) }));
}

export function mockAvailabilityData({ serviceName, date, branchId, list } = {}) {
  if (list) return DEMO_SERVICES.map((s) => ({ ...s, branches: DEMO_BRANCHES.length }));
  const svc = DEMO_SERVICES.find((s) => s.name.toLowerCase() === String(serviceName || '').toLowerCase()) || DEMO_SERVICES[0];
  const targets = branchId ? DEMO_BRANCHES.filter((b) => b.id === branchId) : DEMO_BRANCHES;
  const branches = targets.map((b, i) => {
    const offered = i !== DEMO_BRANCHES.length - 1; // last branch doesn't offer it, to show the "not offered" state
    return {
      id: b.id, name: b.name, ok: true, offered,
      service: offered ? { name: svc.name, duration_minutes: svc.duration_minutes, price: svc.price } : undefined,
      staffOnShift: offered ? 2 + (seeded(b.id, date) % 3) : 0,
      slots: offered ? demoSlots(b.id, date, svc.duration_minutes) : [],
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    demoMode: true,
    query: { serviceName: svc.name, date, branchId: branchId || null },
    dayOfWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][(new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7],
    branches,
    summary: {
      branchesOffering: branches.filter((b) => b.offered).length,
      totalOpenSlots: branches.reduce((s, b) => s + b.slots.length, 0),
    },
  };
}

export function mockBranchProducts(branch) {
  return CATALOGUE.map((item) => {
    const forcedKey = `${branch.id}:${item.sku}`;
    // Gift cards are unlimited; everything else is 0–3 to match real shelf capacity.
    const base = item.label === 'Gift Cards' ? (seeded(branch.id, item.sku) % 3) + 1 : seeded(branch.id, item.sku) % 4;
    const stock = forcedKey in FORCED ? FORCED[forcedKey] : base;
    return {
      product_id: `${branch.id}-${item.sku}`,
      name: item.name,
      sku: item.sku,
      stock,
      price: item.price,
      special_price: null,
      tax: 0,
      unlimited: item.label === 'Gift Cards',
      label: item.label,
      label_id: item.label,
      image_url: null,
    };
  });
}
