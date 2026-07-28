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

  // --- Payments ---
  // Primary gateway: 'hubtel' (recommended for Ghana), 'expresspay' or 'paystack'.
  // The deposit/auto-confirm flow is gateway-independent — only the adapter changes.
  gateway: (process.env.PAYMENT_GATEWAY || 'hubtel').toLowerCase(),
  // Backup gateway offered to the customer / used for automatic failover if the primary
  // is unreachable. Set to '' to disable the backup option.
  gatewayBackup: (process.env.PAYMENT_GATEWAY_BACKUP ?? 'expresspay').toLowerCase(),
  // paymentDemo = simulate the checkout locally (no live keys needed yet).
  // Falls back to the old PAYSTACK_DEMO flag for backward compatibility.
  paymentDemo: bool(process.env.PAYMENT_DEMO ?? process.env.PAYSTACK_DEMO, true),
  // In Ghana the customer bears the transaction fee — set at the gateway account level
  // (fee-bearer = customer), so the provider adds its exact fee on top of the deposit.
  customerPaysFees: bool(process.env.CUSTOMER_PAYS_FEES, true),

  // Paystack credentials
  paystackSecret: process.env.PAYSTACK_SECRET_KEY || '',
  paystackPublic: process.env.PAYSTACK_PUBLIC_KEY || '',

  // Hubtel credentials (from the Hubtel dashboard -> API keys)
  hubtelClientId: process.env.HUBTEL_CLIENT_ID || '',
  hubtelClientSecret: process.env.HUBTEL_CLIENT_SECRET || '',
  hubtelMerchantAccount: process.env.HUBTEL_MERCHANT_ACCOUNT || '',

  // expressPay credentials (from the expressPay merchant dashboard)
  expresspayMerchantId: process.env.EXPRESSPAY_MERCHANT_ID || '',
  expresspayApiKey: process.env.EXPRESSPAY_API_KEY || '',
  // sandbox for test, https://expresspaygh.com/api for live
  expresspayBase: process.env.EXPRESSPAY_BASE || 'https://sandbox.expresspaygh.com/api',

  // International rail (Option A) — foreign card charge in this currency, settled to the UK account.
  intlCurrency: (process.env.INTL_CURRENCY || 'GBP').toUpperCase(),
  // Buffer % applied to the FX-converted charge so conversion/rate movement doesn't leave a shortfall.
  fxBufferPct: Number(process.env.FX_BUFFER_PCT ?? 3),
  stripeUkSecret: process.env.STRIPE_UK_SECRET || '',

  currency: process.env.CURRENCY || 'GHS',
  // Deposit rule: minimum 50% or pay in full (same across all services/branches).
  depositMinPercent: Number(process.env.DEPOSIT_MIN_PERCENT || 50),
  // Public base URL of this service (used to build Paystack callback/return links).
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT || 3000)}`,
};
