// End-to-end tests for the public gift-card balance page (/balance).
//
// These run against the REAL server over real HTTP, with the two upstream systems
// (GiftUp and SimpleSpa) replaced by a local stub. That matters, because almost
// everything worth testing here is about what happens when something goes wrong:
//
//   - a code that does not exist anywhere            -> 404, "we couldn't find that"
//   - a code we could not CHECK because a ledger was down -> 503, "try again"
//
// Those two produce nearly identical code paths and opposite messages to a customer
// holding a real gift. A test suite that only buys a card and looks up its balance
// passes happily while that distinction is broken, which is why the stub can be told
// to fail on demand.
//
// Run:  node scripts/test-balance.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'niobe-balance-'));

// --- the stub standing in for GiftUp and SimpleSpa ---------------------------
// Holds a tiny fixture and a pair of switches that make either system fail.
const stub = {
  giftupDown: false,
  simplespaDown: false,
  giftupCards: {
    // A live GiftUp card — the ledger every card sold before the switch-over lives in.
    'XXP7P': { code: 'XXP7P', remainingValue: 250, expired: false, voided: false, expiresOn: null },
  },
  simplespaCards: {
    // A legacy SimpleSpa card. Note the O and the 0 in it: these older codes contain
    // exactly the characters our own alphabet avoids, which is what the mis-read
    // retry exists for.
    'DPB-QO0': { giftcard_id: 11, code: 'DPB-QO0', balance: 180, initial_balance: 300, is_expired: false, expires_at: '2027-01-01 00:00:00' },
  },
};

const stubServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    // GiftUp: GET /gift-cards/<code>
    if (req.url.startsWith('/gift-cards/')) {
      if (stub.giftupDown) return send(500, { error: 'giftup is down' });
      const code = decodeURIComponent(req.url.split('/gift-cards/')[1].split('?')[0]).toUpperCase();
      const c = stub.giftupCards[code];
      if (!c) return send(404, { error: 'not found' });
      return send(200, c);
    }

    // SimpleSpa: POST /giftcards.php  { code }
    if (req.url.endsWith('/giftcards.php')) {
      if (stub.simplespaDown) return send(500, { error: 'simplespa is down' });
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* fall through to empty */ }
      const code = String(parsed.code || '').toUpperCase();
      const c = stub.simplespaCards[code];
      return send(200, { gift_cards: c ? [c] : [] });
    }

    send(404, { error: 'unknown stub endpoint' });
  });
});
await new Promise((r) => stubServer.listen(0, '127.0.0.1', r));
const stubUrl = `http://127.0.0.1:${stubServer.address().port}`;

// --- environment, set BEFORE the server module is imported -------------------
const PORT = 4187;
process.env.NIOBE_DATA_DIR = dir;
process.env.PORT = String(PORT);
process.env.SIMPLESPA_BASE = stubUrl;
process.env.GIFTUP_BASE = stubUrl;
process.env.GIFTUP_API_KEY = 'test-key';
// One branch is enough to exercise the per-branch loop, and keeps the stub's call
// count predictable. Every other branch stays keyless.
process.env.EAST_LEGON_KEY = 'test-branch-key';
process.env.DEMO_MODE = 'false';
process.env.RELEASE_ENABLED = 'false';
// Generous enough that the functional tests never trip it; the limiter gets its own
// dedicated test below with its own tighter numbers.
process.env.BALANCE_RATE_PER_MIN = '100';
process.env.BALANCE_RATE_PER_HOUR = '1000';
process.env.BALANCE_RATE_GLOBAL_PER_MIN = '5000';

const { reserveBasket, markPaid, basketCards, spend, getCard } = await import('../src/cards.js');
const { CONFIG } = await import('../src/config.js');
assert.equal(CONFIG.giftupKey, 'test-key', 'the GiftUp key must be configured or the "not checked" path is untestable');

await import('../src/server.js');           // starts listening on PORT
await new Promise((r) => setTimeout(r, 250));

