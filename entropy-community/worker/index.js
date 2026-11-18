const ASSETS = /*__ASSETS__*/ {};

const MAX_BYTES = 16 * 1024 * 1024;
const CHUNK_UNITS = 120000;
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
const METRICS = ['impressions', 'likes', 'reposts', 'quotes', 'replies'];
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

class PublicError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const invalid = () => { throw new PublicError(400, 'INVALID_SNAPSHOT'); };
function keys(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid();
}
function text(value, max = 1000) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) invalid();
  return value;
}
function identifier(value) {
  if (!/^[A-Za-z0-9:_-]{1,200}$/.test(text(value, 200))) invalid();
  return value;
}
function day(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(value, 10))) invalid();
  const timestamp = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function instant(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text(value, 40))) invalid();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) invalid();
  day(value.slice(0, 10));
  return new Date(timestamp).toISOString();
}
function count(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function metrics(value) {
  keys(value, METRICS);
  return Object.fromEntries(METRICS.map(key => [key, count(value[key], true)]));
}
function author(value) {
  keys(value, ['id', 'handle', 'displayName']);
  if (!/^[A-Za-z0-9_]{1,15}$/.test(text(value.handle, 15))) invalid();
  return { id: identifier(value.id), handle: value.handle, displayName: text(value.displayName, 300) };
}
function post(value) {
  keys(value, ['id', 'authorId', 'date', 'publishedAt', 'url', 'body', 'summary', 'metrics', 'metricsAsOf'], ['id', 'authorId', 'date', 'publishedAt', 'url', 'body', 'metrics', 'metricsAsOf']);
  let url;
  try { url = new URL(text(value.url, 2048)); } catch { invalid(); }
  if (url.protocol !== 'https:' || !X_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !/^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/[1-9]\d*\/?$/.test(url.pathname)) invalid();
  const date = day(value.date), publishedAt = instant(value.publishedAt, true);
  if (publishedAt !== null && publishedAt.slice(0, 10) !== date) invalid();
  return {
    id: identifier(value.id), authorId: identifier(value.authorId), date, publishedAt,
    url: url.href, body: value.body === null ? null : text(value.body, 1000000),
    summary: value.summary === undefined ? '' : text(value.summary, 1000000),
    metrics: metrics(value.metrics), metricsAsOf: instant(value.metricsAsOf, true),
  };
}

// The public boundary is explicit and rejects added private fields at every depth.
export function validateSnapshot(raw) {
  keys(raw, ['schemaVersion', 'revision', 'updatedAt', 'public']);
  if (raw.schemaVersion !== 1) invalid();
  const revision = count(raw.revision), updatedAt = instant(raw.updatedAt);
  keys(raw.public, ['target', 'defaultPeriod', 'periods', 'posts', 'freshness']);
  const data = raw.public;
  if (data.target !== '@entropyIO' || !/^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(text(data.defaultPeriod, 7))) invalid();
  if (!Array.isArray(data.periods) || !data.periods.length || data.periods.length > 120 || !Array.isArray(data.posts) || data.posts.length > 100000) invalid();
  const periodKeys = new Set(), authorById = new Map(), authorsByPeriod = new Map();
  const periods = data.periods.map(period => {
    keys(period, ['key', 'start', 'endExclusive', 'rows']);
    const key = text(period.key, 7);
    if (!/^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(key) || periodKeys.has(key)) invalid();
    const start = day(period.start), endExclusive = day(period.endExclusive);
    const end = new Date(start + 'T00:00:00.000Z'); end.setUTCMonth(end.getUTCMonth() + 1);
    if (start !== key + '-01' || end.toISOString().slice(0, 10) !== endExclusive) invalid();
    periodKeys.add(key);
    if (!Array.isArray(period.rows) || period.rows.length > 20000) invalid();
    const ids = new Set(), ranks = new Set(); authorsByPeriod.set(key, ids);
    const rows = period.rows.map(row => {
      keys(row, ['rank', 'author', 'score', 'posts', 'metrics']);
      const rank = count(row.rank), person = author(row.author);
      if (rank < 1 || ranks.has(rank) || ids.has(person.id)) invalid();
      ranks.add(rank); ids.add(person.id);
      if (authorById.has(person.id) && JSON.stringify(authorById.get(person.id)) !== JSON.stringify(person)) invalid();
      authorById.set(person.id, person);
      const score = row.score;
      if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > Number.MAX_SAFE_INTEGER)) invalid();
      return { rank, author: person, score, posts: count(row.posts), metrics: metrics(row.metrics) };
    });
    return { key, start, endExclusive, rows };
  });
  if (!periodKeys.has(data.defaultPeriod)) invalid();
  const postIds = new Set();
  const posts = data.posts.map(value => {
    const item = post(value);
    if (postIds.has(item.id) || !authorsByPeriod.get(item.date.slice(0, 7))?.has(item.authorId)) invalid();
    postIds.add(item.id);
    return item;
  });
  keys(data.freshness, ['lastDiscoveryAt', 'coverage']);
  if (data.freshness.coverage !== 'partial') invalid();
  return { schemaVersion: 1, revision, updatedAt, public: {
    target: '@entropyIO', defaultPeriod: data.defaultPeriod, periods, posts,
    freshness: { lastDiscoveryAt: instant(data.freshness.lastDiscoveryAt, true), coverage: 'partial' },
  } };
}

