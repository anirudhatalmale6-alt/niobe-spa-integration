import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CONFIG } from './config.js';

// The gift-card DESIGNS, and the voucher built out of one.
//
// This is the half GiftUp used to do for us: take a paid card and turn it into something a
// person is happy to receive. It is also the reason there was no design picker on the
// checkout — on the GiftUp route the design is inherited from the same field that carries the
// chosen package, so there was nowhere for a picker's answer to go. Issuing the card
// ourselves is what makes the choice expressible at all.

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN_DIR = join(HERE, '..', 'public', 'designs');

// Niobe's own artwork, carried over from the retired gift-card site.
//
// The ORDER is the order they are offered in, and it is not alphabetical or arbitrary: the
// retired system recorded how many times each design had actually been chosen, and `picks` is
// that count. The classic gold ribbon was picked 600 times against 22 for the next most
// popular — not a close race — so it leads and it is the default. Keeping the number here
// rather than only the ordering means the next person can check the order against its evidence
// instead of taking it on trust, and can re-sort it when Niobe has counts of her own.
//
// Ties (28/31 at two picks, 33/34/35 at one) are in file order; there is nothing to choose
// between them and pretending otherwise would be inventing a preference.
const CATALOGUE = [
  { id: 'add-01', name: 'Classic gold ribbon', file: 'add-01.jpg', picks: 600 },
  { id: 'add-10', name: 'Midnight & gold',     file: 'add-10.jpg', picks: 22 },
  { id: 'add-12', name: 'Gold bow',            file: 'add-12.jpg', picks: 18 },
  { id: 'add-13', name: 'Red gift box',        file: 'add-13.jpg', picks: 18 },
  { id: 'add-16', name: 'I love you',          file: 'add-16.jpg', picks: 14 },
  { id: 'add-20', name: 'To a special friend', file: 'add-20.jpg', picks: 10 },
  { id: 'add-28', name: 'To my husband',       file: 'add-28.jpg', picks: 2 },
  { id: 'add-31', name: 'To my lover',         file: 'add-31.jpg', picks: 2 },
  { id: 'add-33', name: 'To my wife',          file: 'add-33.jpg', picks: 1 },
  { id: 'add-34', name: 'Botanical white',     file: 'add-34.jpg', picks: 1 },
  { id: 'add-35', name: 'Black & gold',        file: 'add-35.jpg', picks: 1 },
];

// Only offer a design whose file is actually on disk. A picker that shows eleven options and
// renders a broken image for one of them is worse than a picker that shows ten: the customer
// has already chosen by the time they find out, and the voucher is what breaks.
let available = null;
export function designs() {
  if (available) return available;
  let onDisk = new Set();
  try {
    onDisk = new Set(readdirSync(DESIGN_DIR));
  } catch {
    console.log(`[voucher] WARNING no design directory at ${DESIGN_DIR} — vouchers will use the plain branded layout.`);
  }
  available = CATALOGUE.filter((d) => onDisk.has(d.file));
  const missing = CATALOGUE.filter((d) => !onDisk.has(d.file)).map((d) => d.file);
  if (missing.length) console.log(`[voucher] ${missing.length} design(s) not on disk, not offered: ${missing.join(', ')}`);
  return available;
}

// Resolve a chosen design id to something renderable. An unknown or missing id falls back to
// the first available design rather than failing — the card is paid for, and a voucher in the
// wrong artwork is recoverable in a way "no voucher" is not. It says so in the log.
export function resolveDesign(id) {
  const list = designs();
  if (!list.length) return null;
  const wanted = String(id || '').trim();
  const found = list.find((d) => d.id === wanted);
  // 'default' and '' both mean "the buyer did not choose" — which is the normal case until the
  // picker is on the form, and is not worth a warning on every single card. Only a design that
  // was actually ASKED FOR and could not be honoured gets logged, because that one means an id
  // has gone stale somewhere and someone should know.
  if (wanted && wanted !== 'default' && !found) {
    console.log(`[voucher] design "${wanted}" is not available — using "${list[0].id}".`);
  }
  return found || list[0];
}

