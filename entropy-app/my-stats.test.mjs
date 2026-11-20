import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { localD1Binding } from './local-d1.mjs';
import worker, { captureDailyRanks, readMyStats } from '../entropy-cloud/leaderboard-worker.mjs';
import statsApi, { statsServiceKey } from './api/my-stats.mjs';
import startApi from './api/my-stats/start.mjs';
import callbackApi from './api/my-stats/callback.mjs';
import { postScore } from '../entropy-cloud/leaderboard-view.mjs';
import { createMyStatsHandler } from './x-sign-in.mjs';

const origin = 'http://127.0.0.1:8767';
const request = (path = '', options) => new Request(`${origin}/api/my-stats${path}`, options);

test('X sign-in requires a valid state and resolves stats only for the ID verified by X', async () => {
  const calls = [];
  const statsCalls = [];
  const handler = createMyStatsHandler({ origin, clientId: 'client', clientSecret: 'secret',
    getStats: id => { statsCalls.push(id); return { overall: { rank: 12 } }; },
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return url.endsWith('/token') ? Response.json({ access_token: 'x-private-token' })
        : Response.json({ data: { id: '42', username: 'verified', name: 'Verified User' } });
    },
  });
  assert.deepEqual(await (await handler(request('?creator=42'))).json(), { configured: true, account: null });
  const start = await handler(request('/start'));
  const authorize = new URL(start.headers.get('Location'));
  const state = authorize.searchParams.get('state');
  const challenge = authorize.searchParams.get('code_challenge');
  const redirect = authorize.searchParams.get('redirect_uri');
  assert.equal(authorize.origin, 'https://x.com');
  assert.equal(redirect, `${origin}/api/my-stats/callback`);
  assert.equal(authorize.searchParams.get('scope'), 'users.read tweet.read');
  const stateCookie = start.headers.getSetCookie()[0];
  assert.match(stateCookie, /HttpOnly; SameSite=Lax/);
  const callback = (value) => handler(request(`/callback?state=${value}&code=x-code`, { headers: { Cookie: stateCookie.split(';')[0] } }));
  assert.match((await callback('incorrect')).headers.get('Location'), /x_login=failed/);
  assert.equal(calls.length, 0);
  const signedIn = await callback(state);
  assert.equal(signedIn.headers.get('Location'), '/#my-stats');
  const session = signedIn.headers.getSetCookie()[1].split(';')[0];
  assert.equal(createHash('sha256').update(calls[0].options.body.get('code_verifier')).digest('base64url'), challenge);
  assert.equal(calls[0].options.body.get('redirect_uri'), redirect);
  assert.match(calls[1].url, /users\/me/);
  const stats = await (await handler(request('?creator=999', { headers: { Cookie: session } }))).json();
  assert.deepEqual(statsCalls, ['42']);
  assert.equal(stats.account.handle, 'verified');
  assert.equal(stats.stats.overall.rank, 12);
  assert.equal(JSON.stringify(stats).includes('x-private-token'), false);
  const invalid = await handler(request('', { headers: { Cookie: session + 'a' } }));
  assert.equal((await invalid.json()).account, null);
  const signOut = await handler(request('/logout', { method: 'POST', headers: { Origin: origin, Cookie: session } }));
  assert.equal(signOut.status, 200);
  assert.ok(signOut.headers.getSetCookie().every(value => value.includes('Max-Age=0')));
});

