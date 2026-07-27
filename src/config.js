import './env.js';

// One entry per Niobe branch. `key` is supplied; `secret` is loaded from .env.
// The SimpleSpa API authenticates as:  Authorization: Bearer <key>:<secret>
export const BRANCHES = [
  { id: 'east_legon',     name: 'East Legon',          key: process.env.EAST_LEGON_KEY,     secret: process.env.EAST_LEGON_SECRET },
  { id: 'cantonments',    name: 'Cantonments',         key: process.env.CANTONMENTS_KEY,    secret: process.env.CANTONMENTS_SECRET },
  { id: 'african_regent', name: 'African Regent Hotel',key: process.env.AFRICAN_REGENT_KEY, secret: process.env.AFRICAN_REGENT_SECRET },
  { id: 'hfc_c18',        name: 'HFC Community 18',     key: process.env.HFC_C18_KEY,        secret: process.env.HFC_C18_SECRET },
  { id: 'alisa_hotel',    name: 'Alisa Hotel Tema',    key: process.env.ALISA_HOTEL_KEY,    secret: process.env.ALISA_HOTEL_SECRET },
];

const bool = (v, d) => (v === undefined ? d : String(v).toLowerCase() === 'true');

export function branchById(id) {
  return BRANCHES.find((b) => b.id === id);
}

export const CONFIG = {
  demoMode: bool(process.env.DEMO_MODE, true),
  base: process.env.SIMPLESPA_BASE || 'https://my.simplespa.com/api/v1',
  port: Number(process.env.PORT || 3000),
  lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD || 2),

  // --- Payments (Paystack) ---
  // paystackDemo = simulate the Paystack checkout locally (no live keys needed yet).
  paystackDemo: bool(process.env.PAYSTACK_DEMO, true),
  paystackSecret: process.env.PAYSTACK_SECRET_KEY || '',
  paystackPublic: process.env.PAYSTACK_PUBLIC_KEY || '',
  currency: process.env.CURRENCY || 'GHS',
  // Deposit rule: minimum 50% or pay in full (same across all services/branches).
  depositMinPercent: Number(process.env.DEPOSIT_MIN_PERCENT || 50),
  // Public base URL of this service (used to build Paystack callback/return links).
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT || 3000)}`,
};
