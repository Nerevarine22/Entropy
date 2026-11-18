import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../leaderboard-worker.mjs';
import { localD1Binding } from '../../entropy-app/local-d1.mjs';

const origin = 'https://leaderboard.example';
const key = '9a'.repeat(32);
const generation = 'leaderboard-test';
const date = '2026-09-01';
const asOf = date + 'T12:00:00.000Z';
const reason = 'Internal moderation example';
const migrations = await Promise.all(['0000_aberrant_gamora.sql', '0001_creator_moderation.sql']
  .map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));

function fixture(context) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  for (const migration of migrations) db.exec(migration);
  db.prepare("INSERT INTO entropy_control (id,generation,updated_at) VALUES ('main',?,?)").run(generation, asOf);
  const store = (kind, id, payload) => db.prepare(`
    INSERT INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at) VALUES (?,?,?,0,?,0)
    ON CONFLICT(generation,kind,record_id,chunk_index) DO UPDATE SET payload=excluded.payload
  `).run(generation, kind, id, JSON.stringify(payload));
  const update = () => db.exec("UPDATE entropy_control SET revision=revision+1 WHERE id='main'");
  const savePost = (id, authorId, body, views) => {
    store('post', id, { id, authorId, date, publishedAt: asOf, isReply: false, body,
      metrics: { impressions: views, likes: 2, reposts: 1, quotes: 0, replies: 0 } });
    update();
  };
  store('dataset-meta', 'main', { asOf });
  for (const [id, handle] of [['11', 'alice'], ['22', 'bob']]) store('author', id, { id, handle, displayName: handle });
  savePost('111', '11', 'Original @entropyIO post', 120);
  savePost('222', '22', 'Another @entropyIO post', 80);
  const cache = new Map();
  const env = {
    DB: localD1Binding(db), ENTROPY_ADMIN_SECRET: key, ENTROPY_ADMIN_ID: 'moderator',
    previewCache: {
      async match(url) { return cache.get(url)?.clone(); },
      async put(url, response) { cache.set(url, response.clone()); },
    },
  };
  let cookie;
  const call = (path, { action, unrelatedOrigin, anonymous, forgedCookie } = {}) => {
    const headers = new Headers();
    if (!anonymous && (forgedCookie || cookie)) headers.set('Cookie', forgedCookie || cookie);
    if (action) {
      headers.set('Content-Type', 'application/json');
      headers.set('Origin', unrelatedOrigin ?? origin);
    }
    return worker.fetch(new Request(origin + path, { method: action ? 'POST' : 'GET', headers,
      ...(action ? { body: JSON.stringify(action) } : {}) }), env);
  };
  async function login() {
    const response = await call('/api/admin', { action: { action: 'login', key } });
    assert.equal(response.status, 200);
    const issued = response.headers.get('Set-Cookie');
    assert.match(issued, /^__Host-entropy-admin=/);
    assert.match(issued, /HttpOnly; SameSite=Strict; Secure/);
    cookie = issued.split(';')[0];
  }
  return { call, login, savePost, db };
}

const data = async response => {
  assert.equal(response.status, 200);
  return response.json();
};

