// Extended gift cards at the deposit page.
//
// Branch staff sell paid extensions in SimpleSpa only; GiftUp keeps the card's original
// expiry. The deposit page used to refuse on GiftUp's word alone, so a customer who had
// paid for an extension was told their card had expired (reported 12 Oct 2026; 14 such
// cards live that day). These tests pin the decision: GiftUp-expired is checked against
// SimpleSpa before anyone is turned away, and never more generously than either ledger.
//
// No network: GiftUp and SimpleSpa are answered by a stubbed fetch, bookings are demo ones.
process.env.DEMO_MODE = 'true';
process.env.GIFTUP_API_KEY ||= 'test-key';
// Every branch needs a key or ssPost throws before reaching the stub — which would make
// each SimpleSpa case below pass for the wrong reason ("unreachable" looks like "absent").
for (const k of ['EAST_LEGON', 'CANTONMENTS', 'AFRICAN_REGENT', 'HFC_C18', 'ALISA_HOTEL']) process.env[`${k}_KEY`] = 'test';

const GU = new Map();          // code -> GiftUp card body
const SS = new Map();          // code -> SimpleSpa gift_cards row, or 'throw'
let ssCalls = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.startsWith('https://api.giftup.app/gift-cards/')) {
    const code = decodeURIComponent(u.split('/gift-cards/')[1]);
    return GU.has(code) ? json(200, GU.get(code)) : json(404, {});
  }
  if (u.endsWith('/giftcards.php')) {
    ssCalls++;
    const body = JSON.parse(opts.body || '{}');
    const row = SS.get(body.code);
    if (row === 'throw') throw new Error('SimpleSpa unreachable');
    return json(200, { success: true, gift_cards: row ? [row] : [] });
  }
  throw new Error('unexpected fetch ' + u);
};

const { listBookings } = await import('../src/bookings.js');
const { checkGiftCard } = await import('../src/redeem.js');
const { renderGiftRedeemManual } = await import('../src/views.js');

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); };

const booking = listBookings().find((b) => b.price > 0);
ok(!!booking, 'a demo booking exists to test against');
const gu = (code, { expired = false, balance = 500 } = {}) => GU.set(code, {
  code, title: 'Gift card', remainingValue: balance, backingType: 'Currency',
  canBeRedeemed: !expired, hasExpired: expired, isVoided: false,
});
const ss = (code, { balance = 500, expired = false, expires = '2026-12-12 23:59:59' } = {}) => SS.set(code, {
  giftcard_id: 1, code, balance, initial_balance: 500, is_expired: expired ? 1 : 0, expires_at: expires, template_name: 'ALISA Gift Certificates',
});

// 1. The reported case: expired in GiftUp, extended (and unspent) in SimpleSpa.
gu('EXT01', { expired: true, balance: 550 }); ss('EXT01', { balance: 430 });
let r = await checkGiftCard({ bookingId: booking.id, code: 'EXT01' });
ok(r.reason === 'simplespa_manual', 'GiftUp-expired but extended in SimpleSpa is accepted for staff to apply (not "expired")');
ok(r.ssCard?.extended === true, 'the result says the card was extended');
ok(r.ssCard?.balance === 430, 'balance is the LOWER of the two ledgers (550 GiftUp / 430 SimpleSpa -> 430)');
ok(String(r.ssCard?.expiresAt).startsWith('2026-12-12'), 'the extended SimpleSpa date is the one carried forward');

// 2. Lower-of-two holds the other way round too.
gu('EXT02', { expired: true, balance: 200 }); ss('EXT02', { balance: 480 });
r = await checkGiftCard({ bookingId: booking.id, code: 'EXT02' });
ok(r.reason === 'simplespa_manual' && r.ssCard.balance === 200, 'never more generous than GiftUp either (200 GiftUp / 480 SimpleSpa -> 200)');

// 3. Genuinely expired in both: still refused.
gu('EXP01', { expired: true }); ss('EXP01', { expired: true, expires: '2026-09-01 23:59:59' });
r = await checkGiftCard({ bookingId: booking.id, code: 'EXP01' });
ok(r.reason === 'expired', 'expired in BOTH ledgers is still refused as expired');
ok(ssCalls > 0, 'SimpleSpa was actually asked (the stub is reachable)');

// 4. Extended but already spent at a till: refused.
gu('EXP02', { expired: true }); ss('EXP02', { balance: 0 });
r = await checkGiftCard({ bookingId: booking.id, code: 'EXP02' });
ok(r.reason === 'expired', 'extended-but-spent (SimpleSpa balance 0) is not accepted');

// 5. Expired in GiftUp, no SimpleSpa copy at all: refused.
gu('EXP03', { expired: true });
r = await checkGiftCard({ bookingId: booking.id, code: 'EXP03' });
ok(r.reason === 'expired', 'expired in GiftUp with no SimpleSpa record is refused');

// 6. SimpleSpa down: no crash, falls back to the old answer.
gu('EXP04', { expired: true }); SS.set('EXP04', 'throw');
r = await checkGiftCard({ bookingId: booking.id, code: 'EXP04' });
ok(r.reason === 'expired', 'SimpleSpa unreachable -> "expired" as before, no crash');

// 7. An ordinary in-date GiftUp card is untouched by this change.
gu('LIVE1', { balance: 5000 }); ss('LIVE1', { balance: 5000 });
r = await checkGiftCard({ bookingId: booking.id, code: 'LIVE1' });
ok(r.reason !== 'simplespa_manual' && r.reason !== 'expired', `an in-date GiftUp card still takes the automatic route (got ${r.ok ? 'ok' : r.reason})`);

// 8. What the customer reads.
gu('EXT01', { expired: true, balance: 550 }); ss('EXT01', { balance: 430 });
r = await checkGiftCard({ bookingId: booking.id, code: 'EXT01' });
const page = renderGiftRedeemManual(r);
ok(page.includes('has been extended'), 'page tells an extended-card holder why it is applied by hand');
ok(!page.includes('one of our earlier gift cards'), 'and does not call it an "earlier" card');
ok(page.includes('2026-12-12'), 'page shows the extended valid-until date');
const legacy = renderGiftRedeemManual({ booking, ssCard: { code: 'OLD-ABC', balance: 300, expiresAt: '2026-12-01' } });
ok(legacy.includes('one of our earlier gift cards'), 'a plain SimpleSpa card keeps its original wording');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
