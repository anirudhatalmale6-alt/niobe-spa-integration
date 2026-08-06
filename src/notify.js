import { CONFIG } from './config.js';

// ---------------------------------------------------------------------------
// Outbound notifications — emails the deposit / "secure your slot" link to a
// client. Email goes through Microsoft Graph (app-only / client-credentials) so
// it sends as paidforbooking@niobebeauty.com on the client's Microsoft 365 /
// Exchange tenant. Chosen over SMTP AUTH because Microsoft is retiring Basic
// Auth; Graph keeps working and needs no mailbox password.
//
// Zero-dependency: a cached OAuth2 token + fetch to the Graph sendMail endpoint.
// SMS (Hubtel) plugs in alongside once the sender ID is confirmed.
// ---------------------------------------------------------------------------

let tokenCache = { value: null, exp: 0 };

async function graphToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.exp - 60000) return tokenCache.value;
  const { graphTenantId, graphClientId, graphClientSecret } = CONFIG;
  if (!graphTenantId || !graphClientId || !graphClientSecret) {
    throw new Error('Graph email not configured (GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET)');
  }
  const body = new URLSearchParams({
    client_id: graphClientId,
    client_secret: graphClientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${graphTenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`Graph token error: ${j.error || res.status} ${j.error_description || ''}`.slice(0, 200));
  tokenCache = { value: j.access_token, exp: now + (Number(j.expires_in) || 3600) * 1000 };
  return tokenCache.value;
}

// Send an HTML email as the configured mailbox. Returns { ok } (Graph replies 202
// with an empty body on success). Never throws to the caller's flow — a failed
// notification must not break booking/payment; it returns { ok:false, error }.
export async function sendEmail({ to, subject, html, replyTo }) {
  if (!CONFIG.notifyEmailEnabled) return { ok: false, skipped: 'email_disabled' };
  if (!to) return { ok: false, error: 'no_recipient' };
  try {
    const token = await graphToken();
    const message = {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: [{ emailAddress: { address: to } }],
    };
    if (replyTo) message.replyTo = [{ emailAddress: { address: replyTo } }];
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(CONFIG.notifyEmailFrom)}/sendMail`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, saveToSentItems: true }) },
    );
    if (res.status === 202) return { ok: true };
    const t = await res.text();
    return { ok: false, error: `Graph sendMail ${res.status}: ${t.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Branded "secure your appointment" email carrying the deposit link. Matches the
// Niobe editorial look (cream/dark-chocolate, serif headline).
export function depositEmailHtml({ name, branchName, service, datetime, amountText, payUrl, deadlineText }) {
  const safeUrl = esc(payUrl);
  return `<!doctype html><html><body style="margin:0;background:#f6f1ec;font-family:Georgia,'Times New Roman',serif;color:#2b2320">
  <div style="max-width:560px;margin:0 auto;padding:28px 22px">
    <div style="text-align:center;letter-spacing:3px;font-size:13px;color:#b08a54;text-transform:uppercase;margin-bottom:18px">Niobe Beauty</div>
    <div style="background:#fffdfb;border:1px solid #e9ddd2;border-radius:14px;padding:26px 24px">
      <h1 style="margin:0 0 12px;font-size:22px;font-weight:normal">Secure your appointment${name ? ', ' + esc(name) : ''}</h1>
      <p style="font-size:15px;line-height:1.5;color:#4a3f38;margin:0 0 16px">
        Your booking is being held. To confirm it, please secure it with your deposit${deadlineText ? ' by <strong>' + esc(deadlineText) + '</strong>' : ''} — otherwise the slot is released for other guests.
      </p>
      <table style="font-size:14px;color:#6b5d53;margin:0 0 20px;line-height:1.7">
        ${branchName ? `<tr><td style="padding-right:14px;color:#a08b76">Branch</td><td><strong>${esc(branchName)}</strong></td></tr>` : ''}
        ${service ? `<tr><td style="padding-right:14px;color:#a08b76">Service</td><td>${esc(service)}</td></tr>` : ''}
        ${datetime ? `<tr><td style="padding-right:14px;color:#a08b76">When</td><td>${esc(datetime)}</td></tr>` : ''}
        ${amountText ? `<tr><td style="padding-right:14px;color:#a08b76">Deposit</td><td>${esc(amountText)}</td></tr>` : ''}
      </table>
      <div style="text-align:center;margin:22px 0">
        <a href="${safeUrl}" style="background:#b08a54;color:#2b2320;text-decoration:none;font-weight:bold;padding:13px 30px;border-radius:26px;display:inline-block;font-family:Arial,sans-serif;font-size:15px">Pay deposit &amp; secure slot</a>
      </div>
      <p style="font-size:12px;color:#a08b76;text-align:center;margin:14px 0 0">If the button doesn't work, copy this link:<br><span style="color:#8a6a3c">${safeUrl}</span></p>
    </div>
    <p style="font-size:12px;color:#a08b76;text-align:center;margin:16px 0 0">Niobe Beauty · where ageing is optional</p>
  </div></body></html>`;
}

// Convenience: build + send the deposit-link email for a booking.
export async function sendDepositEmail({ to, name, branchName, service, datetime, amountText, payUrl, deadlineText }) {
  return sendEmail({
    to,
    subject: `Secure your Niobe appointment${branchName ? ' — ' + branchName : ''}`,
    html: depositEmailHtml({ name, branchName, service, datetime, amountText, payUrl, deadlineText }),
  });
}
