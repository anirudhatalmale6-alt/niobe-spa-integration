import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { CONFIG } from './config.js';
import { getConsolidatedStock } from './stock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' };

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost`);
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, demoMode: CONFIG.demoMode });
    if (url.pathname === '/api/stock') {
      const data = await getConsolidatedStock();
      return json(res, 200, data);
    }
    // static files
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(PUBLIC, p);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT') { res.writeHead(404); return res.end('Not found'); }
    json(res, 500, { error: err.message });
  }
});

server.listen(CONFIG.port, () => {
  console.log(`Niobe integration running on http://localhost:${CONFIG.port}  (demoMode=${CONFIG.demoMode})`);
});