test('admin authenticates before reading or changing moderation state', async context => {
  const { call, login } = fixture(context);
  assert.equal((await call('/api/admin?view=ranking')).status, 401);
  assert.equal((await call('/api/admin?view=profile&creator=11')).status, 401);
  assert.equal((await call('/api/admin', { action: { action: 'login', key: 'ff'.repeat(32) } })).status, 401);
  assert.equal((await call('/api/admin', { action: { action: 'login', key }, unrelatedOrigin: 'https://other.example' })).status, 403);
  await login();
  assert.deepEqual(await data(await call('/api/admin?view=session')), { authenticated: true });
  const forgedCookie = '__Host-entropy-admin=' + (Math.floor(Date.now() / 1000) + 600) + '.12345678-0000-0000-0000-123456789abc.' + key;
  assert.equal((await call('/api/admin?view=ranking', { forgedCookie })).status, 401);
  assert.equal((await call('/api/admin', { action: { action: 'review' }, unrelatedOrigin: 'https://other.example' })).status, 403);
  const logout = await call('/api/admin', { action: { action: 'logout' } });
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('exclude and restore affect the current ranking while posts and private action history persist', async context => {
  const { call, login, db } = fixture(context);
  const initial = await data(await call('/api/leaderboard?view=ranking'));
  assert.equal(initial.totals.posts, 2);
  assert.equal(initial.rows[0].author.id, '11');
  await login();
  const profile = await data(await call('/api/admin?view=profile&creator=11'));
  const input = { action: 'exclude', creator: '11', postId: '111', snapshotId: profile.snapshotId, reason };
  assert.equal((await call('/api/admin', { action: { ...input, reason: '  ' } })).status, 400);
  assert.equal((await call('/api/admin', { action: { ...input, postId: '222' } })).status, 404);
  const concurrent = await Promise.all([call('/api/admin', { action: input }), call('/api/admin', { action: input })]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
  const excluded = await data(await call('/api/leaderboard?view=ranking'));
  assert.equal(excluded.totals.posts, 1);
  assert.equal(excluded.totals.views, 80);
  assert.equal(excluded.leaders[0].author.id, '22');
  assert.equal((await call('/api/leaderboard?view=profile&creator=11')).status, 404);
  assert(!JSON.stringify(await data(await call('/api/leaderboard'))).includes(reason));
  const adminRank = await data(await call('/api/admin?view=ranking&q=alice'));
  assert.equal(adminRank.rows[0].rank, null);
  const moderated = await data(await call('/api/admin?view=profile&creator=11'));
  assert.equal(moderated.posts[0].body, profile.posts[0].body);
  assert.equal(moderated.posts[0].exclusion.reason, reason);
  assert.deepEqual(moderated.totals, { posts: 0, views: 0, likes: 0 });
  assert.equal(moderated.history[0].actorId, 'moderator');
  await data(await call('/api/admin', { action: { ...input, action: 'restore' } }));
  assert.equal((await data(await call('/api/leaderboard?view=ranking'))).totals.posts, 2);
  const restored = await data(await call('/api/admin?view=profile&creator=11'));
  assert.equal(restored.posts[0].exclusion, null);
  assert.deepEqual(restored.totals, profile.totals);
  assert.deepEqual(new Set(restored.history.map(event => event.action)), new Set(['restore', 'exclude']));
  assert(restored.history.every(event => event.reason === reason));
  assert.equal(db.prepare("SELECT count(*) AS count FROM entropy_records WHERE kind='post'").get().count, 2);
});

test('review versions change with creator content and survive metric refreshes', async context => {
  const { call, login, savePost } = fixture(context);
  await login();
  const profile = await data(await call('/api/admin?view=profile&creator=11'));
  const review = { action: 'review', creator: '11', snapshotId: profile.snapshotId };
  await data(await call('/api/admin', { action: review }));
  const reviewed = await data(await call('/api/admin?view=ranking&status=reviewed'));
  assert.equal(reviewed.rows[0].review.status, 'reviewed');
  assert.equal(reviewed.rows[0].review.snapshotId, profile.snapshotId);
  assert.equal(reviewed.rows[0].review.datasetAsOf, asOf);
  const publicReview = (await data(await call('/api/leaderboard?view=ranking'))).rows[0];
  assert(publicReview.reviewedAt);
  assert(!Object.hasOwn(publicReview, 'review'));
  savePost('111', '11', profile.posts[0].body, 200);
  assert((await data(await call('/api/leaderboard?view=ranking'))).rows[0].reviewedAt);
  savePost('111', '11', 'Updated @entropyIO post', 200);
  assert.equal((await data(await call('/api/leaderboard?view=ranking'))).rows[0].reviewedAt, null);
  const pending = await data(await call('/api/admin?view=ranking&status=needs-review'));
  assert.equal(pending.rows[0].review.snapshotId, profile.snapshotId);
  assert.equal((await call('/api/admin', { action: review })).status, 409);
  const edited = await data(await call('/api/admin?view=profile&creator=11'));
  await data(await call('/api/admin', { action: { ...review, snapshotId: edited.snapshotId } }));
  savePost('112', '11', 'New @entropyIO post', 50);
  const withNewPost = await data(await call('/api/admin?view=profile&creator=11'));
  assert.equal(withNewPost.review.status, 'needs-review');
  assert.equal(withNewPost.totalPosts, 2);
  assert.equal(withNewPost.history.filter(event => event.action === 'review').length, 2);
});