test('My Stats uses the public ranks, yesterday’s snapshot and the best counted post', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const file of ['0000_aberrant_gamora.sql', '0001_creator_moderation.sql', '0003_campaign_weeks.sql', '0005_campaign_read_budget.sql', '0006_daily_ranks.sql']) {
      db.exec(await readFile(new URL(`../entropy-cloud/drizzle/${file}`, import.meta.url), 'utf8'));
    }
    db.exec(`INSERT INTO entropy_control (id,generation,updated_at) VALUES ('main','preview','2026-11-20');
      INSERT INTO entropy_campaign_weeks (id,label,topic,starts_at,ends_at,rubric_id)
      VALUES ('week-1','Week 1','Topic','2026-11-17T00:00:00Z','2026-11-22T00:00:00Z','rubric');`);
    const insert = db.prepare(`INSERT OR REPLACE INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at)
      VALUES ('preview',?,?,0,?,0)`);
    const put = (kind, id, value) => insert.run(kind, id, JSON.stringify(value));
    const savePost = (id, authorId, impressions, date = '2026-11-18') => put('post', id, { id, authorId, date, isReply: false,
      publishedAt: `${date}T10:00:00Z`, body: `Post ${id}`, metrics: { impressions, likes: 5, reposts: 0, quotes: 0, replies: 0 } });
    const approvePost = (id, status) => db.prepare(`INSERT INTO entropy_campaign_decisions
      (week_id,rubric_id,post_id,post_body,model_status) VALUES ('week-1','rubric',?,?,?)`).run(id, `Post ${id}`, status);
    put('dataset-meta', 'main', { asOf: '2026-11-20T00:00:00Z' });
    put('author', '41', { id: '41', handle: 'other', followers: 100 });
    put('author', '42', { id: '42', handle: 'verified', followers: 100, twitterScore: { smartFollowers: 8 } });
    put('author', '43', { id: '43', handle: 'removed', twitterScore: { smartFollowers: 15 } });
    put('author', '44', { id: '44', handle: 'early' });
    savePost('100', '41', 1500);
    savePost('101', '42', 100);
    savePost('102', '42', 400);
    savePost('103', '42', 9000);
    savePost('104', '43', 10000);
    savePost('105', '44', 20, '2026-11-16');
    approvePost('100', 'match');
    approvePost('101', 'review');
    approvePost('102', 'match');
    approvePost('103', 'match');
    put('state:postExclusions', '103', { authorId: '42' });
    put('state:postExclusions', '104', { authorId: '43' });
    const env = { DB: localD1Binding(db) };
    const url = new URL(origin);
    const today = Date.parse('2026-11-20T08:00:00Z');
    const yesterday = Date.parse('2026-11-19T08:00:00Z');
    assert.equal(await captureDailyRanks(env, url, yesterday), true);
    const saveRank = db.prepare('INSERT INTO entropy_daily_ranks (day,board,ranks) VALUES (?,?,?)');
    saveRank.run('2026-11-13', 'overall', '{"42":12}');
    saveRank.run('2026-11-14', 'overall', '{"42":7}');
    saveRank.run('2026-11-18', 'week-1/rubric', '{"42":4}');
    saveRank.run('2026-11-20', 'overall', '{"42":5}');
    savePost('102', '42', 2100);
    assert.equal(await captureDailyRanks(env, url, yesterday), false);
    const stats = await readMyStats(env, url, '42', today);
    assert.equal(stats.overall.rank, 1);
    assert.equal(stats.overall.previousRank, 2);
    assert.equal(stats.overall.hasPreviousSnapshot, true);
    assert.equal(stats.overall.rankChange, 1);
    assert.equal(stats.overall.views, 2200);
    assert.deepEqual(stats.rankHistory, [
      { day: '2026-11-14', rank: 7 }, { day: '2026-11-15', rank: null }, { day: '2026-11-16', rank: null },
      { day: '2026-11-17', rank: null }, { day: '2026-11-18', rank: null }, { day: '2026-11-19', rank: 2 },
      { day: '2026-11-20', rank: 1 },
    ]);
    assert.equal(stats.weeks[0].rank, 1);
    assert.equal(stats.weeks[0].previousRank, 2);
    assert.equal(stats.weeks[0].rankChange, 1);
    assert.equal(stats.weeks[0].postCount, 1);
    assert.equal(stats.topPost.id, '102');
    assert.equal(stats.topPost.body, 'Post 102');
    assert.equal(stats.smartFollowers, 8);
    const withoutHistory = (await readMyStats(env, url, '42', yesterday)).overall;
    assert.equal(withoutHistory.rankChange, null);
    assert.equal(withoutHistory.hasPreviousSnapshot, false);
    assert.equal((await readMyStats(env, url, '99', today)).overall.rank, null);

    const lookup = q => worker.fetch(new Request(new URL(`/api/leaderboard?view=stats&q=${encodeURIComponent(q)}`, url)), env);
    const response = await lookup(' @VERIFIED ');
    assert.equal(response.status, 200);
    const found = await response.json();
    assert.equal(found.account.handle, 'verified');
    assert.equal(found.account.id, '42');
    assert.equal(found.stats.overall.rank, stats.overall.rank);
    assert.equal(found.stats.overall.early, false);
    assert.equal((await (await lookup('early')).json()).stats.overall.early, true);
    assert.equal(found.stats.weeks[0].rank, stats.weeks[0].rank);
    assert.equal(found.stats.topPost.id, stats.topPost.id);
    assert.equal(found.stats.smartFollowers, 8);
    assert.equal((await lookup('veri')).status, 404);
    assert.equal((await lookup('removed')).status, 404);
    assert.equal((await lookup('invalid handle')).status, 400);

    const postsPage = async (creator, page) => worker.fetch(new Request(new URL(`/api/leaderboard?view=posts&creator=${creator}&page=${page}`, url)), env);
    assert.deepEqual((await (await postsPage('41', 1)).json()).posts, []);
    assert.equal((await postsPage('43', 1)).status, 404);
    for (let i = 110; i <= 120; i++) savePost(String(i), '42', null);
    const first = await (await postsPage('42', 1)).json();
    const second = await (await postsPage('42', 2)).json();
    assert.equal(first.posts.length, 10);
    assert.equal(first.totalPages, 2);
    assert.equal(second.posts.length, 2);
    assert.ok(first.posts.every(post => post.score === null));
    assert.deepEqual(second.posts.map(post => post.id), ['110', '101']);
    assert.equal(second.posts[1].score, postScore({ followers: 100, twitterScore: { smartFollowers: 8 } }, second.posts[1].metrics));
  } finally { db.close(); }
});