const base = `http://127.0.0.1:${PORT}`;
const get = (path) => fetch(`${base}${path}`, { redirect: 'manual' });
const post = (path, form) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(form).toString(),
  redirect: 'manual',
});

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok   ${name}`); }
  catch (e) { results.push(`  FAIL ${name}\n         ${e.message}`); process.exitCode = 1; }
}

// --- fixtures in our own ledger ----------------------------------------------
const buyer = { buyerName: 'Ama Mensah', buyerEmail: 'ama@example.com', buyerPhone: '0244000000' };
const mkCard = (amount = 500) => {
  const r = reserveBasket({ ...buyer, items: [{ amount, design: 'floral-01', recipientName: 'Kofi', recipientEmail: 'kofi@example.com' }] });
  const [card] = basketCards(r.reference);
  return { reference: r.reference, code: card.code };
};

const paid = mkCard(500);
markPaid(paid.reference, { paymentRef: 'TEST-1' });

const unpaid = mkCard(400);                       // reserved, never paid

const partly = mkCard(600);
markPaid(partly.reference, { paymentRef: 'TEST-2' });
spend(partly.code, 250, { reason: 'treatment', branchId: 'east_legon' });

const expiredCard = mkCard(300);
markPaid(expiredCard.reference, { paymentRef: 'TEST-3' });
// Reach into the ledger to age it, the way the real thing ages: by date, not by flag.
{
  const c = getCard(expiredCard.code);
  c.expiresAt = new Date(Date.now() - 5 * 86400_000).toISOString();
}

// --- the happy path -----------------------------------------------------------

await test('GET /balance shows the form', async () => {
  const res = await get('/balance');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Check your gift card balance/);
  assert.match(body, /action="\/balance"/);
});

await test('a paid card reports its balance', async () => {
  const res = await post('/balance', { code: paid.code });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /GHS\s*500\.00/);
  assert.match(body, /Balance available/);
});

await test('a part-spent card reports what is LEFT, not the face value', async () => {
  const res = await post('/balance', { code: partly.code });
  const body = await res.text();
  assert.match(body, /GHS\s*350\.00/, 'should show the remaining 350');
  assert.match(body, /Original value/);
  assert.match(body, /GHS\s*600\.00/, 'should also show what it started as');
});

await test('the full code is never returned to the browser', async () => {
  const res = await post('/balance', { code: paid.code });
  const body = await res.text();
  assert.equal(body.includes(paid.code), false, 'the full gift-card code leaked into the page');
  assert.match(body, new RegExp(paid.code.slice(-4)), 'the last four should be shown so the holder can identify the card');
});

await test('a lower-case, space-padded, quoted code still works', async () => {
  const res = await post('/balance', { code: `  "${paid.code.toLowerCase()}".  ` });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Balance available/);
});

await test('GET /balance?code= works, for the link in an expiry reminder', async () => {
  const res = await get(`/balance?code=${encodeURIComponent(paid.code)}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Balance available/);
});

// --- the rules that protect money --------------------------------------------

await test('an UNPAID reservation is indistinguishable from a code that does not exist', async () => {
  // The property that matters is not "the code is absent from the page" — the page
  // echoes whatever the visitor typed back into the retry box, which tells them
  // nothing they did not already have. It is that the two responses are the SAME.
  // If an unpaid card produced any different status, wording or timing, the endpoint
  // would be an oracle for discovering which codes have been issued but not yet paid
  // for, and those are precisely the codes with no owner watching them.
  const ghost = 'NB-ZZZZ-ZZZZ-ZZZZ';
  const a = await post('/balance', { code: unpaid.code });
  const b = await post('/balance', { code: ghost });
  assert.equal(a.status, 404);
  assert.equal(a.status, b.status, 'an unpaid card answered with a different status to a non-existent one');

  // Neutralise each response's echoed input before comparing the rest.
  const norm = (s, c) => s.split(c).join('<CODE>');
  assert.equal(
    norm(await a.text(), unpaid.code),
    norm(await b.text(), ghost),
    'the page differs between an unpaid card and a code that was never issued',
  );
});

await test('an unpaid code appears ONLY in the retry box, never as a balance', async () => {
  const body = await (await post('/balance', { code: unpaid.code })).text();
  assert.equal((body.match(new RegExp(unpaid.code, 'g')) || []).length, 1, 'the code should appear once, in the form input');
  assert.match(body, /value="[^"]*NB-/, 'and that one occurrence must be the input value');
  assert.equal(/Balance available/.test(body), false);
  assert.equal(/GHS\s*400\.00/.test(body), false, 'the reserved face value must never be shown');
});

await test('an expired card shows the balance AND the extension offer', async () => {
  const res = await post('/balance', { code: expiredCard.code });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /passed its expiry date/i);
  assert.match(body, /GHS\s*300\.00/, 'the money is still theirs and must be shown');
  assert.match(body, /extend this card by 30 days/i);
});

