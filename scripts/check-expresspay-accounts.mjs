#!/usr/bin/env node
// Prove every branch's expressPay credentials reach that branch's OWN account.
//
//   node scripts/check-expresspay-accounts.mjs
//
// Run this after adding or rotating any *_EXPRESSPAY_* value, and after any move
// between sandbox and live. It must be run FROM THE PRODUCTION SERVER: expressPay
// allowlists live calls by IP, so from anywhere else every branch fails identically
// and the run tells you nothing.
//
// Why this exists: expressPay authenticates on the api-key alone and ignores the
// merchant-id in the request. A merchant-id paired with a different branch's key is
// accepted with status 1 "Success" and settles into the key's owner — a branch's
// takings land in another branch's bank account and nothing anywhere reports it.
// The response names the account actually used, so this compares that against the
// account we addressed, per branch.
//
// It calls submit.php, which only opens an unpaid checkout session (GHS 1, expires
// unused). No money moves and no customer is involved.
import { BRANCHES, CONFIG } from '../src/config.js';

const rows = BRANCHES
  .filter((b) => b.expresspayMerchantId && b.expresspayApiKey)
  .map((b) => ({ label: b.name, merchantId: b.expresspayMerchantId, apiKey: b.expresspayApiKey }));

if (CONFIG.expresspayMerchantId && CONFIG.expresspayApiKey) {
  rows.push({ label: 'central (fallback)', merchantId: CONFIG.expresspayMerchantId, apiKey: CONFIG.expresspayApiKey });
}

if (!rows.length) {
  console.error('No expressPay credentials configured — nothing to check.');
  process.exit(2);
}

const unconfigured = BRANCHES.filter((b) => !(b.expresspayMerchantId && b.expresspayApiKey));

async function check({ label, merchantId, apiKey }) {
  const body = new URLSearchParams({
    'merchant-id': merchantId,
    'api-key': apiKey,
    firstname: 'Account',
    lastname: 'Check',
    email: 'noreply@niobebeauty.com',
    phonenumber: '233200000000',
    amount: '1.00',
    'order-id': `ACCTCHECK-${merchantId}-${Date.now()}`,
    currency: CONFIG.currency,
    'redirect-url': `${CONFIG.publicUrl}/pay/callback`,
  });
  let json;
  try {
    const res = await fetch(`${CONFIG.expresspayBase}/submit.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    json = await res.json();
  } catch (err) {
    return { label, ok: false, detail: `request failed: ${err.message}` };
  }
  if (Number(json.status) !== 1) {
    return { label, ok: false, detail: `${json.message || json['result-text'] || 'rejected'} (status ${json.status})` };
  }
  const actual = String(json['merchantservice-srvrtid'] || '');
  if (actual && actual !== String(merchantId)) {
    return {
      label,
      ok: false,
      detail: `WRONG ACCOUNT — addressed ${merchantId}, key belongs to ${actual} (${json['merchant-name'] || '?'})`,
    };
  }
  return { label, ok: true, detail: `${json['merchant-name'] || actual}` };
}

console.log(`expressPay: ${CONFIG.expresspayBase}\n`);
const results = await Promise.all(rows.map(check));
for (const r of results) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.label.padEnd(22)} ${r.detail}`);
}
for (const b of unconfigured) {
  console.log(`--    ${b.name.padEnd(22)} not configured, would use the central account`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} accounts verified.`);
process.exit(failed.length ? 1 : 0);
