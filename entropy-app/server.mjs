// Local development backend. Production hosting must use server-managed secrets.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, rename, unlink, chmod, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createClient } from './twitterapi.mjs';

const require = createRequire(import.meta.url);
const Model = require('./model.js');
const BASE = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'entropy_local_session';
const ASSETS = new Set(['index.html', 'styles.css', 'scoring.js', 'model.js', 'seed.js', 'app.js', 'seed.json']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const MAX_BODY = 15 * 1024 * 1024;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const bad = message => { throw new ApiError(400, 'INVALID_INPUT', message); };
const validKey = value => typeof value === 'string' && value.trim().length >= 8 && value.trim().length <= 1024 && !/[\r\n\0]/.test(value);

async function atomicJson(file, value) {
  const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    const output = await open(temp, 'wx', 0o600);
    try { await output.writeFile(JSON.stringify(value)); await output.sync(); } finally { await output.close(); }
    await rename(temp, file);
    await chmod(file, 0o600);
    const parent = await open(path.dirname(file), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
async function optionalJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'JSON_REQUIRED', 'Send application/json.');
  if (Number(req.headers['content-length']) > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', 'The request is too large.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', 'The request is too large.');
    chunks.push(chunk);
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!plain(body)) bad('Send a JSON object.'); return body; }
  catch (error) { if (error instanceof ApiError) throw error; bad('The request contains invalid JSON.'); }
}

