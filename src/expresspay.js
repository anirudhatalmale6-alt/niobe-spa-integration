import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CONFIG, branchById, branchByRefCode } from './config.js';

// expressPay adapter — Ghana cards + mobile money. Same interface as the other adapters
// so it drops straight into the gateway selector as Hubtel's backup.
//   docs: https://expresspaygh.com  (submit.php -> checkout.php -> query.php)
//
// Flow: submit.php returns a `token`; the customer is sent to checkout.php?token=…; the
// payment is later confirmed with query.php (expressPay callbacks are unsigned, so the
// query is the source of truth). query.php needs the token, so we keep reference->token.
const tokens = new Map(); // our reference (order-id) -> expressPay token

// The token is the ONLY handle query.php accepts, so losing it means a customer who
// really paid can never be verified or auto-confirmed. Held in memory the map died
// on every restart/deploy, so it is mirrored to disk the moment a token is issued.
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const TOKENS_FILE = join(DATA_DIR, 'expresspay-tokens.json');
const TOKEN_RETENTION_MS = 30 * 86400000;

function saveTokens() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TOKENS_FILE, JSON.stringify(Object.fromEntries(tokens)));
  } catch { /* never let bookkeeping break a checkout */ }
}
function loadTokens() {
  try {
    const raw = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
    const cutoff = Date.now() - TOKEN_RETENTION_MS;
    for (const [ref, t] of Object.entries(raw || {})) {
      const rec = typeof t === 'string' ? { token: t, at: Date.now() } : t;
      if (!rec?.token || (rec.at && rec.at < cutoff)) continue;
      tokens.set(ref, rec);
    }
  } catch { /* first run, or unreadable — start empty */ }
}
function rememberToken(reference, token) {
  if (!reference || !token) return;
  const existing = tokens.get(reference);
  if (existing?.token === token) return;
  tokens.set(reference, { token, at: Date.now() });
  saveTokens();
}
function tokenFor(reference) {
  const rec = tokens.get(reference);
  return typeof rec === 'string' ? rec : rec?.token;
}
loadTokens();

// expressPay's browser return carries order-id + token; record it so verification
// still works even if this process never saw the checkout that created it.
export function noteReturn(reference, token) { rememberToken(reference, token); }

export const displayName = 'expressPay';

function form(params) {
  return new URLSearchParams(params).toString();
}

// Which expressPay account collects this payment. Mirrors the Hubtel router: a fully
// configured branch settles into itself, anything else uses the central OGV account.
// initiate knows the branch from metadata, the query only has the reference, so it
// recovers the branch from the code the reference carries (NIOBE-<BR4>-…). Both paths
// MUST land on the same account — a payment taken by a branch but queried against the
// central account reads back as unknown, and the booking would never auto-confirm.
function routeFor({ branchId, reference }) {
  const branch = branchId
    ? branchById(branchId)
    : branchByRefCode(String(reference || '').split('-')[1]);
  if (branch?.expresspayMerchantId && branch.expresspayApiKey) {
    return { merchantId: branch.expresspayMerchantId, apiKey: branch.expresspayApiKey };
  }
  return { merchantId: CONFIG.expresspayMerchantId, apiKey: CONFIG.expresspayApiKey };
}

// expressPay authenticates on the api-key ALONE and ignores the merchant-id we send.
// Proven live 2026-08-16: East Legon's merchant-id posted with Community 18's key came
// back status 1 "Success" naming Community 18, and the reverse pair named East Legon.
// So a single mis-paired line in .env silently settles a branch's takings into another
// branch's bank account, with no error anywhere to notice it by. The response does say
// which account it actually used, so check it and refuse the checkout if it is not ours.
function assertSettlesWhereAddressed(json, route) {
  const actual = String(json['merchantservice-srvrtid'] || '');
  if (!actual || actual === String(route.merchantId)) return; // absent = nothing to check
  throw new Error(
    `expressPay credential mismatch: addressed merchant ${route.merchantId} but the key ` +
    `belongs to ${actual} (${json['merchant-name'] || 'unknown'}). Money would settle into ` +
    `the wrong branch — fix the *_EXPRESSPAY_MERCHANT_ID / *_EXPRESSPAY_API_KEY pair.`,
  );
}

