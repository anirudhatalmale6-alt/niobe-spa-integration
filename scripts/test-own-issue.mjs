// Tests for issuing gift cards from Niobe's OWN ledger rather than GiftUp's — the price list,
// the voucher, and the decision about who a voucher is sent to.
//
// The lifecycle itself (reserve -> paid, expiry, extensions, spending) is already covered by
// test-cards.mjs and is not repeated here. What is new, and what this file is for, is the
// machinery that only exists because we became the issuer: a package list of our own, artwork
// of our own, and a delivery decision GiftUp used to make for us.
//
// Run with:  node scripts/test-own-issue.mjs

process.env.NIOBE_DATA_DIR ||= '/tmp/niobe-own-issue-test';
process.env.GIFTCARD_PACKAGES_FILE ||= `${process.env.NIOBE_DATA_DIR}/gift-packages.json`;
process.env.PUBLIC_URL ||= 'https://pay.niobebeauty.com';

import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { CONFIG } from '../src/config.js';

const DIR = process.env.NIOBE_DATA_DIR;
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

let pass = 0, fail = 0;
const logs = [];
const realLog = console.log;
// Several of the rules below are enforced BY a log line — a dropped package is dropped
// silently as far as the return value is concerned, and the log is the only place it says
// which one and why. So the log is part of the behaviour under test, not noise.
console.log = (...a) => { logs.push(a.join(' ')); };
function say(...a) { realLog(...a); }

