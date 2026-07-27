import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { CONFIG } from './config.js';
import { getConsolidatedStock } from './stock.js';
import { getBooking, bookingDeposit, startDeposit, finalizeDeposit, listBookings } from './bookings.js';
import { verifyWebhookSignature } from './paystack.js';
import { renderPayPage, renderCheckout, renderSuccess } from './views.js';

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
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, demoMode: CONFIG.demoMode, paystackDemo: CONFIG.paystackDemo });
    if (req.method === 'GET' && p === '/api/stock') return json(res, 200, await getConsolidatedStock());
    if (req.method === 'GET' && p === '/api/bookings') return json(res, 200, listBookings());

    // --- Deposit flow (customer-facing) ---
    if (req.method === 'GET' && p === '/pay') {
      const bd = bookingDeposit(url.searchParams.get('booking'));
      if (!bd) return html(res, 404, 'Booking not found');
      return html(res, 200, renderPayPage(bd));
    }
    if (req.method === 'POST' && p === '/pay/start') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      const { authorization_url } = await startDeposit(body.bookingId, body.option);
      return redirect(res, authorization_url);
    }
    if (req.method === 'GET' && p === '/demo/checkout') {
      const ref = url.searchParams.get('reference');
      const { getPayment } = await import('./bookings.js');
      const pay = getPayment(ref);
      if (!pay) return html(res, 404, 'Unknown reference');
      return html(res, 200, renderCheckout(pay, getBooking(pay.bookingId)));
    }
    if (req.method === 'POST' && p === '/demo/pay') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      return redirect(res, `/pay/callback?reference=${encodeURIComponent(body.reference)}`);
    }
    if (req.method === 'GET' && p === '/pay/callback') {
      const result = await finalizeDeposit(url.searchParams.get('reference'));
      if (!result.ok) return html(res, 402, 'Payment was not completed. Please try again.');
      return html(res, 200, renderSuccess(result));
    }

    // --- Paystack webhook (live) ---
    if (req.method === 'POST' && p === '/webhook/paystack') {
      const raw = await readBody(req);
      if (!verifyWebhookSignature(raw, req.headers['x-paystack-signature'])) return json(res, 401, { error: 'bad signature' });
      const event = JSON.parse(raw || '{}');
      if (event.event === 'charge.success') {
        try { await finalizeDeposit(event.data.reference); } catch (e) { /* logged; respond 200 so Paystack stops retrying */ }
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
  console.log(`Niobe integration on http://localhost:${CONFIG.port}  (stock demo=${CONFIG.demoMode}, paystack demo=${CONFIG.paystackDemo})`);
});
