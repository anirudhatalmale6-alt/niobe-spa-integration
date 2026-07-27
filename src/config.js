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

export const CONFIG = {
  demoMode: String(process.env.DEMO_MODE ?? 'true').toLowerCase() === 'true',
  base: process.env.SIMPLESPA_BASE || 'https://my.simplespa.com/api/v1',
  port: Number(process.env.PORT || 3000),
  lowStockThreshold: Number(process.env.LOW_STOCK_THRESHOLD || 5),
};
