// Ask Microsoft for a Graph token with the CERTIFICATE, and send nothing. Use it to prove the
// uploaded certificate works before switching the mailer over:
//   node scripts/graph-token-check.mjs /etc/niobe-pay/graph-mailer.pem /etc/niobe-pay/graph-mailer.key
// Reads tenant + client id from .env. Prints the thumbprint and the app roles in the token; never the token.
import { readFileSync } from 'node:fs';
import { loadCertificate, tokenRequestBody } from '../src/graphauth.js';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')
  .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const [certPath, keyPath] = process.argv.slice(2);
const cert = loadCertificate(certPath, keyPath);
const tenantId = env.GRAPH_TENANT_ID, clientId = env.GRAPH_CLIENT_ID;
const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: tokenRequestBody({ tenantId, clientId, cert }),
});
const j = await res.json();
if (!j.access_token) { console.log(`FAILED (${res.status}): ${j.error} ${String(j.error_description || '').split('\r')[0]}`); process.exit(1); }
const claims = JSON.parse(Buffer.from(j.access_token.split('.')[1], 'base64url').toString());
console.log(`OK: certificate ${cert.thumbprint} (valid to ${cert.validTo}) accepted; app roles: ${(claims.roles || []).join(', ') || 'none'}`);
