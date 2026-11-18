import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { createWorkbenchServer } from './server.mjs';

const require = createRequire(import.meta.url);
const Model = require('./model.js');
const seed = JSON.parse(await readFile(new URL('./seed.json', import.meta.url), 'utf8'));
const FAKE_KEY = 'fake-provider-key-for-local-tests';
const noRequest = async () => { throw new Error('Unexpected mocked provider call.'); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'entropy-server-test-'));
  const app = await createWorkbenchServer({ directory, port: 0, seed, apiKey: null, advanceSync: noRequest, ...options });
  const { url } = await app.start();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const page = await fetch(url);
  const setCookie = page.headers.get('set-cookie'); await page.text();
  const cookie = setCookie.split(';')[0];
  async function request(method, route, body, headers = {}) {
    const response = await fetch(url + route, { method, headers: { cookie, ...(method !== 'GET' ? { origin: url, 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  return { app, directory, url, cookie, setCookie, request };
}

test('dashboard issues a strict HttpOnly session; API rejects unauthenticated and cross-origin requests', async t => {
  const f = await fixture(t);
  assert.match(f.setCookie, /HttpOnly/); assert.match(f.setCookie, /SameSite=Strict/);
  assert.equal((await fetch(f.url + '/api/workbench')).status, 401);
  assert.equal((await f.request('GET', '/api/workbench')).status, 200);
  assert.equal((await f.request('GET', '/api/workbench', undefined, { origin: 'https://attacker.invalid' })).status, 403);
  const invalidHost = await new Promise((resolve, reject) => {
    const req = httpRequest(f.url + '/api/workbench', { headers: { host: 'attacker.invalid', cookie: f.cookie } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(invalidHost, 403);
  const state = f.app.snapshot();
  assert.equal((await f.request('POST', '/api/collector', { enabled: false, expectedRevision: state.revision }, { origin: '' })).status, 403);
  assert.equal((await f.request('POST', '/api/collector', { enabled: false, expectedRevision: state.revision }, { 'content-type': 'text/plain' })).status, 415);
});

test('local development key is private on disk and absent from API responses and static files', async t => {
  const f = await fixture(t);
  const result = await f.request('POST', '/api/connection', { apiKey: FAKE_KEY, enabled: false, expectedRevision: f.app.snapshot().revision });
  assert.equal(result.status, 200); assert.equal(result.body.connection.configured, true); assert.equal(result.body.connection.keySource, 'local-file');
  assert.ok(!JSON.stringify(result.body).includes(FAKE_KEY));
  assert.equal((await stat(path.join(f.directory, 'api-key.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.ok(!(await readFile(path.join(f.directory, 'workbench.json'), 'utf8')).includes(FAKE_KEY));
  for (const route of ['/api-key.json', '/runtime/api-key.json', '/server.mjs', '/workbench.json']) assert.equal((await fetch(f.url + route)).status, 404);
  const view = await f.request('GET', '/api/workbench'); assert.ok(!JSON.stringify(view.body).includes(FAKE_KEY));
  const removed = await f.request('DELETE', '/api/connection', { expectedRevision: f.app.snapshot().revision });
  assert.equal(removed.body.connection.configured, false); assert.equal(removed.body.sync.enabled, false);
  await assert.rejects(stat(path.join(f.directory, 'api-key.json')), { code: 'ENOENT' });
});

test('environment-managed keys cannot be replaced or exposed by the development API', async t => {
  const f = await fixture(t, { apiKey: FAKE_KEY });
  assert.equal(f.app.snapshot().connection.keySource, 'environment');
  const replaced = await f.request('POST', '/api/connection', { apiKey: 'another-fake-key', enabled: false, expectedRevision: 0 });
  assert.equal(replaced.status, 409);
  const removed = await f.request('DELETE', '/api/connection', { expectedRevision: 0 });
  assert.equal(removed.status, 200); assert.equal(removed.body.connection.configured, true); assert.equal(removed.body.sync.enabled, false);
  assert.match(removed.body.message, /server environment/); assert.ok(!JSON.stringify(removed.body).includes(FAKE_KEY));
});

test('concurrent saves use compare-and-swap; stale revisions cannot overwrite decisions', async t => {
  const f = await fixture(t), first = Model.initialState(), second = Model.initialState();
  first.ui.search = 'first'; second.ui.search = 'second';
  const results = await Promise.all([f.request('POST', '/api/state', { state: first, expectedRevision: 0 }), f.request('POST', '/api/state', { state: second, expectedRevision: 0 })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.app.snapshot().revision, 1);
  const disk = JSON.parse(await readFile(path.join(f.directory, 'workbench.json'), 'utf8'));
  assert.deepEqual(disk.state, f.app.snapshot().state);
});

test('moderation saves preserve the server identity ledger and invalid imports are atomic', async t => {
  const f = await fixture(t), author = seed.authors[0];
  const state = Model.decision(Model.initialState(), { type: 'ban', authorId: author.id, periodKey: '2026-11', reason: 'Test ban reason', internalNote: 'Private team note' }, '2026-11-17T12:00:00Z');
  state.identityEvidence[author.id] = { id: author.id, handle: author.handle, postIds: seed.posts.filter(p => p.authorId === author.id).map(p => p.id) };
  const restored = await f.request('POST', '/api/import', { dataset: seed, state, isBackup: true, expectedRevision: 0 }); assert.equal(restored.status, 200);
  const clientState = structuredClone(restored.body.state); clientState.identityEvidence = {};
  const saved = await f.request('POST', '/api/state', { state: clientState, expectedRevision: restored.body.revision });
  assert.deepEqual(saved.body.state.identityEvidence, state.identityEvidence);
  const before = f.app.snapshot();
  const invalid = await f.request('POST', '/api/import', { dataset: { authors: [], posts: [null] }, expectedRevision: before.revision });
  assert.equal(invalid.status, 400); assert.deepEqual(f.app.snapshot(), before);
});

test('data and moderation persist through a development server restart', async t => {
  const f = await fixture(t);
  const state = Model.decision(Model.initialState(), { type: 'ban', authorId: seed.authors[0].id, periodKey: '2026-11', reason: 'Persist this test decision' }, '2026-11-17T12:00:00Z');
  await f.request('POST', '/api/state', { state, expectedRevision: 0 });
  await f.app.close();
  const restored = await createWorkbenchServer({ directory: f.directory, port: 0, apiKey: null, advanceSync: noRequest });
  t.after(() => restored.close()); await restored.start();
  assert.equal(restored.snapshot().state.bans[seed.authors[0].id].reason, 'Persist this test decision');
  assert.equal(restored.snapshot().revision, 1);
  assert.equal((await stat(path.join(f.directory, 'workbench.json'))).mode & 0o777, 0o600);
});

test('no provider call occurs without both a key and explicit collection enablement', async t => {
  let calls = 0;
  const engine = async workbench => { calls++; return workbench; };
  const noKey = await fixture(t, { advanceSync: engine }); await noKey.app.tick();
  assert.equal((await noKey.request('POST', '/api/collector', { enabled: true, expectedRevision: 0 })).status, 409);
  const paused = await fixture(t, { apiKey: FAKE_KEY, advanceSync: engine }); await paused.app.tick();
  assert.equal(calls, 0);
});

test('scheduler continues bounded collection without browser requests', async t => {
  let calls = 0;
  const f = await fixture(t, { apiKey: FAKE_KEY, pollMs: 10, advanceSync: async (w, { now }) => {
    calls++; return { dataset: w.dataset, state: w.state, sync: { ...w.sync, nextRunAt: new Date(Date.parse(now) + 20).toISOString(), lastSuccessAt: now } };
  } });
  const result = await f.request('POST', '/api/collector', { enabled: true, expectedRevision: 0 }); assert.equal(result.status, 200);
  // No page or API reads after setup: the server timer owns these updates.
  for (let n = 0; n < 50 && calls < 2; n++) await wait(10);
  assert.ok(calls >= 2); await f.app.close();
  const stopped = calls; await wait(40); assert.equal(calls, stopped);
});

test('daily attempt cap is durable and counts failed calls before provider access', async t => {
  let at = '2026-11-17T12:00:00Z', calls = 0, directory;
  const f = await fixture(t, { apiKey: FAKE_KEY, dailyLimit: 2, clock: () => at, advanceSync: async () => {
    calls++;
    const disk = JSON.parse(await readFile(path.join(directory, 'workbench.json'), 'utf8'));
    assert.equal(disk.sync.attemptBudget.count, calls);
    throw new Error(FAKE_KEY);
  } }); directory = f.directory;
  await f.request('POST', '/api/collector', { enabled: true, expectedRevision: 0 }); await f.app.tick();
  assert.equal(calls, 1); assert.ok(!JSON.stringify(f.app.snapshot()).includes(FAKE_KEY));
  at = '2026-11-17T12:05:00Z'; await f.app.tick(); assert.equal(calls, 2);
  at = '2026-11-17T12:10:00Z'; await f.app.tick(); assert.equal(calls, 2);
  assert.equal(f.app.snapshot().sync.lastError.code, 'DAILY_LIMIT');
  assert.equal(f.app.snapshot().sync.attemptBudget.count, 2);
  assert.deepEqual(f.app.snapshot().dataset.posts, seed.posts.map(p => Model.validateDataset(seed).posts.find(v => v.id === p.id)));
});

test('a runtime directory cannot be owned by two active development servers', async t => {
  const f = await fixture(t);
  const second = await createWorkbenchServer({ directory: f.directory, port: 0, apiKey: null, advanceSync: noRequest });
  t.after(() => second.close());
  await assert.rejects(second.start(), /already owns/);
  assert.equal((await f.request('GET', '/api/workbench')).status, 200);
});

test('the real collector engine is wired to the server adapter without dropping sample-ID bans', async t => {
  let calls = 0;
  const authorIds = new Map(seed.authors.map((a, i) => [a.id, String(1000 + i)]));
  const target = seed.posts.find(p => p.date >= '2026-11-01');
  const f = await fixture(t, { apiKey: FAKE_KEY, advanceSync: undefined, clock: () => '2026-11-17T12:00:00Z', fetchImpl: async (url, options) => {
    calls++; assert.equal(url.pathname, '/twitter/tweets'); assert.equal(options.headers['x-api-key'], FAKE_KEY);
    const tweets = url.searchParams.get('tweet_ids').split(',').map(id => {
      const post = seed.posts.find(p => p.id === id), author = seed.authors.find(a => a.id === post.authorId);
      return { id, createdAt: post.date + 'T12:00:00Z', text: 'A verified test mention of @entropyIO',
        author: { id: authorIds.get(author.id), userName: author.handle, name: author.displayName, followers: 100 },
        viewCount: 100, likeCount: 2, retweetCount: 0, quoteCount: 0, replyCount: 1 };
    });
    return { ok: true, status: 200, json: async () => ({ status: 'success', tweets }) };
  } });
  const state = Model.decision(Model.initialState(), { type: 'ban', authorId: target.authorId, periodKey: '2026-11', reason: 'Keep this moderation decision' }, '2026-11-17T11:00:00Z');
  await f.request('POST', '/api/state', { state, expectedRevision: 0 });
  await f.request('POST', '/api/collector', { enabled: true, expectedRevision: 1 }); await f.app.tick();
  assert.equal(calls, 1);
  const result = f.app.snapshot();
  assert.equal(result.sync.lastSuccessAt, '2026-11-17T12:00:00.000Z');
  assert.equal(result.state.bans[authorIds.get(target.authorId)].reason, 'Keep this moderation decision');
  assert.equal(result.dataset.posts.find(p => p.id === target.id).authorId, authorIds.get(target.authorId));
  assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
});
