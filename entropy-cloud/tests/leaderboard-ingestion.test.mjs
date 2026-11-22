import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { localD1Binding } from '../../entropy-app/local-d1.mjs';
import { fetchSmartFollowers, SMART_FOLLOWER_INTERVAL, TwitterScoreError } from '../../entropy-app/twitter-score.mjs';
import { collectLeaderboardPage } from '../leaderboard-ingestion.mjs';
import { collectSmartFollowers } from '../leaderboard-smart-followers.mjs';
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

test('manual recovery resumes saved cursors beyond the catch-up cap and preserves scheduled capacity', async context => {
  const f = fixture(context);
  await f.run(5, { searchPage: async () => page([tweet('102', 3)], 'saved-cursor') });
  f.db.exec(`UPDATE entropy_control SET daily_attempts=167 WHERE id='main';
    UPDATE entropy_leaderboard_ingestion SET payload=json_set(payload,'$.budget.catchupAttempts',48) WHERE id='main'`);
  const cursors = [];
  const client = { async searchPage({ cursor }) { cursors.push(cursor); return page(); } };
  const runRecovery = recoveryLimit => collectLeaderboardPage(f.env, { now: clock(7), client, recoveryLimit });

  assert.equal((await runRecovery(1)).status,'complete');
  assert.deepEqual(cursors,['saved-cursor']);
  assert.equal(f.state().budget.catchupAttempts,48);
  assert.equal(f.state().budget.recoveryAttempts,1);
  assert.equal((await runRecovery(1)).status,'recovery-budget');
  assert.equal((await f.run(8,client)).lane,'latest');
  assert.equal(f.db.prepare("SELECT daily_attempts FROM entropy_control WHERE id='main'").get().daily_attempts,169);
  assert.equal((await f.run(9,client)).status,'daily-budget');
});

test('TwitterScore rejects redirects without forwarding the API key', async () => {
  await assert.rejects(fetchSmartFollowers('11', 'fixture', async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return Response.redirect('https://example.invalid', 302);
  }), { code: 'unexpected_redirect' });
});

test('Smart Followers checks newly discovered authors first and refreshes older observations', async context => {
  const f = fixture(context);
  f.env.TWITTERSCORE_API_KEY = 'fixture';
  const now = clock(5);
  f.db.prepare(`UPDATE entropy_records SET payload=json_set(payload,'$.twitterScore.checkedAt',?)
    WHERE kind='author' AND record_id='11'`).run(new Date(now - SMART_FOLLOWER_INTERVAL).toISOString());
  await f.run(5, { async searchPage() {
    return page([tweet('102', 3, { author: { id: '12', userName: 'bob', name: 'Bob' } })]);
  } });
  const before = await f.ranking();
  assert.equal(before.rows.find(row => row.author.id === '12').author.twitterScore.smartFollowers, null);
  const checks = [];
  const lookup = async id => {
    checks.push(id);
    return id === '12' ? 0 : null;
  };
  const beforeRevision = f.revision();
  assert.deepEqual(await collectSmartFollowers(f.env, { now, lookup }), { status: 'checked', checked: 2 });
  assert.deepEqual(checks, ['12', '11']);
  assert.equal(f.payload('author', '11').twitterScore.smartFollowers, 200);
  assert.equal(f.payload('author', '11').twitterScore.status, 'unavailable');
  assert.equal(f.payload('author', '12').twitterScore.smartFollowers, 0);
  assert.equal(f.revision(), beforeRevision + 1);
  const ranking = await f.ranking();
  assert.equal(ranking.rows.find(row => row.author.id === '12').author.twitterScore.smartFollowers, 0);
  assert.deepEqual(await collectSmartFollowers(f.env, { now: now + 300_000, lookup }), { status: 'idle' });
});