await test('the buyer and recipient names are never disclosed', async () => {
  const res = await post('/balance', { code: paid.code });
  const body = await res.text();
  assert.equal(/Ama Mensah/.test(body), false, 'a guessed code must not reveal who bought it');
  assert.equal(/Kofi/.test(body), false, 'nor who it was bought for');
});

// --- the distinction this feature exists for ----------------------------------

await test('a code in no ledger is a 404, when every ledger answered', async () => {
  const res = await post('/balance', { code: 'NB-ZZZZ-ZZZZ-ZZZZ' });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /couldn't find that code/i);
});

await test('GiftUp being down is a 503, NOT "no such card"', async () => {
  stub.giftupDown = true;
  try {
    const res = await post('/balance', { code: 'NB-ZZZZ-ZZZZ-ZZZZ' });
    assert.equal(res.status, 503, 'an outage reported as an invalid card tells a customer their gift is worthless');
    const body = await res.text();
    assert.match(body, /couldn't check it just now/i);
    assert.match(body, /not your card/i);
    assert.equal(res.headers.get('retry-after'), '60');
  } finally { stub.giftupDown = false; }
});

await test('SimpleSpa being down is a 503, NOT "no such card"', async () => {
  stub.simplespaDown = true;
  try {
    const res = await post('/balance', { code: 'NB-ZZZZ-ZZZZ-ZZZZ' });
    assert.equal(res.status, 503);
  } finally { stub.simplespaDown = false; }
});

await test('a ledger being down does NOT stop a card found in an earlier ledger', async () => {
  stub.simplespaDown = true;
  try {
    const res = await post('/balance', { code: paid.code });
    assert.equal(res.status, 200, 'our own ledger answered — a downstream outage is irrelevant');
    assert.match(await res.text(), /GHS\s*500\.00/);
  } finally { stub.simplespaDown = false; }
});

// --- the other two ledgers ----------------------------------------------------

await test('a GiftUp card is found and reported', async () => {
  const res = await post('/balance', { code: 'XXP7P' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /GHS\s*250\.00/);
});

await test('a legacy SimpleSpa card is found, and says staff apply it', async () => {
  const res = await post('/balance', { code: 'DPB-QO0' });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /GHS\s*180\.00/);
  assert.match(body, /earlier gift cards/i, 'must say it is applied by the team, not automatically');
  assert.match(body, /East Legon/);
});

await test('a mis-read O/0 on a legacy code still finds the card', async () => {
  // DPB-Q00 (two zeros) is what someone types off a printed voucher that reads DPB-QO0.
  const res = await post('/balance', { code: 'DPB-Q00' });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /GHS\s*180\.00/);
  assert.match(body, /check the last four characters/i, 'must warn that the code was corrected');
});

// --- input handling -----------------------------------------------------------

