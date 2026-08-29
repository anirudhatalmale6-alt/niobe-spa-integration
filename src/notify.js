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
export async function sendEmail({ to, subject, html, replyTo, internal = false }) {
  // Mail to Niobe's own inboxes is switched independently of mail to customers — see
  // notifyStaffEmailEnabled in config.js.
  if (!(internal ? CONFIG.notifyStaffEmailEnabled : CONFIG.notifyEmailEnabled)) {
    return { ok: false, skipped: internal ? 'staff_email_disabled' : 'email_disabled' };
  }
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

// --- SMS via Hubtel ---------------------------------------------------------
// Normalise a Ghana mobile to Hubtel's expected MSISDN (233XXXXXXXXX). Handles
// 0XXXXXXXXX, +233…, 233…, or a bare 9-digit number.
function toGhMsisdn(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('233')) return d;
  if (d.startsWith('0')) return '233' + d.slice(1);
  if (d.length === 9) return '233' + d;         // missing leading 0
  return d;
}

// Send an SMS through the Hubtel Quick SMS API (sms.hubtel.com/v1/messages/send),
// as the approved sender "NIOBE". This endpoint authenticates by clientid/clientsecret
// query params (the form Hubtel's own dashboard hands you), NOT Basic auth. Uses the
// dedicated SMS key (separate from the checkout key). Returns { ok } / { ok:false, error }.
// Never throws into the caller's flow.
export async function sendSMS({ to, content }) {
  if (!CONFIG.notifySmsEnabled) return { ok: false, skipped: 'sms_disabled' };
  const msisdn = toGhMsisdn(to);
  if (!msisdn) return { ok: false, error: 'no_recipient' };
  if (!CONFIG.hubtelSmsClientId || !CONFIG.hubtelSmsClientSecret) return { ok: false, error: 'hubtel_sms_not_configured' };
  const url = new URL('https://sms.hubtel.com/v1/messages/send');
  url.searchParams.set('clientid', CONFIG.hubtelSmsClientId);
  url.searchParams.set('clientsecret', CONFIG.hubtelSmsClientSecret);
  url.searchParams.set('from', CONFIG.hubtelSmsSender);
  url.searchParams.set('to', msisdn);
  url.searchParams.set('content', content);
  try {
    const res = await fetch(url, { method: 'GET' });
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    // Hubtel accepts with status 0 / "0" (case-varying) or an HTTP 200/201 + messageId.
    const status = j.status ?? j.Status;
    const msgId = j.messageId || j.MessageId;
    const okStatus = res.ok && (status === 0 || status === '0' || msgId || j.data);
    if (okStatus) return { ok: true, id: msgId, raw: j };
    return { ok: false, error: `Hubtel SMS ${res.status}: ${text.slice(0, 180)}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// A booking's deposit-link SMS — short, with the pay link.
export async function sendDepositSMS({ to, branchName, payUrl, deadlineText }) {
  // Same reason as the email footer: the "already paid" way out has to travel with the ask.
  const content = `Niobe Beauty: your ${branchName || ''} booking is held. Secure it with your deposit${deadlineText ? ' by ' + deadlineText : ''}: ${payUrl} Already paid? Choose "Already paid" on that page.`.replace(/\s+/g, ' ').trim();
  return sendSMS({ to, content });
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
      <!-- The reason this line exists: customers holding a prepaid package or a voucher were
           reading a single "pay deposit" button, concluding they were being charged twice,
           and emailing the branch instead. The way out has to be in the same message that
           asks for the money — not one click further in, where they never look. -->
      <p style="font-size:13px;line-height:1.5;color:#4a3f38;margin:18px 0 0;padding-top:14px;border-top:1px solid #efe4d8">
        <strong>Already paid for this treatment?</strong> If it's covered by a package you've already bought,
        a gift card or credit on your account, open the same link and choose
        <em>"Already paid for this treatment"</em> — no deposit is taken, we hold your slot and the
        team confirms it for you. Please don't pay twice.
      </p>
    </div>
    <p style="font-size:12px;color:#a08b76;text-align:center;margin:16px 0 0">Niobe Beauty · where ageing is optional</p>
  </div></body></html>`;
}

// --- Staff: "this customer says it's already paid for" -----------------------
// Goes to the BRANCH's own booking inbox. Until this existed, a customer who chose
// "already paid" was told "our team will confirm shortly" while the only record of it
// was a line in a log file on the server that nothing read. The promise was real to the
// customer and invisible to Niobe.
//
// The email carries what the desk needs to act without opening anything else: who,
// when, which treatment, and what that client has actually paid for lately. Reply-to is
// set to the customer, so hitting reply reaches them rather than the sending mailbox.
export function alreadyPaidEmailHtml({ kind, customer, phone, email, branchName, service, datetime, price, evidence, note }) {
  const what = kind === 'package' ? 'a package already paid for'
    : kind === 'voucher' ? 'a gift card or voucher' : 'Niobe account credit';
  const row = (k, v) => (v ? `<tr><td style="padding:3px 14px 3px 0;color:#a08b76">${esc(k)}</td><td><strong>${esc(v)}</strong></td></tr>` : '');
  // No evidence is NOT the same as no payments: the lookup may simply not have answered
  // yet. Saying which one it is stops the desk reading silence as proof.
  const ev = Array.isArray(evidence) && evidence.length
    ? `<table style="font-size:13px;color:#4a3f38;border-collapse:collapse;margin-top:6px">
         ${evidence.map((e) => `<tr>
           <td style="padding:3px 12px 3px 0;color:#a08b76;white-space:nowrap">${esc(String(e.at || '').slice(0, 10))}</td>
           <td style="padding:3px 12px 3px 0">${esc(e.description)}${e.looksLikePackage ? ' <span style="color:#8a6a3c">(package)</span>' : ''}</td>
           <td style="padding:3px 0;text-align:right;white-space:nowrap">GHS ${esc(e.amount)}</td></tr>`).join('')}
       </table>`
    : Array.isArray(evidence)
      ? `<p style="font-size:13px;color:#8a6a3c;margin:6px 0 0">No payments found under this name at this branch in the last 180 days. Worth checking the name spelling, another branch, or a gift card bought online.</p>`
      : `<p style="font-size:13px;color:#8a6a3c;margin:6px 0 0">Their payment history could not be read just now${note ? ` (${esc(note)})` : ''} — please check it in SimpleSpa.</p>`;

  return `<!doctype html><html><body style="margin:0;background:#f6f1ec;font-family:Georgia,'Times New Roman',serif;color:#2b2320">
  <div style="max-width:600px;margin:0 auto;padding:24px 20px">
    <div style="background:#fffdfb;border:1px solid #e9ddd2;border-radius:14px;padding:24px">
      <h1 style="margin:0 0 6px;font-size:19px;font-weight:normal">Guest says this booking is already paid for</h1>
      <p style="font-size:14px;color:#4a3f38;margin:0 0 16px">No deposit was taken and the slot is being held. Please check it and confirm the appointment in SimpleSpa — or call the guest if it doesn't match.</p>
      <table style="font-size:14px;color:#6b5d53;line-height:1.7;border-collapse:collapse">
        ${row('Guest', customer)}${row('Phone', phone)}${row('Email', email)}
        ${row('They say', what)}${row('Branch', branchName)}${row('Treatment', service)}
        ${row('When', datetime)}${row('Treatment price', price ? `GHS ${price}` : '')}
      </table>
      <p style="font-size:14px;color:#4a3f38;margin:18px 0 0"><strong>What we can see they've paid for (last 180 days, this branch):</strong></p>
      ${ev}
    </div>
    <p style="font-size:11px;color:#a08b76;text-align:center;margin:14px 0 0">Sent automatically by the Niobe booking system.</p>
  </div></body></html>`;
}

export async function sendAlreadyPaidEmail(claim) {
  return sendEmail({
    to: claim.to,
    internal: true,
    subject: `Already paid — ${claim.customer || 'guest'} · ${claim.service || 'appointment'} · ${claim.datetime || ''}`.trim(),
    html: alreadyPaidEmailHtml(claim),
    // Reply goes to the guest, not to the sending mailbox.
    replyTo: claim.email || undefined,
  });
}

// Convenience: build + send the deposit-link email for a booking.
export async function sendDepositEmail({ to, name, branchName, service, datetime, amountText, payUrl, deadlineText }) {
  return sendEmail({
    to,
    subject: `Secure your Niobe appointment${branchName ? ' — ' + branchName : ''}`,
    html: depositEmailHtml({ name, branchName, service, datetime, amountText, payUrl, deadlineText }),
  });
}
