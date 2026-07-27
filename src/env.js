import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Minimal .env loader (keeps the service dependency-free — just `node src/server.js`).
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envPath = join(__dirname, '..', '.env');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim();
    const val = s.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
} catch { /* no .env — rely on real environment variables */ }