await test('junk is rejected without touching the upstream systems', async () => {
  // If the shape check is removed, this reaches SimpleSpa and the endpoint becomes a
  // way to bounce arbitrary traffic off Niobe's own booking API.
  stub.simplespaDown = true;                       // would cause a 503 if it were called
  try {
    const res = await post('/balance', { code: 'SELECT * FROM users' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /doesn't look like a gift card code/i);
  } finally { stub.simplespaDown = false; }
});

await test('an injected script is escaped, not executed', async () => {
  // The payload has to survive normaliseCode, which upper-cases and strips whitespace.
  // An earlier version of this test asserted the lower-case string was absent and so
  // passed even with the escaper switched off entirely — it was measuring the
  // upper-casing, not the escaping. HTML tag names are case-insensitive, so <SCRIPT>
  // runs perfectly well.
  // The quote sits mid-string on purpose: normaliseCode strips leading and trailing
  // quotes (people paste codes out of WhatsApp with them), so a payload that starts
  // with one never reaches the escaper and proves nothing about it.
  const payload = 'AB"><script>alert(1)</script>';
  const body = await (await post('/balance', { code: payload })).text();

  // These pages contain no scripts of their own, so ANY script tag came from the input.
  assert.equal(/<\s*script/i.test(body), false, 'an injected <script> tag reached the page');
  assert.match(body, /&lt;SCRIPT&gt;/, 'the payload should appear escaped, so we know it was reflected at all');
  // And specifically: the quote must not break out of the value="" attribute.
  assert.match(body, /value="[^"]*&quot;/, 'the quote in the payload was not escaped inside the attribute');
});

await test('an empty code asks for one rather than erroring', async () => {
  const res = await post('/balance', { code: '   ' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Please enter your code/i);
});

// --- rate limiting ------------------------------------------------------------
// Exercised directly against the limiter with its own numbers: driving the HTTP
// endpoint hundreds of times to reach a production threshold makes for a slow and
// flaky test, and the thing worth testing is the limiter's logic.

const { createLimiter, clientIp } = await import('../src/ratelimit.js');

await test('the limiter blocks past the window and recovers after it', () => {
  const lim = createLimiter([{ ms: 1000, max: 3, label: 'second' }]);
  const t0 = 1_000_000;
  assert.equal(lim.check('a', t0).ok, true);
  assert.equal(lim.check('a', t0 + 1).ok, true);
  assert.equal(lim.check('a', t0 + 2).ok, true);
  const blocked = lim.check('a', t0 + 3);
  assert.equal(blocked.ok, false, 'the fourth attempt in the window must be refused');
  assert.equal(blocked.retryAfterSec >= 1, true);
  // A different visitor is unaffected.
  assert.equal(lim.check('b', t0 + 3).ok, true);
  // And once the window has passed, the original visitor is let back in.
  assert.equal(lim.check('a', t0 + 1500).ok, true);
});

await test('blocked attempts do not extend the lockout', () => {
  // Otherwise someone who mistypes repeatedly is locked out for the whole window,
  // renewed on every attempt — the customer this page is for is the one who cannot
  // read their own card.
  const lim = createLimiter([{ ms: 1000, max: 2 }]);
  const t0 = 2_000_000;
  lim.check('a', t0); lim.check('a', t0 + 1);
  for (let i = 0; i < 20; i++) lim.check('a', t0 + 10 + i);      // hammering, all blocked
  assert.equal(lim.check('a', t0 + 1001).ok, true, 'the lockout was extended by refused attempts');
});

await test('both windows are enforced, not just the short one', () => {
  const lim = createLimiter([
    { ms: 1000, max: 5, label: 'second' },
    { ms: 100_000, max: 6, label: 'long' },
  ]);
  let t = 3_000_000;
  for (let i = 0; i < 6; i++) { assert.equal(lim.check('a', t).ok, true); t += 400; }
  // Short window is satisfied by the spacing; the long window is now full.
  const r = lim.check('a', t);
  assert.equal(r.ok, false);
  assert.equal(r.window, 'long', 'the long window should be the one that refuses');
});

await test('X-Forwarded-For is read from the RIGHT, so it cannot be spoofed', () => {
  // nginx appends the real peer, so the last entry is the only trustworthy one.
  // Reading the first — the common mistake — lets a caller invent a new identity per
  // request and bypass the limiter entirely.
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 41.66.0.9' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIp(req), '41.66.0.9');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '41.66.0.9' } }), '41.66.0.9');
});

await test('a spoofed X-Forwarded-For does not get a fresh allowance', async () => {
  // Same real peer, different claimed origin each time: all must count as one visitor.
  const lim = createLimiter([{ ms: 60_000, max: 2 }]);
  const ipOf = (claim) => clientIp({ headers: { 'x-forwarded-for': `${claim}, 41.66.0.9` }, socket: {} });
  const t = 4_000_000;
  assert.equal(lim.check(ipOf('9.9.9.1'), t).ok, true);
  assert.equal(lim.check(ipOf('9.9.9.2'), t).ok, true);
  assert.equal(lim.check(ipOf('9.9.9.3'), t).ok, false, 'rotating the header bought extra attempts');
});

await test('the live endpoint actually refuses past its limit, with 429 + Retry-After', async () => {
  const { _limiterForTests } = await import('../src/balance.js');
  const lim = _limiterForTests.limiter;
  lim.reset();
  try {
    // Burn the minute allowance (100 in this test env) on a shape-invalid code, which
    // costs nothing upstream but still counts.
    let last;
    for (let i = 0; i < 101; i++) last = await post('/balance', { code: 'ZZZZ' });
    assert.equal(last.status, 429, 'the endpoint kept answering past its own limit');
    assert.equal(Number(last.headers.get('retry-after')) > 0, true);
    assert.match(await last.text(), /Too many attempts/i);
  } finally { lim.reset(); }
});

// --- report --------------------------------------------------------------------
console.log('\nBalance page\n');
console.log(results.join('\n'));
console.log(`\n${passed}/${results.length} passed\n`);

stubServer.close();
rmSync(dir, { recursive: true, force: true });
process.exit(process.exitCode || 0);
