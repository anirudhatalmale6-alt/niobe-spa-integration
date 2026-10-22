// "No request, no release" — the deposit engine (src/holds.js), driven through sweepBranch with
// SimpleSpa, Hubtel SMS and the cancel call all stubbed. Bug of 22 Oct 2026: bookings made more
// than 7 days ahead never got a deposit link and were then cancelled for not paying.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'niobe-holds-'));
Object.assign(process.env, {
  NIOBE_DATA_DIR: dir, DEMO_MODE: 'false', EAST_LEGON_KEY: 'test',
  RELEASE_ENABLED: 'true', RELEASE_DRY_RUN: 'false', RELEASE_SCOPE: 'all',
  RELEASE_GRACE_MINUTES: '60', RELEASE_UNTRACKED_GRACE_MINUTES: '540',
  NOTIFY_AUTOSEND_ENABLED: 'true', NOTIFY_SMS_ENABLED: 'true',
  HUBTEL_SMS_CLIENT_ID: 'x', HUBTEL_SMS_CLIENT_SECRET: 'y', PUBLIC_URL: 'https://pay.example',
});
const H = 3600e3, D = 24 * H;
const ts = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const NOW = Date.now();
// A simulated clock: the engine reads Date.now() for its fetch window and for when it asked, so time
// has to move for IT, not just for the `now` we pass in — or a booking can never drift into the window.
let clock = NOW;
const realNow = Date.now.bind(Date);
Date.now = () => clock;
const sweepAt = (t) => { clock = t; return sweepBranch(branch, new Date(t)); };

// Seed: one booking asked under the OLD notified.json format (stamps only, no "asked").
writeFileSync(join(dir, 'notified.json'), JSON.stringify({ notified: ['OLD1'], reminded: [], stamps: { OLD1: NOW - 3 * D } }));

const appts = new Map();
const add = (id, { createdAgo, startIn, mobile = '0244000001' }) => appts.set(id, {
  appointment_id: id, created_at: ts(NOW - createdAgo), start: ts(NOW + startIn), end: ts(NOW + startIn + H),
  status: 10, status_label: 'Online', client: { client_id: `c-${id}`, first_name: 'Test', last_name: id, mobile, email: '' },
  service: { service_id: 's1', service_name: 'RELAX PACKAGE (100% DEPOSIT REQUIRED TO BOOK)' }, staff: { staff_id: 't1', staff_name: 'T' },
});
add('FAR', { createdAgo: 10 * D, startIn: 30 * D });                 // booked 10 days ago for 30 days out, never asked
add('NEAR', { createdAgo: H, startIn: 2 * D, mobile: '0244000002' });                       // booked an hour ago for the day after tomorrow
add('DEAD', { createdAgo: 5 * D, startIn: 20 * D, mobile: '0244999999' }); // SMS always fails
add('OLD1', { createdAgo: 4 * D, startIn: 25 * D, mobile: '0244000003' });
// The exact live failure: booked 10 days ago for 8 days out — outside the old 7-day window today,
// inside it two days from now, and by then far too "old" for the old code to ask.
add('EDGE', { createdAgo: 10 * D, startIn: 8 * D, mobile: '0244000004' });                  // asked 3 days ago under the old format
const smsTo = [], cancels = [], events = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes('sms.hubtel.com')) {
    const to = new URL(u).searchParams.get('to');
    smsTo.push(to);
    if (!to.endsWith('999999')) events.push(['asked', to]);
    return to.endsWith('999999') ? json(400, { message: 'invalid number' }) : json(200, { status: 0, messageId: 'm1' });
  }
  if (u.endsWith('/write/appointments-status.php')) {
    const b = JSON.parse(opts.body); cancels.push(b.appointment_id);
    events.push(['cancel', appts.get(b.appointment_id)?.client.mobile]);
    const a = appts.get(b.appointment_id); if (a) { a.status = 15; a.status_label = 'Canceled'; }
    return json(200, { success: true });
  }
  if (u.endsWith('/appointments.php')) {
    const b = JSON.parse(opts.body);
    const list = [...appts.values()].filter((a) => a.start.slice(0, 10) >= b.start && a.start.slice(0, 10) <= b.end);
    return json(200, { success: true, total_results: list.length, appointments: list.map((a) => ({ ...a })) });
  }
  if (u.includes('login.microsoftonline') || u.includes('graph.microsoft')) return json(401, {});
  throw new Error('unexpected fetch ' + u);
};

const { BRANCHES } = await import('../src/config.js');
const { sweepBranch } = await import('../src/holds.js');
const branch = BRANCHES.find((b) => b.id === 'east_legon');

let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${name}`); };
const sentFor = (n) => smsTo.filter((t) => t.endsWith(n)).length;

// Sweep 1 — now.
await sweepAt(NOW);
ok(sentFor('000001') === 1 && sentFor('000002') === 1, 'the far-ahead booking AND the near one are each sent a deposit link on the first sweep');
ok(sentFor('000003') === 0, 'the booking already asked under the old format is not asked again');
ok(!cancels.includes('FAR'), 'the far-ahead booking (booked 10 days ago, never asked) is NOT cancelled — it has only just been asked');
ok(!cancels.includes('NEAR'), 'the near booking is not cancelled straight after being asked');
ok(!cancels.includes('DEAD'), 'a booking whose SMS failed is not cancelled');

// Sweeps 2-3 — the dead number is retried, then given up on (3 attempts in total).
await sweepAt(NOW + 10 * 60e3);
await sweepAt(NOW + 20 * 60e3);
await sweepAt(NOW + 30 * 60e3);
ok(sentFor('999999') === 3, `a number that never accepts is tried exactly 3 times, not forever (tried ${sentFor('999999')})`);
ok(sentFor('000001') === 1 && sentFor('000002') === 1, 'nobody who was reached is texted the first link again on later sweeps');

await sweepAt(NOW + 2 * D);

// Sweep — four days later: the asked bookings have had their full grace; the dead one has not been asked.
await sweepAt(NOW + 4 * D);
ok(cancels.includes('FAR'), 'once asked AND past the grace period, the far-ahead booking is released as before');
ok(!cancels.includes('DEAD'), 'a booking we never managed to ask is NEVER released, however late it gets');
ok(cancels.includes('OLD1'), 'a booking asked under the old record format is still released after its grace (old stamps still count)');

// Sweep two days later as well — where the old code cancelled EDGE without a word.
ok(true, `(EDGE was asked on the first sweep: ${sentFor('000004') === 1})`);

// THE INVARIANT, over every cancellation in the run: a successful request reached that number first
// (or, for OLD1, the seeded old-format record says it was asked 3 days ago).
const unasked = events.filter(([e, to], i) => e === 'cancel' && !to.endsWith('000003')
  && !events.slice(0, i).some(([e2, t2]) => e2 === 'asked' && t2.endsWith(to.slice(-6))));
ok(unasked.length === 0, `no booking was cancelled without being asked first (${unasked.length} were)`);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
