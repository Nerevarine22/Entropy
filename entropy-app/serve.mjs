import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import path from 'node:path';
import { readLocalDataset, withLocalD1 } from './local-d1.mjs';
import leaderboard from '../entropy-cloud/leaderboard-worker.mjs';
const base = path.dirname(fileURLToPath(import.meta.url));
const allowed = new Set(['index.html', 'styles.css', 'scoring.js', 'model.js', 'seed.js', 'app.js', 'seed.json', 'experience.html', 'experience.css', 'experience.js', 'entropy-logo.png']);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
const previewEntries = new Map();
const previewCache = {
  async match(key) {
    const entry = previewEntries.get(key);
    return entry?.expires > Date.now() ? Response.json(entry.payload) : undefined;
  },
  async put(key, response) {
    for (const [name, entry] of previewEntries) {
      if (entry.expires <= Date.now()) previewEntries.delete(name);
    }
    previewEntries.set(key, { payload: await response.json(), expires: Date.now() + 30000 });
  },
};
const port = Number(process.env.ENTROPY_PORT || 8767);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некоректний ENTROPY_PORT.');
const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host === 'localhost:' + port ? req.headers.host : '127.0.0.1:' + port;
    const parsed = new URL(req.url, 'http://' + host);
    if (parsed.pathname === '/api/admin' || parsed.pathname === '/api/leaderboard') {
      const request = new Request(parsed, { method: req.method, headers: req.headers,
        ...(req.method === 'POST' ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
      const response = await withLocalD1(DB => leaderboard.fetch(request, { DB, previewCache,
        ENTROPY_ADMIN_SECRET: process.env.ENTROPY_ADMIN_SECRET, ENTROPY_ADMIN_ID: process.env.ENTROPY_ADMIN_ID }));
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), 'Cache-Control': 'no-store' });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const name = ['/', '/admin', '/admin/'].includes(parsed.pathname) ? 'experience.html' : decodeURIComponent(parsed.pathname).slice(1);
    if (!allowed.has(name)) { res.writeHead(404); res.end('Not found'); return; }
    let body;
    if (name === 'seed.js') {
      const local = await readLocalDataset().catch(() => null);
      body = local ? Buffer.from('window.EntropyLocalDatabase = true; window.EntropySeed = ' + JSON.stringify(local).replace(/</g, '\\u003c') + ';') : await readFile(path.join(base, name));
    } else body = await readFile(path.join(base, name));
    res.writeHead(200, { 'Content-Type': types[path.extname(name)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://pbs.twimg.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (_) { res.writeHead(500); res.end('Unable to serve page'); }
});
server.listen(port, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + port));
process.on('SIGINT', () => server.close(() => process.exit(0)));
