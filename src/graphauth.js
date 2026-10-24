// Microsoft identity platform: sign in with a CERTIFICATE instead of a client secret
// (client_credentials + client_assertion). Asked for by Niobe's IT, 24 Oct 2026: a secret can be
// copied and used from anywhere; a private key that never leaves the droplet cannot.
//
// Zero-dependency: the assertion is a short-lived JWT signed RS256 with the private key, carrying the
// certificate's SHA-1 thumbprint (x5t) so Entra knows which uploaded certificate to check it against.
import { readFileSync } from 'fs';
import { createHash, createPrivateKey, randomUUID, sign, X509Certificate } from 'crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Read a PEM certificate and its private key once; returns what buildClientAssertion needs.
export function loadCertificate(certPath, keyPath) {
  const cert = new X509Certificate(readFileSync(certPath));
  const key = createPrivateKey(readFileSync(keyPath));
  return {
    key,
    x5t: b64url(createHash('sha1').update(cert.raw).digest()),
    thumbprint: cert.fingerprint.replace(/:/g, ''),
    validTo: cert.validTo,
  };
}

export function buildClientAssertion({ tenantId, clientId, cert, now = Date.now() }) {
  const t = Math.floor(now / 1000);
  const header = { alg: 'RS256', typ: 'JWT', x5t: cert.x5t };
  const claims = {
    aud: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    iss: clientId, sub: clientId, jti: randomUUID(), nbf: t, iat: t, exp: t + 600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${unsigned}.${b64url(sign('RSA-SHA256', Buffer.from(unsigned), cert.key))}`;
}

// The form body for the token endpoint: certificate when one is given, otherwise the secret.
export function tokenRequestBody({ tenantId, clientId, clientSecret, cert, scope = 'https://graph.microsoft.com/.default' }) {
  const body = { client_id: clientId, scope, grant_type: 'client_credentials' };
  if (cert) {
    body.client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
    body.client_assertion = buildClientAssertion({ tenantId, clientId, cert });
  } else {
    body.client_secret = clientSecret;
  }
  return new URLSearchParams(body);
}
