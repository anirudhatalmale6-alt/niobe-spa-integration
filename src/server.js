import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { CONFIG, branchById } from './config.js';
import { getConsolidatedStock } from './stock.js';
import { getUnifiedAvailability, listServiceNames } from './availability.js';
import { getBooking, bookingDeposit, startDeposit, finalizeDeposit, listBookings, getPayment, lookupBookings, claimAccountCredit } from './bookings.js';
import { startPurchase, finalizePurchase, getPurchase } from './giftcards.js';
import { sweepAll, listHolds, startSweepLoop, secureAndConfirm } from './holds.js';
import { getCatalog } from './giftup.js';
import { verifyWebhookSignature, parseWebhookEvent, displayName as gatewayName } from './gateway.js';
import { renderPayPage, renderCheckout, renderSuccess, renderPhoneEntry, renderChooser, renderNoMatch, renderCreditClaim, renderGiftCardPage, renderGiftCheckout, renderGiftCardSuccess, renderGiftCardPending } from './views.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' };

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const html = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'text/html' }); res.end(body); };
const redirect = (res, url) => { res.writeHead(302, { Location: url }); res.end(); };

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''; req.on('data', (c) => (data += c)); req.on('end', () => resolve(data));
  });
}
function parseBody(raw, contentType = '') {
  if (contentType.includes('application/json')) { try { return JSON.parse(raw || '{}'); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // --- JSON API ---
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, demoMode: CONFIG.demoMode, gateway: gatewayName, paymentDemo: CONFIG.paymentDemo });
    if (req.method === 'GET' && p === '/api/stock') return json(res, 200, await getConsolidatedStock());
    if (req.method === 'GET' && p === '/api/bookings') return json(res, 200, listBookings());
    if (req.method === 'GET' && p === '/api/services') return json(res, 200, await listServiceNames());
    if (req.method === 'GET' && p === '/api/availability') {
      const q = url.searchParams;
      const data = await getUnifiedAvailability({
        serviceName: q.get('service') || undefined,
        serviceId: q.get('serviceId') || undefined,
        date: q.get('date') || undefined,
        branchId: q.get('branch') || undefined,
      });
      return json(res, 200, data);
    }

    // --- Secure-or-release (no-show) engine ---
    // Read-only sweep report: what's within grace, what would be / was released.
    // Safe to call any time — honours DRY_RUN, only writes when armed live.
    if (req.method === 'GET' && p === '/api/holds/sweep') return json(res, 200, await sweepAll());
    if (req.method === 'GET' && p === '/api/holds') return json(res, 200, listHolds());
    // Staff route: verify a non-cash secure (account credit / existing gift card /
    // prepaid package / bank transfer) and confirm the appointment in one step.
    if (req.method === 'POST' && p === '/api/holds/secure') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      return json(res, 200, await secureAndConfirm(body.appointment_id, { branchId: body.branchId, reason: body.reason, by: body.by }));
    }

    // --- Deposit flow (customer-facing) ---
    if (req.method === 'GET' && p === '/pay') {
      // Direct booking id (chooser links use this)
      const bookingId = url.searchParams.get('booking');
      if (bookingId) {
        const bd = await bookingDeposit(bookingId);
        if (!bd) return html(res, 404, 'Booking not found');
        return html(res, 200, renderPayPage(bd));
      }
      // Email deposit link: branch (b) + optional pre-filled phone (ph=[CLIENT_PHONE]).
      const b = url.searchParams.get('b') || '';
      const branchName = branchById(b)?.name;
      const ph = url.searchParams.get('ph');
      if (!ph) return html(res, 200, renderPhoneEntry(b, branchName));
      const matches = await lookupBookings({ branchId: b, phone: ph });
      if (matches.length === 1) return html(res, 200, renderPayPage(await bookingDeposit(matches[0].id)));
      if (matches.length > 1) return html(res, 200, renderChooser(matches, branchName));
      return html(res, 200, renderNoMatch(b, branchName));
    }
    if (req.method === 'POST' && p === '/pay/start') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const { authorization_url } = await startDeposit(body.bookingId, body.option, body.gateway);
      return redirect(res, authorization_url);
    }
    if (req.method === 'POST' && p === '/pay/credit-claim') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const b = await claimAccountCredit(body.bookingId);
      if (!b) return html(res, 404, 'Booking not found');
      return html(res, 200, renderCreditClaim(b));
    }
    if (req.method === 'GET' && p === '/demo/checkout') {
      const reference = url.searchParams.get('reference');
      // The same simulated checkout serves both booking deposits and gift-card purchases.
      const pur = getPurchase(reference);
      if (pur) return html(res, 200, renderGiftCheckout(pur));
      const pay = getPayment(reference);
      if (!pay) return html(res, 404, 'Unknown reference');
      return html(res, 200, renderCheckout(pay, await getBooking(pay.bookingId)));
    }
    if (req.method === 'POST' && p === '/demo/pay') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const ref = body.reference;
      // Route the simulated "paid" back to the right finaliser (gift-card sale vs booking deposit).
      const dest = getPurchase(ref) ? '/gift-card/callback' : '/pay/callback';
      return redirect(res, `${dest}?reference=${encodeURIComponent(ref)}`);
    }

    // --- Online gift-card purchase ---
    if (req.method === 'GET' && p === '/gift-card') {
      return html(res, 200, renderGiftCardPage(await getCatalog()));
    }
    if (req.method === 'POST' && p === '/gift-card/start') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      try {
        const { authorization_url } = await startPurchase(body, body.gateway);
        return redirect(res, authorization_url);
      } catch (e) {
        // Show the buyer a friendly message on the form rather than a raw error.
        return html(res, 400, renderGiftCardPage(await getCatalog(), e.message || 'Something went wrong — please check your details and try again.'));
      }
    }
    if (req.method === 'GET' && p === '/gift-card/callback') {
      // Try to finalise on the browser return, but mobile-money can settle a few seconds later,
      // so if it's not confirmed yet we show a friendly "confirming" page — the Hubtel webhook
      // (server-to-server) issues the card the moment payment clears, so no purchase is lost.
      let result;
      try { result = await finalizePurchase(url.searchParams.get('reference')); }
      catch { result = { ok: false }; }
      if (result.ok) return html(res, 200, renderGiftCardSuccess(result));
      return html(res, 200, renderGiftCardPending());
    }
    if (req.method === 'GET' && p === '/pay/callback') {
      const result = await finalizeDeposit(url.searchParams.get('reference'));
      if (!result.ok) return html(res, 402, 'Payment was not completed. Please try again.');
      return html(res, 200, renderSuccess(result));
    }

    // --- Payment webhook (live) — gateway-independent ---
    // /webhook/payment is the generic route; /webhook/paystack kept as a backward-compatible alias.
    if (req.method === 'POST' && (p === '/webhook/payment' || p === '/webhook/paystack')) {
      const raw = await readBody(req);
      const event = parseWebhookEvent(raw);
      const ref = event.reference;
      // Same webhook serves booking deposits AND gift-card sales — route by which one owns the ref.
      const purchase = ref ? getPurchase(ref) : null;
      const pay = ref ? getPayment(ref) : null;
      const gw = purchase?.gateway || pay?.gateway || event.gateway;
      if (!verifyWebhookSignature(gw, raw, req.headers['x-paystack-signature'])) return json(res, 401, { error: 'bad signature' });
      console.log(`[webhook] ref=${ref} success=${event.isPaymentSuccess} kind=${purchase ? 'giftcard' : pay ? 'deposit' : 'unknown'}`);
      if (event.isPaymentSuccess && ref) {
        // finalize* re-verifies the payment via the gateway's status API before acting.
        try {
          if (purchase) await finalizePurchase(ref);   // issue the gift card
          else await finalizeDeposit(ref);             // confirm the booking
        } catch (e) { console.log(`[webhook] finalize error ref=${ref}: ${e.message}`); }
      }
      return json(res, 200, { received: true });
    }

    // --- Static files (stock dashboard etc.) ---
    let file = join(PUBLIC, p === '/' ? '/index.html' : p);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
    const bodyBuf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(bodyBuf);
  } catch (err) {
    if (err.code === 'ENOENT') { res.writeHead(404); return res.end('Not found'); }
    json(res, 500, { error: err.message });
  }
});

server.listen(CONFIG.port, () => {
  console.log(`Niobe integration on http://localhost:${CONFIG.port}  (stock demo=${CONFIG.demoMode}, gateway=${gatewayName}, payment demo=${CONFIG.paymentDemo})`);
  // Start the secure-or-release sweep (no-op unless RELEASE_ENABLED=true).
  startSweepLoop();
});
