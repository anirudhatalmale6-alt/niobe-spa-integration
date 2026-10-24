// Certificate sign-in for Microsoft Graph (src/graphauth.js + notify.js). Microsoft is stubbed; the
// certificate is a throwaway made here with openssl.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verify, X509Certificate } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'niobe-graphauth-'));
const certPath = join(dir, 'c.pem'), keyPath = join(dir, 'c.key');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=test'], { stdio: 'ignore' });

Object.assign(process.env, {
  NIOBE_DATA_DIR: dir, GRAPH_TENANT_ID: 'tenant-1', GRAPH_CLIENT_ID: 'client-1', GRAPH_CLIENT_SECRET: 'old-secret',
  GRAPH_CERT_PATH: certPath, GRAPH_CERT_KEY_PATH: keyPath, NOTIFY_EMAIL_FROM: 'bookings@example.com',
});
const tokenCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('login.microsoftonline.com')) { tokenCalls.push({ url: u, body: new URLSearchParams(String(opts.body)) }); return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) }; }
  if (u.includes('graph.microsoft.com')) return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
  throw new Error('unexpected fetch ' + u);
};

const { graphAuthMode, sendEmail } = await import('../src/notify.js');
const { loadCertificate } = await import('../src/graphauth.js');
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); };
const part = (jwt, i) => JSON.parse(Buffer.from(jwt.split('.')[i], 'base64url').toString());

ok(graphAuthMode() === 'certificate', 'with a certificate configured, the certificate is used even though a secret is still set');
const r = await sendEmail({ to: 'a@example.com', subject: 's', html: '<p>x</p>' });
ok(r.ok && tokenCalls.length === 1, 'an email goes out signed in with the certificate');
const b = tokenCalls[0].body;
ok(!b.has('client_secret'), 'the secret is NOT sent to Microsoft');
ok(b.get('client_assertion_type') === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', 'client_assertion_type is the jwt-bearer type');
const jwt = b.get('client_assertion');
const h = part(jwt, 0), c = part(jwt, 1);
const cert = new X509Certificate(readFileSync(certPath));
const expectX5t = Buffer.from(cert.fingerprint.replace(/:/g, ''), 'hex').toString('base64url');
ok(h.alg === 'RS256' && h.x5t === expectX5t, 'header: RS256 with the certificate\'s SHA-1 thumbprint as x5t');
ok(c.aud === 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token' && c.iss === 'client-1' && c.sub === 'client-1', 'claims: aud is the tenant token endpoint, iss = sub = client id');
ok(c.exp - c.nbf === 600 && c.jti, 'claims: valid 10 minutes, with a unique jti');
const [hh, cc, sig] = jwt.split('.');
ok(verify('RSA-SHA256', Buffer.from(`${hh}.${cc}`), cert.publicKey, Buffer.from(sig, 'base64url')), 'the signature verifies against the certificate\'s public key');
ok(loadCertificate(certPath, keyPath).thumbprint === cert.fingerprint.replace(/:/g, ''), 'loadCertificate reports the same thumbprint Entra shows');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