test('a TwitterScore error saves completed lookups and pauses only Smart Followers collection', async context => {
  const f = fixture(context);
  f.env.TWITTERSCORE_API_KEY = 'fixture';
  f.add('author', '12', { id: '12', handle: 'bob' });
  const now = clock(5);
  const lookup = async id => {
    if (id === '12') throw new TwitterScoreError('rate_limited', 120);
    return 200;
  };
  const beforeRevision = f.revision();
  assert.deepEqual(await collectSmartFollowers(f.env, { now, lookup }),
    { status: 'provider-error', diagnostic: 'rate_limited', checked: 1 });
  assert.equal(f.revision(), beforeRevision);
  assert.equal(f.payload('author', '12').twitterScore, undefined);
  assert.deepEqual(await collectSmartFollowers(f.env, { now: now + 60_000, lookup }), { status: 'deferred' });
  await f.run(6, { async searchPage() { return page(); } });
  assert.equal(f.state().smartFollowers.nextAttemptAt, now + 120_000);
  assert.deepEqual(await collectSmartFollowers(f.env, { now: now + 120_000, lookup: async () => null }),
    { status: 'checked', checked: 1 });
  assert.equal(f.payload('author', '12').twitterScore.smartFollowers, null);
});

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
  f.db.exec("UPDATE entropy_control SET daily_date='2026-11-19',daily_attempts=168 WHERE id='main'");
  assert.equal((await f.run(5, client)).status, 'daily-budget');
  f.db.exec("UPDATE entropy_control SET daily_attempts=0 WHERE id='main'");
  f.db.prepare("INSERT INTO entropy_leaderboard_ingestion VALUES ('main',?)").run(JSON.stringify({
    version: 1, next: 0, streams: {}, budget: { day: '2026-11-19', month: '2026-11', units: 66600, catchupAttempts: 0 },
  }));
  assert.equal((await f.run(5, client)).status, 'monthly-budget');
});

test('the old-post batch refreshes the ranking after discovery and preserves text, moderation, and missing counts', async context => {
  const f = fixture(context);
  const publishedAt = '2026-10-10T09:00:00.000Z';
  const old = id => ({ id, authorId: '11', date: '2026-10-10', publishedAt, isReply: false,
    body: 'Archived @entropyIO post', metricsAsOf: '2026-11-18T16:00:00.000Z',
    metrics: { impressions: 50, likes: 10, reposts: 0, quotes: 0, replies: 1 } });
  f.add('post','201',old('201'));
  f.add('post','202',old('202'));
  f.add('post','203',old('203'));
  f.add('state:postExclusions','202',{authorId:'11',reason:'Archived decision',at:asOf});
  const before = await f.ranking();
  assert.equal(before.totals.views, 170);
  const calls = [];
  const client = {
    async searchPage() { calls.push('discovery'); return page(); },
    async tweetsByIds(ids) {
      calls.push(ids);
      return { tweets: [tweet('201',0,{createdAt:new Date(publishedAt).toUTCString(), text:'Different provider text',
        viewCount:125, likeCount:null, retweetCount:2, quoteCount:1})], unavailableEntries: 0 };
    },
  };
  for (const minute of [5,10,15,20]) assert.equal((await f.run(minute,client)).lane,'latest');
  const outcome=await f.run(25,client);
  assert.equal(outcome.status,'metrics-updated');
  assert.equal(outcome.checkedPosts,1);
  assert.equal(outcome.changedPosts,1);
  assert.deepEqual(calls,['discovery','discovery','discovery','discovery',['201','203']]);
  const updated=f.payload('post','201');
  assert.equal(updated.metrics.likes,10);
  assert.equal(updated.metrics.impressions,125);
  assert.equal(updated.body,'Archived @entropyIO post');
  assert(f.payload('post','203').availability.status==='unavailable');
  assert.equal(f.payload('post','203').metrics.impressions,50);
  assert.equal(f.payload('post','202').leaderboardMetricsCheckedAt,undefined);
  assert.equal(f.revision(),2);
  const after=await f.ranking();
  assert.equal(after.totals.views,245);
  assert.notEqual(before.rows[0].engagement,after.rows[0].engagement);
  assert.equal(f.state().budget.metricUnits,1);
  assert.equal((await f.run(30,client)).status,'idle');
  const current=f.state();
  current.metrics.nextAttemptAt=null;
  current.budget.metricUnits=30000;
  f.db.prepare("UPDATE entropy_leaderboard_ingestion SET payload=? WHERE id='main'").run(JSON.stringify(current));
  assert.equal((await f.run(35,client)).status,'idle');
  assert.equal(calls.length,5);
});
