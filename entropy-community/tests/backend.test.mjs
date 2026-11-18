import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import worker, { emptySnapshot, validateSnapshot, splitPayload, readSnapshot } from '../worker/index.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const SECRET = 'test_only_community_secret_0123456789_abcdef';
const ORIGIN = 'https://community.example';
const migrationNames = (await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
const migrations = (await Promise.all(migrationNames.map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')))).join('\n');

// Executes real SQLite SQL while exposing the D1 interface used by the Worker.
class D1 {
  constructor(schema = migrations) { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec(schema); this.runtimeSql = []; this.batchCalls = 0; }
  prepare(sql) {
    assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP)\b/i, 'runtime must not mutate schema');
    this.runtimeSql.push(sql);
    return new Statement(this, sql);
  }
  async batch(statements) {
    this.batchCalls++;
    if (this.failBatch === this.batchCalls) throw new Error('injected staging failure with private detail');
    this.sqlite.exec('BEGIN');
    try { const result = []; for (const statement of statements) result.push(await statement.run()); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
class Statement {
  constructor(owner, sql, params = []) { this.owner = owner; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.owner, this.sql, params); }
  async first() { return this.owner.sqlite.prepare(this.sql).get(...this.params) || null; }
  async all() { return { results: this.owner.sqlite.prepare(this.sql).all(...this.params) }; }
  async run() {
    if (this.sql.startsWith('INSERT INTO community_snapshot_control')) await this.owner.beforePublish?.(this.params);
    const result = this.owner.sqlite.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}
function fixture(revision = 1) {
  const metrics = { impressions: 12345, likes: 45, reposts: 6, quotes: 2, replies: null };
  return { schemaVersion: 1, revision, updatedAt: '2026-11-18T09:00:00.000Z', public: {
    target: '@entropyIO', defaultPeriod: '2026-11',
    periods: [{ key: '2026-11', start: '2026-11-01', endExclusive: '2026-12-01', rows: [{ rank: 1, author: { id: 'sample:alice', handle: 'alice', displayName: 'Alice' }, score: null, posts: 1, metrics }] }],
    posts: [{ id: '123456789', authorId: 'sample:alice', date: '2026-11-17', publishedAt: null, url: 'https://x.com/alice/status/123456789', body: null, summary: 'Entropy contribution', metrics: structuredClone(metrics), metricsAsOf: null }],
    freshness: { lastDiscoveryAt: null, coverage: 'partial' },
  } };
}
const environment = db => ({ DB: db, COMMUNITY_SYNC_SECRET: SECRET });
const get = (db, path = '/api/leaderboard', init = {}) => worker.fetch(new Request(ORIGIN + path, init), environment(db));
const publish = (db, value = fixture(), { secret = SECRET, headers = {}, ...options } = {}) => worker.fetch(new Request(ORIGIN + '/internal/snapshot', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret, ...headers }, body: JSON.stringify(value), ...options,
}), environment(db));

test('generated migration and documented schema both support a durable public round-trip', async () => {
  assert.ok(migrationNames.length, 'a schema-only migration must exist');
  for (const schema of [migrations, await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8')]) {
    const db = new D1(schema);
    assert.deepEqual(await readSnapshot(environment(db)), emptySnapshot());
    const result = await publish(db);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { ok: true, applied: true, revision: 1 });
    assert.deepEqual(await (await get(db)).json(), fixture());
  }
});

test('anonymous initial API is honestly empty and safe to cache briefly', async () => {
  const response = await get(new D1());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), emptySnapshot());
  assert.match(response.headers.get('cache-control'), /max-age=30/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('only the exact public GET endpoint is accessible; admin, auth and personal APIs do not exist', async () => {
  const db = new D1();
  for (const path of ['/api/state', '/api/admin', '/api/workbench', '/api/me', '/auth/x', '/auth/callback', '/login', '/api/leaderboard/other', '/.env', '/worker/index.js']) {
    for (const method of ['GET', 'POST', 'DELETE']) assert.equal((await get(db, path, { method })).status, 404, method + ' ' + path);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) assert.equal((await get(db, '/api/leaderboard', { method })).status, 405);
  assert.equal((await get(db, '/api/leaderboard?userId=123')).status, 400);
  assert.equal((await get(db, '/internal/snapshot')).status, 405);
});

test('ingestion requires the server secret before parsing or writing any body', async () => {
  const db = new D1();
  const missing = await worker.fetch(new Request(ORIGIN + '/internal/snapshot', { method: 'POST', body: 'bad' }), environment(db));
  assert.equal(missing.status, 401);
  assert.equal((await publish(db, fixture(), { secret: 'wrong_secret_012345678901234567890123' })).status, 401);
  assert.equal((await worker.fetch(new Request(ORIGIN + '/internal/snapshot', { method: 'POST' }), { DB: db })).status, 503);
  assert.deepEqual(await readSnapshot(environment(db)), emptySnapshot());
  assert.equal(db.batchCalls, 0);
});

test('ingestion blocks cross-origin submissions, invalid JSON, wrong media and oversized bodies', async () => {
  const db = new D1();
  assert.equal((await publish(db, fixture(), { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await publish(db, fixture(), { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await publish(db, fixture(), { body: '{malformed' })).status, 400);
  assert.equal((await publish(db, fixture(), { headers: { 'content-length': String(17 * 1024 * 1024) } })).status, 413);
  assert.equal(db.batchCalls, 0);
});

test('private or unexpected fields are rejected at every nesting level and never stored', async () => {
  const mutations = [
    snapshot => { snapshot.personal = { '123': { reason: 'private' } }; },
    snapshot => { snapshot.public.internalNotes = 'private'; },
    snapshot => { snapshot.public.periods[0].notes = 'private'; },
    snapshot => { snapshot.public.periods[0].rows[0].decision = { reason: 'private' }; },
    snapshot => { snapshot.public.periods[0].rows[0].author.apiKey = 'private'; },
    snapshot => { snapshot.public.posts[0].reason = 'private'; },
    snapshot => { snapshot.public.posts[0].metrics.smart_engagement = 17; },
    snapshot => { snapshot.public.freshness.cursor = 'private'; },
  ];
  for (const mutate of mutations) {
    const db = new D1(), snapshot = fixture(); mutate(snapshot);
    const response = await publish(db, snapshot);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'INVALID_SNAPSHOT' });
    assert.equal(db.batchCalls, 0);
  }
});

test('safe X links, nullable values, and optional summary work without fabricating missing metrics', async () => {
  const snapshot = fixture();
  delete snapshot.public.posts[0].summary;
  snapshot.public.posts[0].url = 'https://twitter.com/i/web/status/123456789';
  snapshot.public.posts[0].metrics = { impressions: null, likes: null, reposts: null, quotes: null, replies: null };
  assert.deepEqual(validateSnapshot(snapshot).public.posts[0].metrics, snapshot.public.posts[0].metrics);
  assert.equal(validateSnapshot(snapshot).public.posts[0].summary, '');
  for (const url of ['http://x.com/alice/status/123', 'https://evil.example/alice/status/123', 'https://x.com@evil.example/alice/status/123', 'https://name:password@x.com/alice/status/123', 'https://x.com/alice/status/123?token=secret', 'https://x.com/alice/status/123#fragment', 'javascript:alert(1)', 'https://x.com/alice']) {
    const invalid = fixture(); invalid.public.posts[0].url = url;
    assert.throws(() => validateSnapshot(invalid), /INVALID_SNAPSHOT/, url);
  }
});

test('malformed dates, duplicate identities, orphan posts and invalid numeric values fail validation', () => {
  const mutations = [
    snapshot => { snapshot.public.periods[0].key = '2026-13'; },
    snapshot => { snapshot.public.posts[0].date = '2026-02-30'; },
    snapshot => { snapshot.public.posts[0].publishedAt = '2026-11-16T22:00:00Z'; },
    snapshot => { snapshot.public.posts.push(structuredClone(snapshot.public.posts[0])); },
    snapshot => { snapshot.public.posts[0].authorId = 'not-on-board'; },
    snapshot => { snapshot.public.posts[0].date = '2026-10-31'; },
    snapshot => { snapshot.public.periods[0].rows.push(structuredClone(snapshot.public.periods[0].rows[0])); },
    snapshot => { snapshot.public.periods[0].rows[0].metrics.impressions = -1; },
    snapshot => { snapshot.public.periods[0].rows[0].score = Infinity; },
    snapshot => { snapshot.revision = 1.5; },
  ];
  for (const mutate of mutations) { const snapshot = fixture(); mutate(snapshot); assert.throws(() => validateSnapshot(snapshot), /INVALID_SNAPSHOT/); }
});

test('revision replay is idempotent; stale and conflicting snapshots cannot replace newer public data', async () => {
  const db = new D1();
  assert.equal((await publish(db, fixture(10))).status, 200);
  assert.deepEqual(await (await publish(db, fixture(10))).json(), { ok: true, applied: false, revision: 10 });
  const stale = await publish(db, fixture(9)); assert.equal(stale.status, 409); assert.equal((await stale.json()).error, 'STALE_SNAPSHOT');
  const conflict = fixture(10); conflict.public.posts[0].summary = 'changed';
  const rejected = await publish(db, conflict); assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error, 'SNAPSHOT_CONFLICT');
  assert.deepEqual(await (await get(db)).json(), fixture(10));
});

test('a delayed lower revision loses atomically to a concurrent higher revision', async () => {
  const db = new D1(); await publish(db, fixture(1));
  let release, arrived;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { arrived = resolve; });
  db.beforePublish = async params => { if (params[2] === 2) { arrived(); await gate; } };
  const low = publish(db, fixture(2));
  await reached;
  const high = await publish(db, fixture(3)); assert.equal(high.status, 200);
  release();
  assert.equal((await low).status, 409);
  assert.equal((await (await get(db)).json()).revision, 3);
});

test('Unicode survives chunk boundaries, and failed staging retains the previously published snapshot', async () => {
  const db = new D1(); await publish(db, fixture(1));
  const large = fixture(2); large.public.posts[0].body = '🙂'.repeat(200000);
  const chunks = splitPayload(large);
  assert.ok(chunks.length > 1);
  assert.deepEqual(JSON.parse(chunks.join('')), large);
  db.failBatch = db.batchCalls + 1;
  const failed = await publish(db, large); assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'SERVICE_UNAVAILABLE' });
  assert.deepEqual(await (await get(db)).json(), fixture(1));
  db.failBatch = undefined;
  assert.equal((await publish(db, large)).status, 200);
  assert.deepEqual(await (await get(db)).json(), large);
});

test('corrupt persisted data fails closed, even with a matching digest containing unexpected private fields', async () => {
  const db = new D1(); await publish(db);
  const snapshot = fixture(); snapshot.public.posts[0].moderatorNotes = 'PRIVATE';
  const serialized = JSON.stringify(snapshot);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)))].map(value => value.toString(16).padStart(2, '0')).join('');
  db.sqlite.prepare('UPDATE community_snapshot_chunks SET payload=? WHERE chunk_index=0').run(serialized);
  db.sqlite.prepare('UPDATE community_snapshot_control SET digest=?').run(hash);
  const response = await get(db);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'SNAPSHOT_UNAVAILABLE' });
});

test('missing storage or chunks never masquerade as a successful empty leaderboard', async () => {
  assert.equal((await worker.fetch(new Request(ORIGIN + '/api/leaderboard'), {})).status, 503);
  const db = new D1(); await publish(db); db.sqlite.exec('DELETE FROM community_snapshot_chunks');
  assert.equal((await get(db)).status, 503);
});

test('public ETag and HEAD avoid re-sending unchanged data without leaking private server state', async () => {
  const db = new D1(); await publish(db);
  const response = await get(db), etag = response.headers.get('etag');
  assert.equal(etag, '"entropy-1"');
  assert.equal((await get(db, '/api/leaderboard', { headers: { 'if-none-match': etag } })).status, 304);
  const head = await get(db, '/api/leaderboard', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.doesNotMatch(await response.text(), /COMMUNITY_SYNC_SECRET|test_only_community_secret|reason|notes|private/i);
});
