import './env.js';

// One entry per Niobe branch. Each branch has a single SimpleSpa API key.
// The SimpleSpa API authenticates as:  Authorization: Bearer <key>
// Read vs write is governed by the key's Mode (3 = Read + Write) in the dashboard —
// there is no separate secret.
const boolEarly = (v, d) => (v === undefined ? d : String(v).toLowerCase() === 'true');

// Standard Niobe week (GMT): Mon–Fri 09:00–18:00, Sat 08:30–18:00, Sun 12:30–18:00.
const STD_WEEK = {
  0: { open: '12:30', close: '18:00' },
  1: { open: '09:00', close: '18:00' }, 2: { open: '09:00', close: '18:00' },
  3: { open: '09:00', close: '18:00' }, 4: { open: '09:00', close: '18:00' },
  5: { open: '09:00', close: '18:00' }, 6: { open: '08:30', close: '18:00' },
};
// The Alisa Hotel and African Regent branches close on Sundays (unless opened on
// request). Flip HOTEL_SUNDAY_OPEN=true to open them Sundays without a code change.
const HOTEL_WEEK = { ...STD_WEEK, 0: boolEarly(process.env.HOTEL_SUNDAY_OPEN, false) ? STD_WEEK[0] : null };

// hubtelAccount = that branch's OWN Hubtel merchant account number, so an online
// deposit settles straight into the branch that will deliver the treatment
// instead of pooling in the central online account. Leave a branch's value unset
// and it falls back to HUBTEL_MERCHANT_ACCOUNT (the central OGV account), which
// is exactly today's behaviour — so this is inert until the numbers are filled in.
export const BRANCHES = [
  { id: 'east_legon',     name: 'East Legon',          key: process.env.EAST_LEGON_KEY,     hours: STD_WEEK,   hubtelAccount: process.env.EAST_LEGON_HUBTEL_ACCOUNT || '' },
  { id: 'cantonments',    name: 'Cantonments',         key: process.env.CANTONMENTS_KEY,    hours: STD_WEEK,   hubtelAccount: process.env.CANTONMENTS_HUBTEL_ACCOUNT || '' },
  { id: 'african_regent', name: 'African Regent Hotel',key: process.env.AFRICAN_REGENT_KEY, hours: HOTEL_WEEK, hubtelAccount: process.env.AFRICAN_REGENT_HUBTEL_ACCOUNT || '' },
  { id: 'hfc_c18',        name: 'HFC Community 18',     key: process.env.HFC_C18_KEY,        hours: STD_WEEK,   hubtelAccount: process.env.HFC_C18_HUBTEL_ACCOUNT || '' },
  { id: 'alisa_hotel',    name: 'Alisa Hotel Tema',    key: process.env.ALISA_HOTEL_KEY,    hours: HOTEL_WEEK, hubtelAccount: process.env.ALISA_HOTEL_HUBTEL_ACCOUNT || '' },
];

// The 4-char branch code embedded in a payment reference (NIOBE-<BR4>-<stamp>).
// Kept here so the reference builder and the reference parser can never drift.
export const branchRefCode = (id) => String(id || '').replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase();

// Recover the branch from a reference's code. Returns undefined for non-branch
// references (e.g. gift cards, NIOBE-GC-...), which correctly fall back to central.
export function branchByRefCode(code) {
  const c = String(code || '').toUpperCase();
  return c ? BRANCHES.find((b) => branchRefCode(b.id) === c) : undefined;
}

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
  // Grace window (minutes) before an unsecured ONLINE hold (one our booking
  // funnel created) is released — the no-show loophole timer: pay within the hour.
  releaseGraceMinutes: Number(process.env.RELEASE_GRACE_MINUTES || 60),
  // Separate, more generous window (counted in BUSINESS minutes) for untracked /
  // existing bookings swept under scope='all'. These are the "front desk calls to
  // confirm; anything still unallocated by Monday is cancelled" population, so
  // they get time across opening hours (weekends roll forward) rather than the
  // tight online timer. Default ≈ one full business day of calls.
  releaseUntrackedGraceMinutes: Number(process.env.RELEASE_UNTRACKED_GRACE_MINUTES || 540),
  // How often the sweep runs (ms).
  releaseSweepMs: Number(process.env.RELEASE_SWEEP_MS || 5 * 60 * 1000),
  // Where branch opening hours come from for the release-deadline maths:
  //   'simplespa' (default) — derive from each branch's rostered staff schedule,
  //                so a hotel branch opened on a Sunday in SimpleSpa opens here
  //                automatically (no separate toggle). Falls back to static hours
  //                if a branch has no roster / the read fails.
  //   'config'   — use the static per-branch hours only.
  hoursSource: (process.env.HOURS_SOURCE || 'simplespa').toLowerCase(),
  derivedHoursTtlMs: Number(process.env.DERIVED_HOURS_TTL_MS || 30 * 60 * 1000),

  // --- Notifications (deposit-link email/SMS) ---
  // Email via Microsoft Graph (app-only) as the client's M365 mailbox.
  notifyEmailEnabled: bool(process.env.NOTIFY_EMAIL_ENABLED, false),
  notifyEmailFrom: process.env.NOTIFY_EMAIL_FROM || process.env.NOTIFY_EMAIL || '',
  graphTenantId: process.env.GRAPH_TENANT_ID || '',
  graphClientId: process.env.GRAPH_CLIENT_ID || '',
  graphClientSecret: process.env.GRAPH_CLIENT_SECRET || '',
  // SMS via Hubtel. The SMS/Messaging API key is SEPARATE from the checkout key,
  // so use its own client id/secret; fall back to the checkout key only if unset.
  notifySmsEnabled: bool(process.env.NOTIFY_SMS_ENABLED, false),
  hubtelSmsSender: process.env.HUBTEL_SMS_SENDER || 'Niobe',
  hubtelSmsClientId: process.env.HUBTEL_SMS_CLIENT_ID || process.env.HUBTEL_CLIENT_ID || '',
  hubtelSmsClientSecret: process.env.HUBTEL_SMS_CLIENT_SECRET || process.env.HUBTEL_CLIENT_SECRET || '',
  // Auto-send the deposit link + a pre-release reminder from the sweep. OFF by
  // default so nothing is sent to real clients during the report-only period; it
  // is turned on together with the live go-live.
  notifyAutosendEnabled: bool(process.env.NOTIFY_AUTOSEND_ENABLED, false),
  // Only auto-notify bookings created within this many minutes, so switching
  // auto-send on never back-blasts old existing bookings — just genuinely new ones.
  notifyFreshMinutes: Number(process.env.NOTIFY_FRESH_MINUTES || 180),
  // Send the "secure it soon" reminder when a within-grace hold is this many
  // minutes from its release deadline.
  reminderLeadMinutes: Number(process.env.REMINDER_LEAD_MINUTES || 15),
  // Public base URL of this service (used to build Paystack callback/return links).
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT || 3000)}`,

  // --- Per-branch front-desk view (holds.js / server.js /desk routes) ---
  // The per-branch read-only holds view is only reachable during office hours so
  // it can't be opened on personal phones after hours. Window is in Ghana local
  // time (= GMT/UTC year-round). Default 08:00–19:00 (8am–7pm). The all-branch
  // central monitor view (/holds.html) is NOT time-restricted.
  deskOpenMinute: Number(process.env.DESK_OPEN_HOUR ?? 8) * 60,
  deskCloseMinute: Number(process.env.DESK_CLOSE_HOUR ?? 19) * 60,
};
