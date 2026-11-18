import test from 'node:test';
import assert from 'node:assert/strict';
import Model from './model.js';
import { normalizeTweets, TwitterApiError } from './twitterapi.mjs';
import { beginBackfill, advanceBackfill } from './backfill.mjs';

const NOW = '2026-11-18T00:00:00.750Z';
const START = '2026-11-01T00:00:00Z';
const END = '2026-11-03T12:00:00.750Z';
const tweet = (id, at = '2026-11-01T12:00:00Z', changes = {}) => ({ id, createdAt: at, isReply: false, text: 'Useful @entropyIO explanation',
  author: { id: '200', userName: 'creator', name: 'Creator', followers: 50 },
  viewCount: 100, likeCount: 3, replyCount: 2, retweetCount: 1, quoteCount: 0, ...changes });
function wb(tweets = [], sync = {}) {
  return { dataset: Model.validateDataset(normalizeTweets(tweets, { observedAt: '2026-11-17T12:00:00Z',
      periodStart: '2026-11-01', periodEndExclusive: '2026-11-19' })), state: Model.initialState(),
    sync: { enabled: true, paused: false, requestCount: 8, intervalMs: 300000,
      phase: 'refresh', discovery: { pendingWindows: [{ start: START, endExclusive: '2026-11-02T00:00:00Z', cursor: 'old-cursor', seenCursors: [] }], coveredThrough: null },
      refresh: { pendingIds: ['111'], cycleStartedAt: '2026-11-17T12:00:00Z' }, ...sync } };
}
const begin = (workbench = wb(), options = {}) => beginBackfill(workbench, { start: START, endExclusive: END, now: NOW, ...options });
const exhausted = tweets => ({ tweets, hasNextPage: false, nextCursor: null });
const step = (workbench, provider, now) => advanceBackfill(workbench, { client: { searchPage: provider }, now: now || workbench.sync.backfill.nextAttemptAt });

test('two consecutive timeouts split a stalled window, while unknown network errors only defer', async () => {
  const timeout = async () => { throw new TwitterApiError('REQUEST_TIMEOUT', 'SECRET'); };
  let result = await step(begin(), timeout);
  assert.equal(result.sync.backfill.status, 'waiting'); assert.equal(result.sync.backfill.consecutiveTimeouts, 1);
  assert.equal(result.sync.backfill.pendingWindows.length, 3);
  result = await step(result, timeout);
  assert.equal(result.sync.backfill.status, 'running'); assert.equal(result.sync.backfill.pendingWindows.length, 4);
  assert.equal(result.sync.backfill.pendingWindows[0].endExclusive, '2026-11-01T12:00:00.000Z');
  assert.equal(result.sync.backfill.pendingWindows[1].start, '2026-11-01T12:00:00.000Z');
  assert.equal(result.sync.backfill.completedWindows, 0); assert.equal(result.sync.discovery.coveredThrough, null);
  assert.equal(result.sync.backfill.consecutiveTimeouts, 0); assert.equal(result.sync.backfill.gaps.length, 0);
  result = await step(result, timeout);
  result = await step(result, async () => { throw new TwitterApiError('NETWORK_ERROR', 'SECRET'); });
  assert.equal(result.sync.backfill.status, 'waiting'); assert.equal(result.sync.backfill.splitWindows, 1);
  assert.equal(result.sync.backfill.consecutiveTimeouts, 0);
  result = await step(result, timeout);
  assert.equal(result.sync.backfill.consecutiveTimeouts, 1); assert.equal(result.sync.backfill.splitWindows, 1);
  result = await step(result, async () => exhausted([]));
  assert.equal(result.sync.backfill.consecutiveTimeouts, 0); assert.equal(result.sync.backfill.timeoutWindow, null);
  let tiny = begin(wb(), { endExclusive: '2026-11-01T00:05:00Z' });
  tiny = await step(await step(tiny, timeout), timeout);
  assert.equal(tiny.sync.backfill.status, 'complete-with-gaps');
  assert.equal(tiny.sync.backfill.gaps[0].code, 'REQUEST_TIMEOUT');
  assert.equal(tiny.sync.backfill.completedWindows, 0); assert.equal(tiny.sync.discovery.coveredThrough, null);
  assert.ok(!JSON.stringify(tiny).includes('SECRET'));
});