function ok(name, cond, detail = '') {
  if (cond) { pass++; say(`  ok   ${name}`); }
  else { fail++; say(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function writePackages(obj) {
  writeFileSync(process.env.GIFTCARD_PACKAGES_FILE, JSON.stringify(obj, null, 1));
}

// --- the price list ---------------------------------------------------------
say('\nThe package list');
{
  const { getOwnCatalog } = await import('../src/packages.js');

  writePackages([
    { name: 'Classic Facial', value: 450 },
    { name: 'Swedish Massage', value: 600 },
  ]);
  let cat = getOwnCatalog({ fresh: true });
  ok('a package list is read from the file, not from GiftUp',
    cat.items.length === 2 && cat.source === 'file', JSON.stringify(cat.items));
  ok('a package id is derived from its name, so it survives an edit to the list',
    cat.items[0].id === 'classic-facial', cat.items[0].id);

  // The one that matters most. A blank price is somebody halfway through editing a
  // spreadsheet; treating it as zero sells a card for nothing that is then worth nothing.
  logs.length = 0;
  writePackages([
    { name: 'Classic Facial', value: 450 },
    { name: 'Half-written Package', value: '' },
    { name: 'Zero Package', value: 0 },
    { name: 'No Price At All' },
    { value: 300 },                      // a row with a price and no name is equally unusable
  ]);
  cat = getOwnCatalog({ fresh: true });
  ok('a package with a blank price is dropped, not sold for nothing',
    cat.items.length === 1 && cat.items[0].name === 'Classic Facial',
    cat.items.map((i) => i.name).join(', '));
  ok('and it says WHICH package it dropped and why',
    logs.some((l) => l.includes('Half-written Package'))
      && logs.some((l) => l.includes('Zero Package'))
      && logs.some((l) => l.includes('No Price At All'))
      && logs.some((l) => l.includes('has no name')),
    logs.join(' | '));

  logs.length = 0;
  writePackages([
    { name: 'Facial', value: 400 },
    { name: 'Facial', value: 900 },
  ]);
  cat = getOwnCatalog({ fresh: true });
  ok('two packages cannot share an id — one is unsellable and invisible otherwise',
    cat.items.length === 1 && cat.items[0].value === 400);
  ok('and the duplicate is named in the log rather than vanishing',
    logs.some((l) => l.includes('already used by')), logs.join(' | '));

  logs.length = 0;
  writePackages([
    { name: 'Too Cheap', value: 1 },
    { name: 'Too Dear', value: 9_999_999 },
    { name: 'Just Right', value: 500 },
  ]);
  cat = getOwnCatalog({ fresh: true });
  ok('a price outside the permitted range is refused at the list, not at the checkout',
    cat.items.length === 1 && cat.items[0].name === 'Just Right',
    cat.items.map((i) => i.name).join(', '));

  logs.length = 0;
  rmSync(process.env.GIFTCARD_PACKAGES_FILE, { force: true });
  cat = getOwnCatalog({ fresh: true });
  ok('with no list at all the checkout still works, on plain amounts',
    cat.source === 'default' && cat.items.length > 0 && cat.items.every((i) => i.value > 0));
  ok('and it says so, so an empty-looking checkout is never a mystery',
    logs.some((l) => l.includes('no package list')), logs.join(' | '));
  ok('a custom amount needs no item to hang off, unlike the GiftUp route',
    cat.customItemId === null);

  // An empty category renders as a heading with nothing under it, which reads to a customer
  // as something that failed to load.
  writePackages({
    groups: [{ id: 'face', name: 'Facials' }, { id: 'body', name: 'Body' }],
    items: [{ name: 'Classic Facial', value: 450, groupId: 'face' }],
  });
  cat = getOwnCatalog({ fresh: true });
  ok('a category with nothing in it is not offered',
    cat.groups.length === 1 && cat.groups[0].id === 'face',
    cat.groups.map((g) => g.id).join(', '));
}

// --- the voucher ------------------------------------------------------------
say('\nThe voucher');
{
  const { designs, resolveDesign, voucherHtml } = await import('../src/voucher.js');

  const list = designs();
  ok('Niobe\'s own designs are available to choose from', list.length >= 11, `${list.length} found`);
  ok('the most-chosen design leads the list and is therefore the default',
    list[0]?.id === 'add-01', list[0]?.id);

  logs.length = 0;
  const d = resolveDesign('add-33');
  ok('a chosen design is the one that gets used', d.id === 'add-33' && d.name === 'To my wife');

  logs.length = 0;
  const fallback = resolveDesign('a-design-that-was-deleted');
  ok('a design that no longer exists falls back rather than failing a paid card',
    fallback.id === 'add-01');
  ok('and the substitution is logged, not silent',
    logs.some((l) => l.includes('is not available')), logs.join(' | '));

  const html = voucherHtml({
    code: 'NB-ABCD-EFGH-JKMN', value: 500, expiresAt: '2026-12-04T10:00:00.000Z',
    design: 'add-33', recipientName: 'Ama', buyerName: 'Kwesi', message: 'Happy birthday',
  });
  ok('the voucher carries the code', html.includes('NB-ABCD-EFGH-JKMN'));
  ok('the voucher carries the value', html.includes('GHS 500.00'));
  // Written out in full: a voucher is read by someone who did not buy it, and 04/12 and 12/04
  // are the same six characters to two different people.
  ok('the expiry is written out in full, not as an ambiguous numeric date',
    html.includes('4 December 2026'), html.match(/Valid until[^<]*<strong>([^<]*)/)?.[1]);
  ok('the chosen artwork is referenced', html.includes('/designs/add-33.jpg'));
  ok('the personal message is on it', html.includes('Happy birthday'));

  // An email client that blocks images shows no artwork at all. If the value or the code
  // only existed inside the picture, the voucher would arrive blank.
  const noArt = html.replace(/<img[^>]*>/g, '');
  ok('the code and value survive an email client that blocks images',
    noArt.includes('NB-ABCD-EFGH-JKMN') && noArt.includes('GHS 500.00'));

  const nasty = voucherHtml({ code: 'NB-TEST', value: 100, message: '<script>alert(1)</script>' });
  ok('a message typed by the buyer cannot inject markup into the voucher',
    !nasty.includes('<script>') && nasty.includes('&lt;script&gt;'));
}

// --- who gets it ------------------------------------------------------------
say('\nWho the voucher is sent to');
{
  const { voucherRecipient } = await import('../src/giftcards.js');
  const base = { buyerEmail: 'buyer@example.com', recipientEmail: 'recipient@example.com' };

  ok('an emailed gift goes to the recipient',
    voucherRecipient({ ...base, gift: true, delivery: 'email' }).to === 'recipient@example.com');

  ok('a card bought for yourself goes to you, not to a stale recipient address',
    voucherRecipient({ ...base, gift: false, delivery: 'email' }).to === 'buyer@example.com');

  // The surprise-ruining case. "Print it myself" means the buyer is handing it over in
  // person; emailing the recipient would tell them about their own present.
  ok('a gift the buyer is printing goes to the BUYER, so the surprise survives',
    voucherRecipient({ ...base, gift: true, delivery: 'print' }).to === 'buyer@example.com');

  ok('a gift the buyer will forward on WhatsApp also goes to the buyer',
    voucherRecipient({ ...base, gift: true, delivery: 'whatsapp' }).to === 'buyer@example.com');

  ok('a gift with no recipient address falls back to the buyer rather than nowhere',
    voucherRecipient({ buyerEmail: 'buyer@example.com', gift: true, delivery: 'email' }).to
      === 'buyer@example.com');
}

// --- the switch -------------------------------------------------------------
say('\nThe issuer switch');
{
  ok('the default issuer is GiftUp, so deploying this changes nothing on its own',
    CONFIG.giftcardIssuer === 'giftup', CONFIG.giftcardIssuer);
}

console.log = realLog;
say(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