export async function createWorkbenchServer({ directory = path.join(BASE, 'runtime'), port = 8767, seed,
  advanceSync, clock = () => new Date(), apiKey, pollMs = 10000, dailyLimit = 288, fetchImpl } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local port.');
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10000) throw new Error('Invalid daily request limit.');
  if (!Number.isInteger(pollMs) || pollMs < 10) throw new Error('Invalid scheduler interval.');
  const now = () => { const date = new Date(clock()); if (!Number.isFinite(date.getTime())) throw new Error('Invalid server clock.'); return date.toISOString(); };
  const runtime = path.resolve(directory);
  await mkdir(runtime, { recursive: true, mode: 0o700 }); await chmod(runtime, 0o700);
  const dataFile = path.join(runtime, 'workbench.json'), keyFile = path.join(runtime, 'api-key.json'), lockFile = path.join(runtime, 'server.lock');
  const environmentKey = apiKey === undefined ? process.env.TWITTERAPI_IO_KEY ?? null : apiKey;
  if (environmentKey !== null && !validKey(environmentKey)) throw new Error('Invalid server-managed API key.');
  const keyRecord = await optionalJson(keyFile);
  if (keyRecord && !validKey(keyRecord.apiKey)) throw new Error('The local API-key file is invalid.');
  if (keyRecord) await chmod(keyFile, 0o600);
  let localKey = keyRecord?.apiKey?.trim() || null;
  let workbench = await optionalJson(dataFile);
  if (workbench) {
    if (!Number.isSafeInteger(workbench.revision) || workbench.revision < 0 || !plain(workbench.sync)) throw new Error('The saved workbench is invalid.');
    workbench = { ...workbench, dataset: Model.validateDataset(workbench.dataset), state: Model.validateState(workbench.state) };
    await chmod(dataFile, 0o600);
  } else {
    workbench = { dataset: Model.validateDataset(seed || JSON.parse(await readFile(path.join(BASE, 'seed.json'), 'utf8'))),
      state: Model.initialState(), revision: 0, updatedAt: now(), sync: { enabled: false, paused: false, intervalMs: 300000, target: 'entropyIO', source: 'twitterapi.io', nextRunAt: null } };
    await atomicJson(dataFile, workbench);
  }
  const token = randomBytes(32).toString('hex'), nonce = randomBytes(16).toString('hex');
  let addressPort = port, started = false, closing = false, timer = null, running = false, queue = Promise.resolve();
  const key = () => environmentKey?.trim() || localKey;
  const connection = () => ({ configured: !!key(), keySource: environmentKey ? 'environment' : localKey ? 'local-file' : 'none' });
  const serial = operation => { const task = queue.then(operation); queue = task.catch(() => {}); return task; };
  const snapshot = () => structuredClone({ ...workbench, sync: { ...workbench.sync, running }, connection: connection(), mode: 'local-development' });
  async function commit(next) {
    const updated = { ...next, revision: workbench.revision + 1, updatedAt: now() };
    await atomicJson(dataFile, updated); workbench = updated; return snapshot();
  }
  const checkRevision = body => { if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== workbench.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'The workbench changed. Reload it before saving.'); };
  async function runTick() {
    if (closing || !key() || !workbench.sync.enabled || workbench.sync.paused) return snapshot();
    const at = now(), nextAt = workbench.sync.nextRunAt ? Date.parse(workbench.sync.nextRunAt) : 0;
    if (Number.isFinite(nextAt) && nextAt > Date.parse(at)) return snapshot();
    const day = at.slice(0, 10);
    const previous = workbench.sync.attemptBudget;
    const budget = { day, count: previous?.day === day && Number.isSafeInteger(previous.count) ? previous.count : 0, limit: dailyLimit };
    if (budget.count >= dailyLimit) {
      const tomorrow = new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString();
      return commit({ ...workbench, sync: { ...workbench.sync, attemptBudget: budget, nextRunAt: tomorrow,
        lastError: { code: 'DAILY_LIMIT', message: 'The daily request limit has been reached.', at } } });
    }
    budget.count++;
    // Reserve attempts durably before a request. Crashes and provider errors still count.
    await commit({ ...workbench, sync: { ...workbench.sync, attemptBudget: budget, lastAttemptAt: at } });
    running = true;
    try {
      const engine = advanceSync || (await import('./live-engine.mjs')).advanceSync;
      const result = await engine(structuredClone(workbench), { client: createClient({ apiKey: key(), ...(fetchImpl ? { fetchImpl } : {}) }), now: at, maxRequests: 1 });
      if (!result || !plain(result.sync)) throw new Error('Invalid collector result.');
      const dataset = Model.validateDataset(result.dataset);
      const state = Model.validateState(result.state || Model.reconcileImport(workbench.dataset, dataset, workbench.state));
      return await commit({ ...workbench, dataset, state, sync: { ...result.sync, attemptBudget: budget } });
    } catch (_) {
      return await commit({ ...workbench, sync: { ...workbench.sync, attemptBudget: budget,
        nextRunAt: new Date(Date.parse(at) + 300000).toISOString(),
        lastError: { code: 'COLLECTOR_ERROR', message: 'Collection failed. Previous data was preserved.', at } } });
    } finally { running = false; }
  }
  const tick = () => serial(runTick);
  function send(res, status, value, headers = {}) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(body);
  }
  function authorized(req) {
    const cookie = (req.headers.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
    return /^[a-f0-9]{64}$/.test(cookie) && timingSafeEqual(Buffer.from(cookie), Buffer.from(token));
  }
  const server = createServer(async (req, res) => {
    try {
      const origin = 'http://127.0.0.1:' + addressPort;
      if (req.headers.host !== '127.0.0.1:' + addressPort) throw new ApiError(403, 'INVALID_HOST', 'This development server only accepts its loopback address.');
      const url = new URL(req.url, origin);
      if (url.origin !== origin) throw new ApiError(403, 'INVALID_ORIGIN', 'Cross-origin requests are not allowed.');
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && req.headers.origin !== origin) throw new ApiError(403, 'INVALID_ORIGIN', 'Cross-origin requests are not allowed.');
        if (!authorized(req)) throw new ApiError(401, 'SESSION_REQUIRED', 'Open the dashboard in this browser first.');
        if (req.method === 'GET' && url.pathname === '/api/workbench') { send(res, 200, snapshot()); return; }
        if (!['POST', 'DELETE'].includes(req.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This method is not supported.');
        if (req.headers.origin !== origin) throw new ApiError(403, 'ORIGIN_REQUIRED', 'A same-origin request is required.');
        const body = await jsonBody(req);
        const result = await serial(async () => {
          checkRevision(body);
          if (url.pathname === '/api/connection' && req.method === 'POST') {
            if (environmentKey) throw new ApiError(409, 'ENVIRONMENT_KEY', 'The key is managed by the server environment.');
            if (!validKey(body.apiKey)) bad('Enter a valid API key.');
            if (typeof body.enabled !== 'boolean') bad('Specify whether collection is enabled.');
            const secret = body.apiKey.trim();
            await atomicJson(keyFile, { apiKey: secret }); localKey = secret;
            return commit({ ...workbench, sync: { ...workbench.sync, enabled: body.enabled, paused: false, nextRunAt: now(), lastError: null } });
          }
          if (url.pathname === '/api/connection' && req.method === 'DELETE') {
            const saved = await commit({ ...workbench, sync: { ...workbench.sync, enabled: false, paused: false } });
            if (!environmentKey) { await unlink(keyFile).catch(error => { if (error.code !== 'ENOENT') throw error; }); localKey = null; }
            return { ...saved, connection: connection(), message: environmentKey ? 'Collection paused. Remove the API key from the server environment to disconnect it.' : 'The local key was removed and collection paused.' };
          }
          if (url.pathname === '/api/state' && req.method === 'POST') {
            if (!plain(body.state)) bad('Supply a valid moderation state.');
            const state = Model.validateState({ ...body.state, identityEvidence: workbench.state.identityEvidence });
            return commit({ ...workbench, state });
          }
          if (url.pathname === '/api/import' && req.method === 'POST') {
            if (workbench.sync.enabled) throw new ApiError(409, 'PAUSE_REQUIRED', 'Pause collection before importing data.');
            const dataset = Model.validateDataset(body.dataset);
            const state = body.isBackup === true ? Model.validateState(body.state) : Model.reconcileImport(workbench.dataset, dataset, workbench.state);
            return commit({ ...workbench, dataset, state });
          }
          if (url.pathname === '/api/collector' && req.method === 'POST') {
            if (typeof body.enabled !== 'boolean') bad('Specify whether collection is enabled.');
            if (body.enabled && !key()) throw new ApiError(409, 'KEY_REQUIRED', 'Configure a server-side API key first.');
            return commit({ ...workbench, sync: { ...workbench.sync, enabled: body.enabled, paused: false, ...(body.enabled ? { nextRunAt: now(), lastError: null } : {}) } });
          }
          if (url.pathname === '/api/sync' && req.method === 'POST') {
            if (!key()) throw new ApiError(409, 'KEY_REQUIRED', 'Configure a server-side API key first.');
            return commit({ ...workbench, sync: { ...workbench.sync, enabled: true, paused: false, nextRunAt: now(), lastError: null } });
          }
          throw new ApiError(404, 'NOT_FOUND', 'The endpoint was not found.');
        });
        send(res, url.pathname === '/api/sync' ? 202 : 200, result);
        if (workbench.sync.enabled && ['/api/connection', '/api/sync', '/api/collector'].includes(url.pathname)) void tick().catch(() => {});
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This method is not supported.');
      const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      if (!ASSETS.has(name)) throw new ApiError(404, 'NOT_FOUND', 'The file was not found.');
      const data = await readFile(path.join(BASE, name));
      const headers = { 'Content-Type': TYPES[path.extname(name)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
      if (name === 'index.html') headers['Set-Cookie'] = COOKIE + '=' + token + '; HttpOnly; SameSite=Strict; Path=/';
      res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      const known = error instanceof ApiError;
      send(res, known ? error.status : 400, { error: known ? error.code : 'INVALID_DATA', message: known ? error.message : 'The request could not be applied. Check the data format and try again.' });
    }
  });
  async function acquireLock() {
    try { const file = await open(lockFile, 'wx', 0o600); await file.writeFile(JSON.stringify({ pid: process.pid, nonce })); await file.close(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await optionalJson(lockFile);
      let alive = true;
      if (Number.isInteger(existing?.pid)) { try { process.kill(existing.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; } }
      if (alive) throw new Error('A development server already owns this runtime directory.');
      await unlink(lockFile); return acquireLock();
    }
  }
  async function start() {
    if (started) return { url: 'http://127.0.0.1:' + addressPort, port: addressPort };
    await acquireLock();
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      addressPort = server.address().port; started = true;
      timer = setInterval(() => { void tick().catch(() => {}); }, pollMs); timer.unref();
      void tick().catch(() => {});
      return { url: 'http://127.0.0.1:' + addressPort, port: addressPort };
    } catch (error) { await unlink(lockFile).catch(() => {}); throw error; }
  }
  async function close() {
    closing = true; if (timer) clearInterval(timer); await queue;
    if (started) { await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections?.(); }); started = false; }
    const lock = await optionalJson(lockFile).catch(() => null); if (lock?.nonce === nonce) await unlink(lockFile).catch(() => {});
  }
  return { server, start, close, tick, snapshot };
}

async function main() {
  const app = await createWorkbenchServer({ port: Number(process.env.ENTROPY_PORT || 8767), directory: process.env.ENTROPY_RUNTIME_DIR || path.join(BASE, 'runtime') });
  const address = await app.start(); console.log('Local development dashboard: ' + address.url);
  const stop = () => { void app.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Unable to start the local development server. Check the port and runtime directory.'); process.exitCode = 1; });