export async function initializeTransaction({ email, amount, reference, metadata, callbackUrl }) {
  if (CONFIG.paymentDemo) {
    rememberToken(reference, `demo-${reference}`);
    const url = `${CONFIG.publicUrl}/demo/checkout?reference=${encodeURIComponent(reference)}`;
    return { authorization_url: url, reference, demo: true };
  }

  // Real booking + sandbox endpoint is the one combination that must never run: the
  // customer completes a test checkout, pays nothing, and the booking confirms anyway.
  // EXPRESSPAY_BASE defaults to sandbox, so an unset .env is enough to cause it.
  // Deliberate sandbox testing sets EXPRESSPAY_ALLOW_SANDBOX=true; forgetting to
  // configure the live endpoint does not, which is the whole point of the opt-in.
  if (/sandbox/i.test(CONFIG.expresspayBase) && !CONFIG.expresspayAllowSandbox) {
    throw new Error('expressPay is pointed at the sandbox — refusing to take a real payment. Set EXPRESSPAY_BASE=https://expresspaygh.com/api');
  }

  const route = routeFor({ branchId: metadata?.branchId });
  const [firstname, ...rest] = String(metadata?.customerName || 'Niobe Customer').split(' ');
  const res = await fetch(`${CONFIG.expresspayBase}/submit.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      'merchant-id': route.merchantId,
      'api-key': route.apiKey,
      'firstname': firstname,
      'lastname': rest.join(' ') || '-',
      'email': email,
      'phonenumber': metadata?.customerPhone || '',
      'amount': Number(amount).toFixed(2),
      'order-id': reference,
      'currency': CONFIG.currency,
      'redirect-url': callbackUrl,
      'post-url': `${CONFIG.publicUrl}/webhook/payment`,
    }),
  });
  const json = await res.json();
  if (Number(json.status) !== 1 || !json.token) {
    throw new Error(json['result-text'] || json.message || 'expressPay submit failed');
  }
  assertSettlesWhereAddressed(json, route);
  rememberToken(reference, json.token);
  return { authorization_url: `${CONFIG.expresspayBase}/checkout.php?token=${encodeURIComponent(json.token)}`, reference };
}

// Confirm via query.php (source of truth). result === 1 means approved/paid.
export async function verifyTransaction(reference) {
  if (CONFIG.paymentDemo) {
    return { success: true, reference, amount: null, demo: true };
  }
  const token = tokenFor(reference);
  if (!token) return { success: false, reference, amount: null, error: 'no token for reference' };
  const route = routeFor({ reference });
  const res = await fetch(`${CONFIG.expresspayBase}/query.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ 'merchant-id': route.merchantId, 'api-key': route.apiKey, token }),
  });
  const json = await res.json();
  const resultText = String(json['result-text'] || '').toLowerCase();
  return {
    success: Number(json.result) === 1 || resultText.includes('approved') || resultText.includes('success'),
    reference: json['order-id'] || reference,
    amount: json.amount != null ? Number(json.amount) : null,
    raw: json,
  };
}

// expressPay does not sign webhooks; verifyTransaction (query.php) is the real gate.
export function verifyWebhookSignature() {
  return true;
}

// expressPay posts back the token + order-id (form-encoded) when payment completes.
export function parseWebhookEvent(rawBody) {
  let data = {};
  try { data = JSON.parse(rawBody || '{}'); } catch { data = Object.fromEntries(new URLSearchParams(rawBody || '')); }
  const reference = data['order-id'] || data.orderId;
  const token = data.token;
  if (reference && token) rememberToken(reference, token); // ensure verify can find the token
  return { reference, isPaymentSuccess: Boolean(reference) };
}