test('fixed UTC cutoff creates all daily windows without changing regular progress or input', () => {
  const original = wb(), unchanged = structuredClone(original), result = begin(original);
  const job = result.sync.backfill;
  assert.equal(job.endExclusive, '2026-11-03T12:00:00.000Z');
  assert.equal(job.pendingWindows.length, 3); assert.equal(job.pendingWindows[0].start, '2026-11-01T00:00:00.000Z');
  assert.equal(job.pendingWindows[2].endExclusive, job.endExclusive);
  assert.deepEqual(result.sync.discovery, original.sync.discovery); assert.deepEqual(result.sync.refresh, original.sync.refresh);
  assert.deepEqual(original, unchanged); assert.equal(job.requestLimit, 250);
});
test('start rejects invalid ranges, future cutoffs, malformed dates and implicit collection enablement', () => {
  for (const options of [{ start: '2026-02-30' }, { endExclusive: '2026-11-18T01:00:00Z' }, { endExclusive: START },
    { start: '2026-01-01' }, { start: '2026-11-01T00:00:00' }, { requestLimit: 0 }, { requestLimit: 1001 }]) assert.throws(() => begin(wb(), options));
  assert.throws(() => begin(wb([], { enabled: false })), /Enable/);
  assert.throws(() => begin(wb([], { paused: true })), /Resume/);
});
test('collection methods have separate frozen jobs and cannot reuse an active method cursor', async () => {
  let search = begin();
  search = await step(search, async () => ({ tweets: [tweet('111')], hasNextPage: true, nextCursor: 'search-only-cursor' }));
  assert.equal(search.sync.backfill.method, 'search'); assert.match(search.sync.backfill.id, /^backfill:search:/);
  assert.throws(() => begin(search, { method: 'mentions' }), /different backfill/);
  assert.throws(() => begin(wb(), { method: 'unexpected' }), /method/);
  const stopped = structuredClone(search); stopped.sync.backfill.status = 'cancelled';
  let mentions = begin(stopped, { method: 'mentions' });
  assert.match(mentions.sync.backfill.id, /^backfill:mentions:/); assert.equal(mentions.sync.backfill.pendingWindows[0].cursor, '');
  assert.equal(mentions.sync.backfill.requestCount, 0); assert.equal(mentions.sync.requestCount, search.sync.requestCount);
  let calls = 0;
  mentions = await advanceBackfill(mentions, { now: mentions.sync.backfill.nextAttemptAt, client: {
    searchPage: async args => {
      calls++; assert.deepEqual(args, { query: '@entropyIO since_time:1793491200 until_time:1793577600 -filter:replies', cursor: '' });
      return { tweets: [tweet('111')], hasNextPage: true, nextCursor: 'mentions-only-cursor' };
    }
  } });
  assert.equal(calls, 1); assert.equal(mentions.sync.backfill.pendingWindows[0].cursor, 'mentions-only-cursor');
  const resumed = begin(mentions, { method: 'mentions', requestLimit: 300 });
  assert.equal(resumed.sync.backfill.requestCount, 1); assert.equal(resumed.sync.backfill.pendingWindows[0].cursor, 'mentions-only-cursor');
});
test('legacy search jobs resume their exact ID, paid count and cursor without becoming mentions jobs', () => {
  const original = begin(); delete original.sync.backfill.method;
  original.sync.backfill.id = 'backfill:' + original.sync.backfill.start + ':' + original.sync.backfill.endExclusive;
  original.sync.backfill.pendingWindows[0].cursor = 'legacy-search'; original.sync.backfill.requestCount = 7;
  const resumed = begin(original);
  assert.equal(resumed.sync.backfill.id, original.sync.backfill.id); assert.equal(resumed.sync.backfill.method, 'search');
  assert.equal(resumed.sync.backfill.requestCount, 7); assert.equal(resumed.sync.backfill.pendingWindows[0].cursor, 'legacy-search');
  assert.throws(() => begin(original, { method: 'mentions' }), /different backfill/);
});
test('ID-search uses exact BigInt Nov2 bounds and independently enforces the half-open mention window', async () => {
  const original = begin(wb(), { method: 'id-search', start: '2026-11-02T00:00:00Z', endExclusive: '2026-11-03T00:00:00Z', requestLimit: 10 });
  assert.match(original.sync.backfill.id, /^backfill:id-search:/); assert.equal(original.sync.backfill.method, 'id-search');
  let calls = 0;
  const result = await step(original, async args => {
    calls++; assert.deepEqual(args, { query: '@entropyIO since_id:2117044012446646271 max_id:2117406400312246271 -filter:replies', cursor: '' });
    return exhausted([tweet('2117200000000000001', '2026-11-02T12:00:00Z'),
      tweet('2117000000000000001', '2026-11-01T23:59:59Z'), tweet('2117500000000000001', '2026-11-03T00:00:00Z'),
      tweet('2117200000000000002', '2026-11-02T13:00:00Z', { text: '@entropyIOther' }),
      tweet('2117200000000000003', '2026-11-02T14:00:00Z', { author: { id: '201', userName: 'entropyIO' } })]);
  });
  assert.equal(calls, 1); assert.equal(result.sync.backfill.status, 'complete');
  assert.deepEqual(result.dataset.posts.map(post => post.id), ['2117200000000000001']);
  assert.equal(result.sync.backfill.lastPageStats.inRangeMentions, 1); assert.equal(result.sync.backfill.requestLimit, 10);
});
test('ID-search method checkpoints never inherit search or mentions cursors and reject pre-Snowflake bounds', async () => {
  for (const method of ['search', 'mentions']) {
    const original = begin(wb(), { method }); original.sync.backfill.pendingWindows[0].cursor = method + '-cursor';
    assert.throws(() => begin(original, { method: 'id-search' }), /different backfill/);
    original.sync.backfill.status = 'cancelled';
    let result = begin(original, { method: 'id-search', requestLimit: 10 });
    assert.equal(result.sync.backfill.pendingWindows[0].cursor, ''); assert.notEqual(result.sync.backfill.id, original.sync.backfill.id);
    result = await step(result, async () => ({ tweets: [tweet('111')], hasNextPage: true, nextCursor: 'id-only-cursor' }));
    const resumed = begin(result, { method: 'id-search', requestLimit: 10 });
    assert.equal(resumed.sync.backfill.requestCount, 1); assert.equal(resumed.sync.backfill.pendingWindows[0].cursor, 'id-only-cursor');
    assert.throws(() => begin(result, { method }), /different backfill/);
  }
  assert.throws(() => begin(wb(), { method: 'id-search', start: '2010-11-03', endExclusive: '2010-11-04' }), /Snowflake epoch/);
  const invalid = begin(wb(), { method: 'id-search' });
  Object.assign(invalid.sync.backfill.pendingWindows[0], { start: '2010-11-03T00:00:00Z', endExclusive: '2010-11-04T00:00:00Z' });
  let calls = 0;
  await assert.rejects(step(invalid, async () => { calls++; }), /Snowflake epoch/); assert.equal(calls, 0);
});
test('only one direct-mention search page is requested; raw views and missing values remain faithful', async () => {
  let count = 0;
  const result = await step(begin(), async ({ query, cursor }) => {
    count++; assert.equal(cursor, '');
    assert.equal(query, '@entropyIO since_time:1793491200 until_time:1793577600 -filter:replies');
    return exhausted([tweet('111'), tweet('112', '2026-11-01T13:00:00Z', { likeCount: null }),
      tweet('113', '2026-10-31T23:59:59Z'), tweet('114', undefined, { text: '@entropyIOther' }),
      tweet('115', undefined, { author: { id: '201', userName: 'entropyIO' } }), tweet('116', undefined, { isRetweet: true })]);
  });
  assert.equal(count, 1); assert.deepEqual(result.dataset.posts.map(post => post.id), ['111', '112']);
  assert.equal(result.dataset.posts[1].metrics.likes, null); assert.equal(result.sync.backfill.addedPosts, 2);
  assert.equal(result.sync.requestCount, 9); assert.equal(result.sync.backfill.requestCount, 1);
  assert.deepEqual(result.sync.backfill.lastPageStats, { rawTweets: 6, normalizedNonReposts: 5, inRangeMentions: 2,
    oldest: '2026-10-31T23:59:59.000Z', newest: '2026-11-01T13:00:00.000Z' });
  assert.equal(result.sync.backfill.fetchedRawTweets, 6); assert.equal(result.sync.backfill.fetchedNormalizedNonReposts, 5);
  assert.equal(result.sync.backfill.fetchedInRangeMentions, 2);
  assert.equal(result.dataset.meta.coverage, 'partial');
});
test('cursor and every paid page survive a later provider failure and explicit resume', async () => {
  let result = begin();
  result = await step(result, async () => ({ tweets: [tweet('111')], hasNextPage: true, nextCursor: 'opaque-1' }));
  assert.equal(result.sync.backfill.pendingWindows[0].cursor, 'opaque-1');
  result = await step(result, async ({ cursor }) => { assert.equal(cursor, 'opaque-1'); throw new TwitterApiError('NETWORK_ERROR', 'secret body'); });
  assert.equal(result.sync.backfill.status, 'waiting'); assert.equal(result.dataset.posts.length, 1);
  assert.equal(result.sync.backfill.pendingWindows[0].cursor, 'opaque-1');
  assert.ok(!JSON.stringify(result.sync.backfill.lastError).includes('secret'));
  let calls = 0; const held = await step(result, async () => { calls++; }, result.sync.backfill.lastAttemptAt);
  assert.equal(calls, 0); assert.equal(held.sync.backfill.requestCount, 2);
  result = await step(result, async ({ cursor }) => { assert.equal(cursor, 'opaque-1'); return exhausted([tweet('112', '2026-11-01T11:00:00Z')]); });
  assert.equal(result.dataset.posts.length, 2); assert.equal(result.sync.backfill.completedWindows, 1);
});
test('deduplication and moderation survive full historical paging and newer null counters', async () => {
  const original = wb([tweet('111')]); original.dataset.posts[0].workId = 'manual-thread';
  original.state = Model.decision(original.state, { type: 'ban', authorId: '200', periodKey: '2026-11', reason: 'Visible reason', internalNote: 'PRIVATE' }, '2026-11-17T13:00:00Z');
  let result = begin(original);
  result = await step(result, async () => ({ tweets: [tweet('111', undefined, { viewCount: 150, likeCount: null })], hasNextPage: true, nextCursor: 'next' }));
  result = await step(result, async () => exhausted([tweet('111', undefined, { viewCount: 150, likeCount: null })]));
  assert.equal(result.dataset.posts.length, 1); assert.equal(result.dataset.posts[0].metrics.impressions, 150);
  assert.equal(result.dataset.posts[0].metrics.likes, 3); assert.equal(result.dataset.posts[0].workId, 'manual-thread');
  assert.equal(result.sync.backfill.addedPosts, 0); assert.equal(result.state.bans['200'].reason, 'Visible reason');
  const view = Model.creatorView(result.dataset, result.state, '200', Model.periodFor('2026-11', result.dataset));
  assert.equal(view.status, 'banned'); assert.ok(!JSON.stringify(view).includes('PRIVATE'));
});
test('run limit stops cleanly and an explicit same-job extension never resets progress', async () => {
  let result = begin(wb(), { requestLimit: 1 });
  result = await step(result, async () => ({ tweets: [tweet('111')], hasNextPage: true, nextCursor: 'resume-here' }));
  assert.equal(result.sync.backfill.status, 'request-limit');
  let calls = 0; await step(result, async () => { calls++; }); assert.equal(calls, 0);
  const unchanged = begin(result, { requestLimit: 1 }); assert.equal(unchanged.sync.backfill.status, 'request-limit');
  result = begin(result, { requestLimit: 3 }); assert.equal(result.sync.backfill.status, 'running');
  assert.equal(result.sync.backfill.requestCount, 1); assert.equal(result.sync.backfill.pendingWindows[0].cursor, 'resume-here');
  assert.throws(() => begin(result, { endExclusive: '2026-11-04T00:00:00Z' }), /different backfill/);
});
test('all daily windows exhaust before a run completes, then hourly checkpoints advance', async () => {
  const original = wb(); original.sync.discovery.recentWindow = { start: '2026-11-03T11:00:00Z', endExclusive: '2026-11-03T11:30:00Z', cursor: 'legacy' };
  let result = begin(original), calls = [];
  while (result.sync.backfill.status === 'running') result = await step(result, async args => { calls.push(args); return exhausted([]); });
  assert.equal(calls.length, 3); assert.equal(result.sync.backfill.status, 'complete'); assert.equal(result.sync.backfill.completedWindows, 3);
  assert.equal(result.sync.discovery.coveredThrough, result.sync.backfill.endExclusive); assert.equal(result.sync.discovery.pendingWindows.length, 0);
  assert.equal(result.sync.discovery.recentWindow, null); assert.equal(result.sync.phase, 'discovery');
  assert.equal(result.sync.enabled, true); assert.equal(result.sync.intervalMs, 300000); assert.equal(result.dataset.meta.coverage, 'partial');
  const resumed = begin(result); assert.equal(resumed.sync.backfill.requestCount, 3);
});
test('known direct mentions omitted from exhausted history become counted coverage gaps', async () => {
  const original = wb([tweet('111', '2026-11-02T10:00:00Z'), tweet('112', '2026-11-02T11:00:00Z'),
    tweet('113', '2026-11-02T12:00:00Z', { text: 'Different topic' })]);
  let result = begin(original);
  while (result.sync.backfill.status === 'running') result = await step(result, async () => exhausted([]));
  const job = result.sync.backfill;
  assert.equal(job.status, 'complete-with-gaps'); assert.equal(job.gaps.length, 1);
  assert.deepEqual(job.gaps[0], { code: 'KNOWN_POST_NOT_RETURNED', count: 2, at: job.gaps[0].at,
    start: '2026-11-02T00:00:00.000Z', endExclusive: '2026-11-03T00:00:00.000Z' });
  assert.equal(result.sync.discovery.coveredThrough, null); assert.equal(result.dataset.posts.length, 3);
  assert.equal(job.measuredPages, 3); assert.equal(job.fetchedRawTweets, 0);
  assert.deepEqual(job.lastPageStats, { rawTweets: 0, normalizedNonReposts: 0, inRangeMentions: 0, oldest: null, newest: null });
  assert.equal(JSON.stringify(job.gaps).includes('111'), false);
});
test('known-post observations survive cursor checkpoints and retain cumulative measured counts', async () => {
  let result = begin(wb([tweet('111')]), { endExclusive: '2026-11-02T00:00:00Z' });
  result = await step(result, async () => ({ tweets: [tweet('111')], hasNextPage: true, nextCursor: 'seen-first' }));
  assert.deepEqual(result.sync.backfill.observedPostIds, ['111']);
  // A retained old metric timestamp must not erase positive observation evidence.
  result.dataset.posts[0].metricsAsOf = '2026-11-17T00:00:00Z';
  result = await step(result, async () => exhausted([]));
  assert.equal(result.sync.backfill.status, 'complete'); assert.equal(result.sync.backfill.gaps.length, 0);
  assert.equal(result.sync.backfill.measuredPages, 2); assert.equal(result.sync.backfill.fetchedRawTweets, 1);
  assert.equal(result.sync.backfill.fetchedNormalizedNonReposts, 1); assert.equal(result.sync.backfill.fetchedInRangeMentions, 1);
});
test('legacy completed windows are audited before completion without inventing older page statistics', async () => {
  let result = begin(wb([tweet('111', '2026-11-02T10:00:00Z'), tweet('112', '2026-11-02T11:00:00Z')]));
  const job = result.sync.backfill;
  job.completedRanges = job.pendingWindows.splice(0, 2).map(({ start, endExclusive }) => ({ start, endExclusive }));
  job.completedWindows = 2; job.successfulPages = 2;
  for (const key of ['observedPostIds', 'measuredPages', 'lastPageStats', 'pageStatsStartedAt',
    'fetchedRawTweets', 'fetchedNormalizedNonReposts', 'fetchedInRangeMentions']) delete job[key];
  result = await step(result, async () => exhausted([]));
  assert.equal(result.sync.backfill.status, 'complete-with-gaps'); assert.equal(result.sync.backfill.gaps.length, 1);
  assert.equal(result.sync.backfill.gaps[0].count, 2); assert.equal(result.sync.backfill.gaps[0].start, '2026-11-02T00:00:00.000Z');
  assert.equal(result.sync.discovery.coveredThrough, null); assert.equal(result.sync.backfill.successfulPages, 3);
  assert.equal(result.sync.backfill.measuredPages, 1); assert.equal(result.sync.backfill.fetchedRawTweets, 0);
});
test('completed range does not discard windows or source coverage before/after its own cutoff', async () => {
  const original = wb();
  original.sync.discovery.pendingWindows = [
    { start: '2026-10-31T00:00:00Z', endExclusive: '2026-11-01T01:00:00Z', cursor: 'before' },
    { start: '2026-11-03T11:00:00Z', endExclusive: '2026-11-04T00:00:00Z', cursor: 'after' }];
  let result = begin(original);
  while (result.sync.backfill.status === 'running') result = await step(result, async () => exhausted([]));
  assert.equal(result.sync.discovery.coveredThrough, null);
  assert.equal(result.sync.discovery.pendingWindows.length, 2);
  assert.equal(result.sync.discovery.pendingWindows[0].endExclusive, '2026-11-01T00:00:00.000Z');
  assert.equal(result.sync.discovery.pendingWindows[1].start, result.sync.backfill.endExclusive);
  assert.equal(result.sync.discovery.pendingWindows[1].cursor, '');
});
test('pagination anomalies split windows and never falsely advance historical coverage', async () => {
  let result = begin();
  result = await step(result, async () => ({ tweets: [tweet('111')], hasNextPage: true, nextCursor: 'next' }));
  result = await step(result, async () => ({ tweets: [tweet('112', '2026-11-01T13:00:00Z')], hasNextPage: true, nextCursor: 'again' }));
  assert.equal(result.sync.backfill.splitWindows, 1); assert.equal(result.sync.backfill.pendingWindows.length, 4);
  assert.equal(result.sync.backfill.pendingWindows[0].cursor, ''); assert.equal(result.dataset.posts.length, 2);
  assert.equal(result.sync.discovery.coveredThrough, null); assert.equal(result.sync.backfill.completedWindows, 0);
});
test('minimum-window stalls are recorded as unresolved gaps while other windows still progress', async () => {
  let result = begin(wb(), { endExclusive: '2026-11-01T00:05:00Z' });
  result = await step(result, async () => ({ tweets: [], hasNextPage: true, nextCursor: 'empty-next' }));
  assert.equal(result.sync.backfill.status, 'complete-with-gaps'); assert.equal(result.sync.backfill.gaps[0].code, 'EMPTY_CONTINUATION');
  assert.equal(result.sync.backfill.completedWindows, 0); assert.equal(result.sync.discovery.coveredThrough, null);
});
test('adapter-level cursor rejection also subdivides instead of waiting on a permanent cursor loop', async () => {
  const result = await step(begin(), async () => { throw new TwitterApiError('INVALID_RESPONSE', 'Некоректний курсор наступної сторінки.'); });
  assert.equal(result.sync.backfill.status, 'running'); assert.equal(result.sync.backfill.splitWindows, 1);
  assert.equal(result.sync.backfill.paginationRetries, 1); assert.equal(result.sync.backfill.requestCount, 1);
});
test('auth and credits pause safely; disabled or paused collectors never make a request', async () => {
  for (const status of [401, 402, 403]) {
    const result = await step(begin(), async () => { throw new TwitterApiError('HTTP_ERROR', 'SECRET', status); });
    assert.equal(result.sync.paused, true); assert.equal(result.sync.backfill.status, 'paused');
    assert.ok(!JSON.stringify(result.sync.backfill.lastError).includes('SECRET'));
  }
  for (const change of [{ enabled: false }, { paused: true }]) {
    const original = begin(); Object.assign(original.sync, change); let calls = 0;
    const result = await step(original, async () => { calls++; }); assert.equal(calls, 0); assert.equal(result.sync.backfill.requestCount, 0);
  }
});
test('rate limits preserve exact cursor and defer retries with safe diagnostics', async () => {
  const original = begin(); original.sync.backfill.pendingWindows[0].cursor = 'keep-me'; original.sync.backfill.pendingWindows[0].queryVersion = 'posts-v1';
  const result = await step(original, async () => { throw new TwitterApiError('RATE_LIMITED', 'secret', 429); });
  assert.equal(result.sync.backfill.status, 'waiting'); assert.equal(result.sync.paused, false);
  assert.equal(result.sync.backfill.pendingWindows[0].cursor, 'keep-me'); assert.equal(result.sync.backfill.lastError.httpStatus, 429);
  assert.ok(Date.parse(result.sync.backfill.nextAttemptAt) > Date.parse(result.sync.backfill.lastAttemptAt));
});
test('legacy backfill cursor is restarted for filtered search without resetting the request count', async () => {
  const original = begin(); original.sync.backfill.pendingWindows[0].cursor = 'legacy'; original.sync.backfill.requestCount = 3;
  let request;
  const result = await step(original, async args => { request = args; return exhausted([tweet('111'), tweet('112', undefined, { isReply: true })]); });
  assert.equal(request.cursor, ''); assert.match(request.query, /-filter:replies/);
  assert.equal(result.sync.backfill.requestCount, 4); assert.deepEqual(result.dataset.posts.map(p => p.id), ['111']);
});
test('malformed pages and ownership conflicts never commit data or consume the stored cursor', async () => {
  const original = begin(wb([tweet('111')])); original.sync.backfill.pendingWindows[0].cursor = 'original'; original.sync.backfill.pendingWindows[0].queryVersion = 'posts-v1';
  const before = structuredClone(original.dataset);
  const result = await step(original, async () => exhausted([tweet('111', undefined, { author: { id: '999', userName: 'other' } })]));
  assert.deepEqual(result.dataset, before); assert.equal(result.sync.backfill.pendingWindows[0].cursor, 'original');
  assert.equal(result.sync.backfill.lastError.diagnosticCode, 'POST_OWNERSHIP_CONFLICT');
});
