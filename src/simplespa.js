import { CONFIG } from './config.js';

// Thin client for the SimpleSpa Enterprise API.
// All endpoints are POST with a JSON body and Bearer "<key>" auth. A single API key
// carries both identity and permission — read vs write is set by the key's Mode
// (1 = Read, 2 = Write, 3 = Read + Write) in the SimpleSpa dashboard, not a secret.
export async function ssPost(branch, endpoint, body = {}) {
  if (!branch.key) {
    throw new Error(`Branch "${branch.name}" is missing its API key`);
  }
  const url = `${CONFIG.base}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${branch.key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  // SimpleSpa returns credential/permission errors inside a 200 body with statusCode.
  if (json && json.statusCode && json.statusCode >= 400) {
    const detail = json.errors?.[0]?.detail || json.message || 'Unknown API error';
    const err = new Error(detail);
    err.apiCode = json.errors?.[0]?.code;
    err.statusCode = json.statusCode;
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${endpoint}`);
  return json;
}

// What has this client already paid for at this branch?
//
// Needed because an appointment record carries NO money at all — verified against live
// data 29 Aug 2026, an appointment is exactly: appointment_id, client, service, staff,
// start, end, status, status_label, created_at. So nothing in a booking can tell us that
// the treatment is already covered by a prepaid package. The only place that shows is
// transactions.php: description, amount, qty, type, timestamp, and the client's NAME.
//
// A name is a weak identifier — two clients share one often enough — so this is EVIDENCE
// FOR STAFF, never an automatic waiver. It is shown to the front desk, who already know
// the customer, and never back to the person who typed it. Two guests called Grace Mensah
// must not learn what the other one bought.
export async function findClientPayments(branch, clientName, { days = 180, limit = 12 } = {}) {
  const want = String(clientName || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!want) return [];
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);

  const rows = [];
  // The window can be long, so page rather than assume one response holds it all.
  for (let page = 1; page <= 20; page++) {
    const data = await ssPost(branch, 'transactions.php', { start: iso(start), end: iso(end), page, per_page: 1000 });
    const items = data.transactions || Object.values(data).find(Array.isArray) || [];
    rows.push(...items);
    const total = data.total_results ?? rows.length;
    if (rows.length >= total || items.length === 0) break;
  }

  return rows
    .filter((r) => String(r.client || '').trim().toLowerCase().replace(/\s+/g, ' ') === want)
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
    .slice(0, limit)
    .map((r) => ({
      at: r.timestamp, description: r.description, amount: r.amount,
      qty: r.qty, type: r.type, receiptId: r.receipt_id,
      // Niobe records the rule in the service NAME itself ("… (100% DEPOSIT REQUIRED TO
      // BOOK)"), so a package purchase is recognisable from the description alone.
      looksLikePackage: /pack|course|series|combo|prepaid/i.test(String(r.description || '')),
    }));
}

// Pull ALL products for one branch, following pagination.
export async function fetchBranchProducts(branch) {
  const perPage = 1000;
  let page = 1;
  const all = [];
  // Guard against runaway loops; SimpleSpa caps per_page at 1000.
  for (let i = 0; i < 50; i++) {
    const data = await ssPost(branch, 'products.php', { page, per_page: perPage });
    const items = data.products || [];
    all.push(...items);
    const total = data.total_results ?? all.length;
    if (all.length >= total || items.length === 0) break;
    page += 1;
  }
  return all;
}