export function emptySnapshot() {
  return { schemaVersion: 1, revision: null, updatedAt: null, public: {
    target: '@entropyIO', defaultPeriod: null, periods: [], posts: [],
    freshness: { lastDiscoveryAt: null, coverage: 'partial' },
  } };
}
export function splitPayload(value) {
  const serialized = JSON.stringify(value), chunks = [];
  for (let offset = 0; offset < serialized.length;) {
    let end = Math.min(offset + CHUNK_UNITS, serialized.length);
    if (end < serialized.length && serialized.charCodeAt(end - 1) >= 0xd800 && serialized.charCodeAt(end - 1) <= 0xdbff) end--;
    chunks.push(serialized.slice(offset, end)); offset = end;
  }
  return chunks;
}
async function sha256(value) {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function authorize(request, env) {
  const expected = env.COMMUNITY_SYNC_SECRET;
  if (typeof expected !== 'string' || expected.length < 32 || expected.length > 256) throw new PublicError(503, 'PUBLISHING_UNAVAILABLE');
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get('authorization') || '');
  if (!match) throw new PublicError(401, 'UNAUTHORIZED');
  const a = await sha256(expected), b = await sha256(match[1]);
  let difference = 0; for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  if (difference !== 0) throw new PublicError(401, 'UNAUTHORIZED');
}
async function boundedJson(request) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('content-type') || '')) throw new PublicError(415, 'JSON_REQUIRED');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new PublicError(413, 'SNAPSHOT_TOO_LARGE');
  if (!request.body) throw new PublicError(400, 'INVALID_JSON');
  const reader = request.body.getReader(), pieces = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel(); throw new PublicError(413, 'SNAPSHOT_TOO_LARGE'); }
    pieces.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new PublicError(400, 'INVALID_JSON'); }
}
function database(env) {
  if (!env.DB?.prepare || !env.DB?.batch) throw new PublicError(503, 'STORAGE_UNAVAILABLE');
  return env.DB;
}
async function control(db) {
  return db.prepare('SELECT generation,source_revision,digest,updated_at,published_at FROM community_snapshot_control WHERE id=?').bind('main').first();
}
export async function storeSnapshot(env, snapshot) {
  const db = database(env), serialized = JSON.stringify(snapshot);
  if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES) throw new PublicError(413, 'SNAPSHOT_TOO_LARGE');
  const digest = await sha256(serialized), existing = await control(db);
  if (existing && existing.source_revision >= snapshot.revision) {
    if (existing.source_revision === snapshot.revision && existing.digest === digest) return { applied: false, revision: snapshot.revision };
    throw new PublicError(409, existing.source_revision > snapshot.revision ? 'STALE_SNAPSHOT' : 'SNAPSHOT_CONFLICT');
  }
  const generation = crypto.randomUUID(), now = Date.now(), chunks = splitPayload(snapshot);
  for (let start = 0; start < chunks.length; start += 25) {
    await db.batch(chunks.slice(start, start + 25).map((chunk, index) => db.prepare('INSERT INTO community_snapshot_chunks (generation,chunk_index,payload,created_at) VALUES (?,?,?,?)').bind(generation, start + index, chunk, now)));
  }
  // Publish only after all chunks are durable. The SQL guard settles concurrent writers.
  const published = await db.prepare('INSERT INTO community_snapshot_control (id,generation,source_revision,digest,updated_at,published_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,source_revision=excluded.source_revision,digest=excluded.digest,updated_at=excluded.updated_at,published_at=excluded.published_at WHERE excluded.source_revision>community_snapshot_control.source_revision').bind('main', generation, snapshot.revision, digest, snapshot.updatedAt, now).run();
  if (!published.meta?.changes) {
    const winner = await control(db);
    if (winner?.source_revision === snapshot.revision && winner.digest === digest) return { applied: false, revision: snapshot.revision };
    throw new PublicError(409, winner?.source_revision > snapshot.revision ? 'STALE_SNAPSHOT' : 'SNAPSHOT_CONFLICT');
  }
  // A full day of old generations protects in-flight readers and bounds storage growth.
  try { await db.prepare('DELETE FROM community_snapshot_chunks WHERE created_at<? AND generation NOT IN (SELECT generation FROM community_snapshot_control)').bind(now - 86400000).run(); } catch { /* Cleanup cannot undo a committed publication. */ }
  return { applied: true, revision: snapshot.revision };
}
export async function readSnapshot(env) {
  const db = database(env);
  // One statement observes a coherent pointer and its chunks, even during publication.
  const result = await db.prepare('SELECT c.generation,c.source_revision,c.digest,c.updated_at,s.chunk_index,s.payload FROM community_snapshot_control c LEFT JOIN community_snapshot_chunks s ON s.generation=c.generation WHERE c.id=? ORDER BY s.chunk_index').bind('main').all();
  const rows = result.results;
  if (!Array.isArray(rows)) throw new PublicError(503, 'SNAPSHOT_UNAVAILABLE');
  if (!rows.length) return emptySnapshot();
  const active = rows[0];
  if (rows.some((row, index) => row.chunk_index !== index || typeof row.payload !== 'string')) throw new PublicError(503, 'SNAPSHOT_UNAVAILABLE');
  const serialized = rows.map(row => row.payload).join('');
  if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES || await sha256(serialized) !== active.digest) throw new PublicError(503, 'SNAPSHOT_UNAVAILABLE');
  let snapshot;
  try { snapshot = validateSnapshot(JSON.parse(serialized)); } catch { throw new PublicError(503, 'SNAPSHOT_UNAVAILABLE'); }
  if (snapshot.revision !== active.source_revision || snapshot.updatedAt !== active.updated_at) throw new PublicError(503, 'SNAPSHOT_UNAVAILABLE');
  return snapshot;
}
function json(value, status = 200, extras = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extras } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/internal/snapshot') {
        if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'POST' });
        await authorize(request, env);
        if (url.search || (request.headers.has('origin') && request.headers.get('origin') !== url.origin)) throw new PublicError(403, 'INVALID_ORIGIN');
        const snapshot = validateSnapshot(await boundedJson(request));
        return json({ ok: true, ...await storeSnapshot(env, snapshot) });
      }
      if (url.pathname === '/api/leaderboard') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'READ_ONLY' }, 405, { allow: 'GET, HEAD' });
        if (url.search) throw new PublicError(400, 'INVALID_QUERY');
        const snapshot = await readSnapshot(env), etag = '"entropy-' + (snapshot.revision ?? 'empty') + '"';
        const headers = { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30, stale-while-revalidate=30', etag };
        if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
        return new Response(request.method === 'HEAD' ? null : JSON.stringify(snapshot), { headers });
      }
      const asset = ASSETS[url.pathname === '/index.html' ? '/' : url.pathname];
      if (asset && (request.method === 'GET' || request.method === 'HEAD')) return new Response(request.method === 'HEAD' ? null : asset.body, { headers: { ...SECURITY_HEADERS, 'content-type': asset.type, 'cache-control': url.pathname === '/' || url.pathname.endsWith('.html') ? 'no-cache' : 'public, max-age=300' } });
      return json({ error: 'NOT_FOUND' }, 404);
    } catch (error) {
      return json({ error: error instanceof PublicError ? error.code : 'SERVICE_UNAVAILABLE' }, error instanceof PublicError ? error.status : 503);
    }
  },
};
