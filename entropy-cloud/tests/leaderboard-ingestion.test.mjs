import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { localD1Binding } from '../../entropy-app/local-d1.mjs';
import { collectLeaderboardPage } from '../leaderboard-ingestion.mjs';
import worker from '../leaderboard-worker.mjs';

const start = '2026-11-19T09:00:00.000Z';
const asOf = '2026-11-19T09:03:00.000Z';
const generation = 'collector-test';
const clock = minute => Date.parse('2026-11-19T09:' + String(minute).padStart(2, '0') + ':00.000Z');
const migrations = await Promise.all([
  '0000_aberrant_gamora.sql', '0001_creator_moderation.sql', '0002_leaderboard_ingestion.sql',
].map(file => readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8')));

function tweet(id, minute, extra = {}) {
  return {
    id, createdAt: new Date(clock(minute)).toUTCString(), text: 'Creator post @entropyIO', isReply: false,
    viewCount: 100, likeCount: 5, retweetCount: 1, quoteCount: 0, replyCount: 0,
    author: { id: '11', userName: 'alice', name: 'Alice', profilePicture: 'https://pbs.twimg.com/profile_images/1/test.png' },
    ...extra,
  };
}

function fixture(context) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  for (const migration of migrations) db.exec(migration);
  db.prepare("INSERT INTO entropy_control (id,generation,revision,updated_at) VALUES ('main',?,1,?)").run(generation, asOf);
  const add = (kind, id, value) => db.prepare(`
    INSERT INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at) VALUES (?,?,?,0,?,0)
  `).run(generation, kind, id, JSON.stringify(value));
  add('dataset-meta', 'main', { asOf, periodStart: start.slice(0, 10), periodEndExclusive: '2026-11-20' });
  add('author', '11', { id: '11', handle: 'alice', displayName: 'Reviewed Alice', twitterScore: { smartFollowers: 200 } });
  add('post', '101', { id: '101', authorId: '11', date: start.slice(0, 10), publishedAt: start, isReply: false,
    body: 'Existing @entropyIO post', metrics: { impressions: 70, likes: 2, reposts: 1, quotes: 0, replies: 1 } });
  const cache = new Map();
  const env = {
    DB: localD1Binding(db), ENTROPY_SCAN_START_UTC: start,
    previewCache: {
      async match(url) { return cache.get(url)?.clone(); },
      async put(url, response) { cache.set(url, response.clone()); },
    },
  };
  const state = () => JSON.parse(db.prepare('SELECT payload FROM entropy_leaderboard_ingestion').get().payload);
  const revision = () => db.prepare("SELECT revision FROM entropy_control WHERE id='main'").get().revision;
  const payload = (kind, id) => {
    const row = db.prepare('SELECT payload FROM entropy_records WHERE generation=? AND kind=? AND record_id=?').get(generation,kind,id);
    return row ? JSON.parse(row.payload) : null;
  };
  async function ranking() {
    const response = await worker.fetch(new Request('https://ranking.example/api/leaderboard?view=ranking'), env);
    assert.equal(response.status, 200);
    return response.json();
  }
  const run = (minute, client) => collectLeaderboardPage(env, { now: clock(minute), client });
  return { db, add, env, run, state, revision, payload, ranking };
}

const page = (tweets = [], nextCursor = null) => ({ tweets, hasNextPage: Boolean(nextCursor), nextCursor });

test('independent queries collect new posts, publish ranks once, and resume the saved cursor', async context => {
  const f = fixture(context);
  const before = await f.ranking();
  assert.equal(before.totals.posts, 1);
  const calls = [];
  const client = { async searchPage({ query, cursor }) {
    calls.push({ query, cursor });
    if (calls.length === 1) return page([tweet('103', 4, { isReply: true }), tweet('102', 3), tweet('101', 0)], 'first-next');
    if (cursor === 'first-next') return page([tweet('104', 0, { quoted_tweet: { id: '991' } })]);
    return page([tweet('102', 3)]);
  } };
  assert.equal((await f.run(5, client)).addedPosts, 1);
  assert.equal(f.revision(), 2);
  for (const minute of [10, 15, 20]) assert.equal((await f.run(minute, client)).addedPosts, 0);
  assert.equal(f.revision(), 2);
  assert.equal((await f.run(25, client)).addedPosts, 1);
  assert.equal(f.revision(), 3);
  assert.deepEqual(calls.slice(0, 4).map(call => call.query.split(' since_time:')[0]),
    ['@entropyIO', 'entropyIO', '@entropyIO filter:quote', 'entropyIO filter:quote']);
  assert(calls.every(call => call.query.endsWith(' -filter:replies')));
  assert.equal(calls[4].cursor, 'first-next');
  assert.equal(f.payload('post', '103'), null);
  assert.equal(f.payload('post', '101').metrics.impressions, 70);
  assert.equal(f.payload('author', '11').twitterScore.smartFollowers, 200);
  assert.equal((await f.ranking()).totals.views, 270);
  assert.equal((await f.ranking()).totals.posts, 3);
  assert.equal((await f.run(30, client)).status, 'idle');
});

test('overlapping triggers reserve a single paid page and leave the provider failure recoverable', async context => {
  const f = fixture(context);
  let notify, finish, requests = 0;
  const started = new Promise(resolve => { notify = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  const client = { async searchPage() {
    requests++;
    notify();
    await waiting;
    throw Object.assign(new Error('sensitive provider body'), { code: 'REQUEST_TIMEOUT' });
  } };
  const first = f.run(5, client);
  await started;
  assert.equal((await f.run(5, client)).status, 'busy');
  const reserved = f.state();
  assert.equal(reserved.budget.units, 100);
  finish();
  assert.equal((await first).status, 'provider-error');
  assert.equal(requests, 1);
  assert.equal(f.revision(), 1);
  const saved = f.state();
  assert.equal(saved.streams.mentions.hourly.pendingWindows.length, 1);
  assert(!JSON.stringify(saved).includes('sensitive provider body'));
  assert.equal((await f.ranking()).totals.posts, 1);
});

test('daily and monthly budget limits prevent requests before querying the provider', async context => {
  const f = fixture(context);
  const client = { async searchPage() { assert.fail('Budget should prevent a provider call.'); } };
  f.db.exec("UPDATE entropy_control SET daily_date='2026-11-19',daily_attempts=144 WHERE id='main'");
  assert.equal((await f.run(5, client)).status, 'daily-budget');
  f.db.exec("UPDATE entropy_control SET daily_attempts=0 WHERE id='main'");
  f.db.prepare("INSERT INTO entropy_leaderboard_ingestion VALUES ('main',?)").run(JSON.stringify({
    version: 1, next: 0, streams: {}, budget: { day: '2026-11-19', month: '2026-11', units: 19950, catchupAttempts: 0 },
  }));
  assert.equal((await f.run(5, client)).status, 'monthly-budget');
});
