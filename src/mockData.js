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

// A handful of intentional gaps/low-stock so the staff view has something to flag.
const FORCED = {
  'east_legon:MUR-VITC-SERUM': 2,
  'cantonments:ELE-MARINE-CREAM': 0,
  'african_regent:LOR-METAL-DX': 1,
  'hfc_c18:OPI-BIG-APPLE': 0,
  'alisa_hotel:NIO-SCRUB': 3,
};

export function mockBranchProducts(branch) {
  return CATALOGUE.map((item) => {
    const forcedKey = `${branch.id}:${item.sku}`;
    const stock = forcedKey in FORCED ? FORCED[forcedKey] : seeded(branch.id, item.sku) % 26;
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
