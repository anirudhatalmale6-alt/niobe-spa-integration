import './env.js';

// One entry per Niobe branch. Each branch has a single SimpleSpa API key.
// The SimpleSpa API authenticates as:  Authorization: Bearer <key>
// Read vs write is governed by the key's Mode (3 = Read + Write) in the dashboard —
// there is no separate secret.
export const BRANCHES = [
  { id: 'east_legon',     name: 'East Legon',          key: process.env.EAST_LEGON_KEY },
  { id: 'cantonments',    name: 'Cantonments',         key: process.env.CANTONMENTS_KEY },
  { id: 'african_regent', name: 'African Regent Hotel',key: process.env.AFRICAN_REGENT_KEY },
  { id: 'hfc_c18',        name: 'HFC Community 18',     key: process.env.HFC_C18_KEY },
  { id: 'alisa_hotel',    name: 'Alisa Hotel Tema',    key: process.env.ALISA_HOTEL_KEY },
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
  // Granularity (minutes) of the computed booking-availability grid.
  slotGranularity: Number(process.env.SLOT_GRANULARITY || 15),

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

  // GiftUp gift-card rail — redeem a GiftUp gift card against a booking instead of a cash deposit.
  // Key is a Bearer JWT from the GiftUp dashboard; kept server-side only (never in git).
  giftupKey: process.env.GIFTUP_API_KEY || '',
  giftupTestMode: bool(process.env.GIFTUP_TEST_MODE, false),
  // Online gift-card sales (issued via GiftUp). Amounts are in GHS (the GiftUp store currency).
  giftCardMinAmount: Number(process.env.GIFTCARD_MIN || 100),
  giftCardMaxAmount: Number(process.env.GIFTCARD_MAX || 10000),
  giftCardValidityDays: Number(process.env.GIFTCARD_VALIDITY_DAYS || 90),
  // Customer-facing service fee added to a gift-card purchase (covers GiftUp's commission +
  // card processing) — mirrors the surcharge on the GiftUp storefront. The card is worth its
  // face value; the buyer pays value x (1 + this%). Set to 0 to disable.
  giftCardSurchargePct: Number(process.env.GIFTCARD_SURCHARGE_PCT ?? 5),

  currency: process.env.CURRENCY || 'GHS',
  // Deposit rule: minimum 50% or pay in full (same across all services/branches).
  depositMinPercent: Number(process.env.DEPOSIT_MIN_PERCENT || 50),

  // --- Secure-or-release (no-show) engine (holds.js / hours.js) ---
  // Master switch for the periodic release sweep. Off by default so the engine
  // never runs until Niobe explicitly arms it.
  releaseEnabled: bool(process.env.RELEASE_ENABLED, false),
  // DRY_RUN (default ON): report what WOULD be released, write nothing to
  // SimpleSpa. Set RELEASE_DRY_RUN=false only after Niobe has watched the
  // dry-run candidates on their live data and signed off.
  releaseDryRun: bool(process.env.RELEASE_DRY_RUN, true),
  // Which unsecured holds are in scope for auto-release:
  //   'tracked' (default) — only holds our booking funnel has seen; a walk-in
  //                         or phone booking created straight in SimpleSpa is
  //                         never touched.
  //   'all'     — additionally release ANY unsecured New/Rebooked past deadline
  //               (fuller loophole closure; pair with the front-desk policy of
  //               taking payment / confirming their own bookings).
  releaseScope: (process.env.RELEASE_SCOPE || 'tracked').toLowerCase(),
  // Grace window (minutes) before an unsecured hold is released.
  releaseGraceMinutes: Number(process.env.RELEASE_GRACE_MINUTES || 60),
  // How often the sweep runs (ms).
  releaseSweepMs: Number(process.env.RELEASE_SWEEP_MS || 5 * 60 * 1000),
  // Public base URL of this service (used to build Paystack callback/return links).
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT || 3000)}`,
};