export const DEFAULT_DESIGN = () => designs()[0]?.id || 'default';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ghs = (n) => `GHS ${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// "4 December 2026". Written out rather than 04/12/2026, because a voucher is read by someone
// who did not buy it and may not share the buyer's idea of which number is the month.
const longDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

// The voucher itself. Deliberately ONE self-contained HTML document with inline styles and no
// external stylesheet, because it has to survive three very different renderers: an email
// client (which strips <style> blocks and knows nothing about flexbox), a browser, and a
// printer. Anything clever here fails in at least one of them.
//
// The design image is referenced by absolute URL rather than embedded, so the same document
// works as a web page and as an email without being megabytes of base64. An email client that
// blocks images by default therefore shows the voucher WITHOUT the artwork — which is exactly
// why the code, the value and the expiry are live text below the image and never baked into it.
export function voucherHtml({
  code, value, currency = 'GHS', expiresAt, design, recipientName, buyerName, message, packageName,
} = {}) {
  const d = resolveDesign(design);
  const base = (CONFIG.publicUrl || '').replace(/\/+$/, '');
  const art = d ? `${base}/designs/${d.file}` : null;
  const expiry = longDate(expiresAt);
  const to = String(recipientName || '').trim();
  const from = String(buyerName || '').trim();

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Niobe gift card</title></head>
<body style="margin:0;padding:24px 12px;background:#f6f1ec;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#2b2320">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="width:100%;max-width:560px;margin:0 auto">
 <tr><td style="background:#2b2926;padding:18px 20px;text-align:center;border-radius:14px 14px 0 0">
   <img src="${esc(base)}/brand/logo.png" alt="Niobe Salon &amp; Spa" width="150" style="height:auto;display:inline-block;border:0">
 </td></tr>
 <tr><td style="background:#fffdfb;padding:0;border-left:1px solid #e9ddd2;border-right:1px solid #e9ddd2">
   ${art ? `<img src="${esc(art)}" alt="${esc(d.name)}" width="558" style="width:100%;height:auto;display:block;border:0">` : ''}
 </td></tr>
 <tr><td style="background:#fffdfb;padding:22px 24px 6px;border-left:1px solid #e9ddd2;border-right:1px solid #e9ddd2;text-align:center">
   ${to ? `<div style="font-size:15px;color:#8b7d73">For ${esc(to)}</div>` : ''}
   <div style="font-size:12px;letter-spacing:1.6px;text-transform:uppercase;color:#8a6a3c;font-weight:600;margin-top:10px">Gift card</div>
   <div style="font-size:34px;font-weight:700;color:#2b2320;margin:2px 0 4px">${esc(ghs(value))}</div>
   ${packageName ? `<div style="font-size:14px;color:#8b7d73">${esc(packageName)}</div>` : ''}
   ${message ? `<div style="font-size:15px;color:#2b2320;font-style:italic;margin:14px auto 0;max-width:400px;line-height:1.5">&ldquo;${esc(message)}&rdquo;</div>` : ''}
   ${from ? `<div style="font-size:14px;color:#8b7d73;margin-top:8px">from ${esc(from)}</div>` : ''}
 </td></tr>
 <tr><td style="background:#fffdfb;padding:16px 24px 24px;border-left:1px solid #e9ddd2;border-right:1px solid #e9ddd2;text-align:center">
   <div style="border:1.5px dashed #b08a54;border-radius:12px;padding:14px 10px;margin:8px 0 0;background:#fdf8f1">
     <div style="font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#8b7d73;font-weight:600">Your code</div>
     <div style="font-size:25px;font-weight:700;letter-spacing:2px;color:#2b2320;margin-top:5px;font-family:Consolas,'Courier New',monospace">${esc(code)}</div>
   </div>
   ${expiry ? `<div style="font-size:14px;color:#2b2320;margin-top:14px">Valid until <strong>${esc(expiry)}</strong></div>` : ''}
   <div style="font-size:13px;color:#8b7d73;margin-top:6px;line-height:1.55">
     Quote this code when you book, or hand it in at any Niobe branch.<br>
     Check the balance any time at <a href="${esc(base)}/balance" style="color:#8a6a3c">${esc((base || '').replace(/^https?:\/\//, ''))}/balance</a>
   </div>
 </td></tr>
 <tr><td style="background:#2b2926;color:#ddd2c7;padding:16px 20px;border-radius:0 0 14px 14px;text-align:center;font-size:12px;line-height:1.7">
   East Legon &middot; Cantonments &middot; African Regent Hotel &middot; HFC Community 18 &middot; Alisa Hotel Tema<br>
   <a href="https://niobebeauty.com" style="color:#ddd2c7">niobebeauty.com</a>
 </td></tr>
</table>
</body></html>`;
}

// The covering email. Kept separate from the voucher because they are two different documents
// with two different jobs: this one says who it is from and what to do next, and the voucher is
// the thing you forward, print or show at the desk.
export function voucherEmail({ card, buyerName, forSelf }) {
  const to = String(card.recipientName || '').trim();
  const subject = forSelf
    ? `Your Niobe gift card — ${ghs(card.faceValue)}`
    : `${String(buyerName || 'Someone').trim()} has sent you a Niobe gift card`;
  const intro = forSelf
    ? 'Here is your gift card. The code below is the card — treat it like cash.'
    : `${esc(String(buyerName || 'Someone').trim())} has sent you a Niobe gift card${to ? `, ${esc(to)}` : ''}.`;
  return {
    subject,
    html: `<p style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;color:#2b2320">${intro}</p>`
      + voucherHtml({
        code: card.code, value: card.faceValue, expiresAt: card.expiresAt, design: card.design,
        recipientName: card.recipientName, buyerName, message: card.message,
      }),
  };
}
