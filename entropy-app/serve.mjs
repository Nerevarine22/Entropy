import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import path from 'node:path';
import { readLocalDataset, withLocalD1 } from './local-d1.mjs';
import leaderboard, { captureDailyRanks, readMyStats, refreshActivitySnapshot } from '../entropy-cloud/leaderboard-worker.mjs';
import { createMyStatsHandler } from './x-sign-in.mjs';
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
const localOrigin = 'http://127.0.0.1:' + port;
const withStatsDb = use => withLocalD1(DB => use({ DB, previewCache }));
const myStats = createMyStatsHandler({ origin: localOrigin,
  clientId: process.env.X_CLIENT_ID?.trim(), clientSecret: process.env.X_CLIENT_SECRET?.trim(),
  sessionSecret: process.env.X_SESSION_SECRET?.trim() || undefined,
  getStats: (id, url) => withStatsDb(env => readMyStats(env, url, id)),
});
let capturedDay, pendingCapture;
function captureLocalDay() {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  if (capturedDay === day) return;
  pendingCapture ??= withStatsDb(env => captureDailyRanks(env, new URL(localOrigin), now))
    .then(() => { capturedDay = day; })
    .finally(() => { pendingCapture = null; });
  return pendingCapture;
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host === 'localhost:' + port ? req.headers.host : '127.0.0.1:' + port;
    const parsed = new URL(req.url, 'http://' + host);
    if (parsed.pathname === '/api/my-stats' || parsed.pathname.startsWith('/api/my-stats/')) {
      if (req.headers.host !== parsed.host) { res.writeHead(403); res.end(); return; }
      const response = await myStats(new Request(parsed, { method: req.method, headers: req.headers }));
      const headers = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
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
    const contentType = types[path.extname(name)];
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://pbs.twimg.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (_) { res.writeHead(500); res.end('Unable to serve page'); }
});
server.listen(port, '127.0.0.1', () => {
  console.log('Local: ' + localOrigin);
  let pendingActivity;
  const updateSnapshots = () => {
    captureLocalDay()?.catch(() => console.warn('Could not save the local daily ranks.'));
    pendingActivity ??= withStatsDb(refreshActivitySnapshot)
      .catch(() => console.warn('Could not save the local activity snapshot.'))
      .finally(() => { pendingActivity = null; });
  };
  updateSnapshots();
  setInterval(updateSnapshots, 60_000).unref();
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