test('production My Stats signs in with HTTPS cookies and uses a protected Worker request', async t => {
  const production = 'https://entropy-entropy-app.vercel.app';
  const env = { X_SESSION_SECRET: 'a'.repeat(64), X_CLIENT_ID: 'test-id', X_CLIENT_SECRET: 'test-secret',
    X_OAUTH_ORIGIN: production, LEADERBOARD_API_URL: 'https://entropy.example.workers.dev/api/leaderboard' };
  const key = statsServiceKey(env.X_SESSION_SECRET);
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const upstream = new URL('/internal/my-stats?creator=42', env.LEADERBOARD_API_URL);
  assert.equal((await worker.fetch(new Request(upstream), { X_STATS_SERVICE_KEY: key })).status, 401);
  const headers = { Authorization: `Bearer ${key}` };
  assert.equal((await worker.fetch(new Request(new URL('/internal/my-stats?creator=no', upstream), { headers }), { X_STATS_SERVICE_KEY: key })).status, 400);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://api.x.com/2/oauth2/token') return Response.json({ access_token: 'x-token' });
    if (url.startsWith?.('https://api.x.com/2/users/me')) return Response.json({ data: { id: '42', username: 'verified' } });
    assert.equal(url.href, upstream.href);
    assert.equal(options.headers.Authorization, headers.Authorization);
    return Response.json({ overall: { rank: 12 } });
  });
  const start = await startApi.fetch(new Request(`${production}/api/my-stats/start`));
  const authorize = new URL(start.headers.get('Location'));
  const startCookie = start.headers.getSetCookie()[0];
  assert.match(startCookie, /^__Host-entropy-x-state=.+Path=\/; HttpOnly; SameSite=Lax; Secure$/);
  const code = new URL(authorize.searchParams.get('redirect_uri'));
  code.search = new URLSearchParams({ code: 'test-code', state: authorize.searchParams.get('state') });
  const signedIn = await callbackApi.fetch(new Request(code, { headers: { Cookie: startCookie.split(';')[0] } }));
  const session = signedIn.headers.getSetCookie()[1];
  assert.match(session, /^__Host-entropy-x-session=.+Path=\/; HttpOnly; SameSite=Lax; Secure$/);
  const stats = await statsApi.fetch(new Request(`${production}/api/my-stats?creator=999`, { headers: { Cookie: session.split(';')[0] } }));
  assert.equal(stats.headers.get('Cache-Control'), 'no-store');
  assert.equal((await stats.json()).stats.overall.rank, 12);
});
