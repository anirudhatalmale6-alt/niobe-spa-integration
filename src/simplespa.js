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
