// "SMS credit has run out" alert (src/notify.js). Hubtel and Microsoft Graph are stubbed.
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'niobe-smsalert-'));
Object.assign(process.env, {
  NIOBE_DATA_DIR: dir, NOTIFY_SMS_ENABLED: 'true', HUBTEL_SMS_CLIENT_ID: 'x', HUBTEL_SMS_CLIENT_SECRET: 'y',
  GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', NOTIFY_EMAIL_FROM: 'bookings@example.com',
});
let hubtelReply = { status: 12, statusDescription: 'Payment required on account' };
const mails = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes('sms.hubtel.com')) return json(400, { rate: 0, messageId: null, ...hubtelReply });
  if (u.includes('login.microsoftonline.com')) return json(200, { access_token: 'tok', expires_in: 3600 });
  if (u.includes('graph.microsoft.com')) { mails.push(JSON.parse(opts.body)); return { ok: true, status: 202, json: async () => ({}), text: async () => '' }; }
  throw new Error('unexpected fetch ' + u);
};
let clock = Date.now();
Date.now = () => clock;

const { sendSMS } = await import('../src/notify.js');
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); };
const settle = () => new Promise((r) => setTimeout(r, 50));   // the alert is fire-and-forget

let r = await sendSMS({ to: '0244000001', content: 'x' }); await settle();
ok(!r.ok && /Payment required/.test(r.error), 'the refused text is still reported as NOT sent');
ok(mails.length === 1 && /SMS credit has run out/.test(mails[0].message.subject), 'the first "out of credit" refusal emails the central mailbox');
ok(mails[0].message.toRecipients[0].emailAddress.address === 'bookings@example.com', '...at the configured address');

await sendSMS({ to: '0244000002', content: 'x' }); await sendSMS({ to: '0244000003', content: 'x' }); await settle();
ok(mails.length === 1, 'further refusals the same day send NO more alerts');
ok(existsSync(join(dir, 'sms-credit-alert.json')) && JSON.parse(readFileSync(join(dir, 'sms-credit-alert.json'), 'utf8')).at === clock, 'the alert time is kept on disk, so a restart does not re-send it');

hubtelReply = { status: 1, statusDescription: 'Invalid Destination (To)' };
clock += 25 * 3600e3;
await sendSMS({ to: '0244000004', content: 'x' }); await settle();
ok(mails.length === 1, 'a refusal for another reason (bad number) is not mistaken for running out of credit');

hubtelReply = { status: 12, statusDescription: 'Payment required on account' };
await sendSMS({ to: '0244000005', content: 'x' }); await settle();
ok(mails.length === 2, 'a day later, still out of credit, it reminds once more');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
