import test from 'node:test';
import assert from 'node:assert/strict';
import Model from './model.js';
import { mergeDataset, advanceSync, advanceHourlyDiscovery, classifySyncError } from './live-engine.mjs';

const START = '2026-11-17T12:00:00.000Z';
const LATER = '2026-11-17T12:05:00.000Z';
const author = { id: '200', handle: 'creator', followers: 12, smartFollowersComplete: false, smartEngagementComplete: false };
const rawTweet = (id = '111', more = {}) => ({ id, isReply: false, text: 'Useful explanation of @entropyIO', createdAt: '2026-11-01T12:00:00Z',
  author: { id: '200', userName: 'creator', name: 'Creator', followers: 12 },
  viewCount: 100, likeCount: 3, retweetCount: 0, quoteCount: 1, replyCount: 1, ...more });
const post = (id = '111', more = {}) => ({ id, authorId: '200', authorHandle: 'creator', date: '2026-11-01', publishedAt: '2026-11-01T12:00:00.000Z',
  url: 'https://x.com/creator/status/' + id, body: 'Useful explanation of @entropyIO', workId: null,
  metrics: { impressions: 100, likes: 3, reposts: 0, uiReposts: null, quotes: 1, replies: 1, bookmarks: null },
  metricsAsOf: '2026-11-17T10:00:00.000Z', ...more });
function data(posts = [post()], authors = [author], asOf = '2026-11-17T10:00:00.000Z') {
  return Model.validateDataset({ meta: { source: 'twitterapi.io', coverage: 'partial', asOf, periodStart: '2026-11-01', periodEndExclusive: '2026-12-01' }, authors, posts, accounts: [], followRelations: [], interactions: [] });
}
function wb(dataset = data(), sync = {}) { return { dataset, state: Model.initialState(), sync: { enabled: true, ...sync } }; }
function client(search, refresh) {
  return { searchPage: search || (async () => ({ tweets: [], hasNextPage: false, nextCursor: null })),
    tweetsByIds: refresh || (async () => ({ tweets: [], missingIds: [] })) };
}

test('incremental merge retains absent posts, manual work grouping and smart source data', () => {
  const before = data([post('111', { workId: 'thread:manual' }), post('112')]);
  before.authors[0].smartFollowersComplete = true;
  before.accounts = [{ id: '300', trust: 1, reason: 'Reviewed person', evidence: [{ url: 'https://x.com/person' }] }];
  before.followRelations = [{ authorId: '200', accountId: '300', confirmed: true }];
  before.interactions = [{ authorId: '200', accountId: '300', postId: '111', type: 'quote', meaningful: true, occurredAt: '2026-11-02T12:00:00Z' }];
  const incoming = data([post('111', { metrics: { impressions: 150, likes: null } })], [{ ...author, followers: null }], START);
  const untouched = structuredClone(before), merged = mergeDataset(before, incoming);
  assert.equal(merged.posts.length, 2); assert.equal(merged.posts[0].workId, 'thread:manual');
  assert.equal(merged.posts[0].metrics.likes, 3); assert.equal(merged.authors[0].followers, 12);
  assert.equal(merged.authors[0].smartFollowersComplete, true);
  assert.deepEqual(merged.accounts, before.accounts); assert.deepEqual(merged.followRelations, before.followRelations); assert.deepEqual(merged.interactions, before.interactions);
  assert.deepEqual(before, untouched); assert.equal(merged.meta.coverage, 'partial');
});
test('null counts retain old timestamps; genuine newer decreases replace counts and are flagged', () => {
  const previous = data();
  const incoming = data([post('111', { metrics: { impressions: 80, likes: null }, metricsAsOf: START })], [author], START);
  const merged = mergeDataset(previous, incoming), p = merged.posts[0];
  assert.equal(p.metrics.impressions, 80); assert.equal(p.metrics.likes, 3);
  assert.equal(p.metricsObservedAt.impressions, START); assert.equal(p.metricsObservedAt.likes, previous.posts[0].metricsAsOf);
  assert.equal(p.metricsAsOf, previous.posts[0].metricsAsOf);
  assert.equal(p.metricCorrections[0].field, 'impressions'); assert.equal(p.metricCorrections[0].previous, 100);
  assert.ok(p.missingInLatest.includes('likes'));
});
test('older observations cannot overwrite more recent counters', () => {
  const old = data([post('111', { metrics: { impressions: 900 }, metricsAsOf: '2026-11-17T09:00:00Z' })], [author], START);
  const merged = mergeDataset(data(), old);
  assert.equal(merged.posts[0].metrics.impressions, 100); assert.equal(merged.posts[0].metricCorrections.length, 0);
});
test('post-backed identity mapping remaps all old work and smart relationships, never canonical owners', () => {
  const previous = data([post('111', { authorId: 'sample:creator' }), post('112', { authorId: 'sample:creator' })], [{ ...author, id: 'sample:creator' }]);
  previous.followRelations = [{ authorId: 'sample:creator', accountId: '300', confirmed: true }];
  previous.interactions = [{ authorId: 'sample:creator', accountId: '300', postId: '112', type: 'reply' }];
  const merged = mergeDataset(previous, data());
  assert.deepEqual(merged.authors.map(a => a.id), ['200']); assert.ok(merged.posts.every(p => p.authorId === '200'));
  assert.equal(merged.followRelations[0].authorId, '200'); assert.equal(merged.interactions[0].authorId, '200');
  const conflict = data([post('111', { authorId: '999' })], [{ ...author, id: '999' }]);
  assert.throws(() => mergeDataset(data(), conflict), /ownership/);
});
test('disabled, not-due and zero-budget ticks make no provider requests', async () => {
  let calls = 0; const provider = client(async () => { calls++; throw new Error('Unexpected'); });
  await advanceSync(wb(data(), { enabled: false }), { client: provider, now: START });
  await advanceSync(wb(data(), { nextRunAt: LATER }), { client: provider, now: START });
  await advanceSync(wb(), { client: provider, now: START, maxRequests: 0 });
  assert.equal(calls, 0);
});
test('an immediate millisecond-precision schedule is due at that same instant', async () => {
  const now = '2026-11-17T12:00:00.750Z'; let calls = 0;
  const result = await advanceSync(wb(data([], []), { nextRunAt: now }), { now, client: client(async () => {
    calls++; return { tweets: [], hasNextPage: false, nextCursor: null };
  }) });
  assert.equal(calls, 1); assert.equal(result.sync.lastAttemptAt, now);
  assert.equal(result.sync.nextRunAt, '2026-11-17T12:05:00.750Z');
});
test('first discovery finds fresh mentions while retaining the entire UTC month backlog', async () => {
  const calls = [];
  const result = await advanceSync(wb(data([], [])), { now: START, maxRequests: 99, client: client(async args => {
    calls.push(args); return { tweets: [rawTweet('111', { createdAt: '2026-11-17T11:45:00Z' })], hasNextPage: true, nextCursor: 'opaque-1' };
  }) });
  assert.equal(calls.length, 1); assert.equal(calls[0].query, '@entropyIO since_time:' + Date.parse('2026-11-17T11:30:00Z') / 1000 + ' until_time:' + Date.parse(START) / 1000 + ' -filter:replies');
  assert.equal(result.sync.discovery.recentWindow.cursor, 'opaque-1');
  assert.equal(result.sync.discovery.pendingWindows[0].start, '2026-11-01T00:00:00.000Z');
  assert.equal(result.sync.discovery.pendingWindows.length, 17);
  assert.equal(result.sync.discovery.coveredThrough, null); assert.equal(result.sync.requestCount, 1);
  assert.equal(result.sync.lastSuccessAt, START); assert.equal(result.dataset.posts.length, 1);
});
test('recent cursor resumes across metric refresh and a backfill turn without losing either queue', async () => {
  const calls = [], observed = new Map(); let recentPages = 0;
  const provider = client(async args => {
    calls.push(args);
    if (args.query.includes('since_time:1793491200 ')) return { tweets: [], hasNextPage: false, nextCursor: null };
    recentPages++;
    const tweet = rawTweet(String(110 + recentPages), { createdAt: recentPages === 1 ? '2026-11-17T11:50:00Z' : '2026-11-17T11:40:00Z' });
    observed.set(tweet.id, tweet);
    return { tweets: [tweet], hasNextPage: recentPages === 1, nextCursor: recentPages === 1 ? 'resume-me' : null };
  }, async ids => ({ tweets: ids.map(id => observed.get(id)), missingIds: [] }));
  let result = await advanceSync(wb(data([], [])), { client: provider, now: START });
  const queued = result.sync.discovery.pendingWindows.length;
  result = await advanceSync(result, { client: provider, now: LATER });
  assert.equal(result.sync.phase, 'discovery'); assert.equal(result.sync.discovery.pendingWindows.length, queued);
  result = await advanceSync(result, { client: provider, now: '2026-11-17T12:10:00Z' });
  assert.equal(result.sync.discovery.recentWindow.cursor, 'resume-me');
  assert.equal(result.sync.discovery.pendingWindows.length, queued - 1); assert.equal(result.sync.discovery.coveredThrough, '2026-11-02T00:00:00.000Z');
  result = await advanceSync(result, { client: provider, now: '2026-11-17T12:15:00Z' });
  result = await advanceSync(result, { client: provider, now: '2026-11-17T12:20:00Z' });
  assert.equal(calls[2].cursor, 'resume-me'); assert.equal(calls[2].query, calls[0].query);
  assert.equal(result.sync.discovery.recentThrough, START); assert.equal(result.sync.discovery.recentWindow, null);
  assert.equal(result.sync.discovery.pendingWindows.length, queued - 1);
  assert.equal(result.dataset.posts.length, 2);
});
test('subsequent discovery overlaps five minutes instead of rescanning the month', async () => {
  let query;
  const result = await advanceSync(wb(data([], []), { discovery: { pendingWindows: [], coveredThrough: '2026-11-17T11:55:00.000Z' } }), {
    now: START, client: client(async args => { query = args.query; return { tweets: [], hasNextPage: false, nextCursor: null }; }) });
  assert.ok(query.includes('since_time:' + Date.parse('2026-11-17T11:50:00Z') / 1000));
  assert.equal(result.sync.discovery.coveredThrough, START);
});
test('raw search candidates must directly mention target, belong to the time window, and not be own/repost work', async () => {
  const valid = rawTweet('111', { createdAt: '2026-11-17T11:45:00Z' });
  const other = rawTweet('112', { createdAt: valid.createdAt, text: 'About @entropyIOOther' });
  const outside = rawTweet('113', { createdAt: START });
  const own = rawTweet('114', { createdAt: valid.createdAt, author: { id: '100', userName: 'entropyIO', followers: 4 } });
  const repost = rawTweet('115', { createdAt: valid.createdAt, isRetweet: true, retweeted_tweet: { id: '1' } });
  const result = await advanceSync(wb(data([], [])), { now: START, client: client(async () => ({ tweets: [valid, other, outside, own, repost], hasNextPage: false, nextCursor: null })) });
  assert.deepEqual(result.dataset.posts.map(p => p.id), ['111']); assert.equal(result.dataset.authors.length, 1);
});
test('unavailable by-ID posts preserve metrics and moderation, and are flagged for review', async () => {
  const before = wb(data(), { phase: 'refresh', requestCount: 1 });
  before.state = Model.decision(before.state, { type: 'ban', authorId: '200', periodKey: '2026-11', reason: 'Visible reason', internalNote: 'PRIVATE_NOTE' }, START);
  const result = await advanceSync(before, { now: START, client: client(null, async () => ({ tweets: [], missingIds: ['111'] })) });
  assert.equal(result.dataset.posts[0].metrics.impressions, 100); assert.equal(result.dataset.posts[0].availability.status, 'unavailable');
  assert.equal(result.state.bans['200'].reason, 'Visible reason'); assert.equal(result.state.bans['200'].internalNote, 'PRIVATE_NOTE');
  assert.ok(result.sync.gaps.some(g => g.code === 'POSTS_UNAVAILABLE')); assert.equal(result.sync.lastSuccessAt, START);
});
test('regular refresh batches are bounded to twenty IDs and queue persists the remainder', async () => {
  const posts = Array.from({ length: 65 }, (_, i) => post(String(1000 + i)));
  let batch;
  const result = await advanceSync(wb(data(posts), { phase: 'refresh', requestCount: 1 }), { now: START, client: client(null, async ids => { batch = ids; return { tweets: [], missingIds: ids }; }) });
  assert.equal(batch.length, 20); assert.equal(result.sync.refresh.pendingIds.length, 45); assert.equal(result.dataset.posts.length, 65);
});
test('failed metric batches preserve the entire backlog and give recent discovery the next due turn', async () => {
  const pendingIds = Array.from({ length: 65 }, (_, i) => String(1000 + i));
  for (const failure of [Object.assign(new Error('PRIVATE'), { name: 'TimeoutError' }),
    Object.assign(new Error('PRIVATE'), { code: 'REQUEST_TIMEOUT' }), Object.assign(new Error('PRIVATE'), { code: 'NETWORK_ERROR' }),
    Object.assign(new Error('PRIVATE'), { status: 429 }), Object.assign(new Error('PRIVATE'), { status: 503 }),
    Object.assign(new Error('PRIVATE'), { code: 'INVALID_RESPONSE' })]) {
    const before = wb(data(pendingIds.map(id => post(id))), { phase: 'refresh', requestCount: 1,
      refresh: { pendingIds, cycleStartedAt: START }, discovery: { pendingWindows: [
        { start: '2026-11-01T00:00:00Z', endExclusive: '2026-11-02T00:00:00Z', cursor: 'historical', seenCursors: [], previousOldest: null }
      ], nextLane: 'backfill', coveredThrough: null } });
    let attempts = 0;
    const result = await advanceSync(before, { now: START, client: client(null, async ids => {
      attempts++; assert.deepEqual(ids, pendingIds.slice(0, 20)); throw failure;
    }) });
    assert.equal(attempts, 1); assert.equal(result.sync.phase, 'discovery'); assert.equal(result.sync.discovery.nextLane, 'recent');
    assert.deepEqual(result.sync.refresh.pendingIds, pendingIds); assert.equal(result.sync.refresh.cycleStartedAt, START);
    assert.equal(result.sync.discovery.pendingWindows[0].cursor, 'historical');
    assert.deepEqual(result.dataset, before.dataset); assert.equal(result.sync.paused, false);
    assert.ok(Date.parse(result.sync.nextRunAt) > Date.parse(START)); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});
test('recent mentions progress after a metrics timeout, then the smaller metric queue resumes normally', async () => {
  const pendingIds = Array.from({ length: 65 }, (_, i) => String(1000 + i)), calls = [];
  let refreshAttempts = 0;
  const provider = client(async args => {
    calls.push('discovery'); assert.ok(args.query.includes('since_time:1794915000'));
    return { tweets: [rawTweet('9999', { createdAt: '2026-11-17T11:45:00Z' })], hasNextPage: false, nextCursor: null };
  }, async ids => {
    calls.push('refresh'); refreshAttempts++; assert.deepEqual(ids, pendingIds.slice(0, 20));
    if (refreshAttempts === 1) throw Object.assign(new Error('PRIVATE'), { code: 'REQUEST_TIMEOUT' });
    return { tweets: ids.map(id => rawTweet(id)), missingIds: [] };
  });
  let result = await advanceSync(wb(data(pendingIds.map(id => post(id))), { phase: 'refresh', requestCount: 1,
    refresh: { pendingIds, cycleStartedAt: START } }), { now: START, client: provider });
  assert.deepEqual(result.sync.refresh.pendingIds, pendingIds);
  result = await advanceSync(result, { now: LATER, client: provider });
  assert.equal(result.sync.phase, 'refresh'); assert.equal(result.sync.lastError, null);
  assert.ok(result.dataset.posts.some(value => value.id === '9999')); assert.deepEqual(result.sync.refresh.pendingIds, pendingIds);
  result = await advanceSync(result, { now: '2026-11-17T12:10:00Z', client: provider });
  assert.deepEqual(calls, ['refresh', 'discovery', 'refresh']); assert.equal(result.sync.phase, 'discovery');
  assert.deepEqual(result.sync.refresh.pendingIds, pendingIds.slice(20)); assert.equal(result.dataset.posts.length, 66);
});
test('auth or credit failure during metrics refresh retains pending IDs and still pauses collection', async () => {
  for (const status of [401, 402, 403]) {
    const result = await advanceSync(wb(data(), { phase: 'refresh', requestCount: 1,
      refresh: { pendingIds: ['111'], cycleStartedAt: START } }), { now: START,
      client: client(null, async () => { throw Object.assign(new Error('PRIVATE'), { status }); }) });
    assert.equal(result.sync.paused, true); assert.equal(result.sync.status, 'paused');
    assert.deepEqual(result.sync.refresh.pendingIds, ['111']);
    let calls = 0;
    await advanceSync(result, { now: LATER, client: client(async () => { calls++; }, async () => { calls++; }) });
    assert.equal(calls, 0);
  }
});
test('first tick resolves temporary sample identities through immutable posts and preserves bans', async () => {
  const previous = data([post('111', { authorId: 'sample:creator' }), post('112', { authorId: 'sample:creator' })], [{ ...author, id: 'sample:creator' }]);
  const before = wb(previous);
  before.state = Model.decision(before.state, { type: 'ban', authorId: 'sample:creator', periodKey: '2026-11', reason: 'Visible reason', internalNote: 'PRIVATE_NOTE' }, START);
  let searches = 0;
  const result = await advanceSync(before, { now: START, client: client(async () => { searches++; }, async ids => ({ tweets: ids.map(id => rawTweet(id)), missingIds: [] })) });
  assert.equal(searches, 0); assert.equal(result.sync.lastError, null); assert.ok(result.state.bans['200']);
  assert.equal(result.state.bans['sample:creator'], undefined); assert.equal(result.dataset.authors[0].id, '200');
  const publicView = Model.creatorView(result.dataset, result.state, '200', Model.periodFor('2026-11', result.dataset));
  assert.equal(publicView.status, 'banned'); assert.ok(!JSON.stringify(publicView).includes('PRIVATE_NOTE'));
});
test('provider errors preserve data and checkpoint, count the attempt, and redact secrets', async () => {
  const before = wb(data(), { discovery: { pendingWindows: [{ start: '2026-11-01T00:00:00Z', endExclusive: '2026-11-02T00:00:00Z', cursor: 'saved', queryVersion: 'posts-v1', previousOldest: null, seenCursors: [] }], coveredThrough: null } });
  const untouched = structuredClone(before);
  const result = await advanceSync(before, { now: START, client: client(async () => { const error = new Error('SECRET_PROVIDER_KEY'); error.status = 429; throw error; }) });
  assert.deepEqual(result.dataset, untouched.dataset); assert.deepEqual(result.state, untouched.state); assert.deepEqual(before, untouched);
  assert.equal(result.sync.discovery.pendingWindows[0].cursor, 'saved'); assert.equal(result.sync.lastSuccessAt, null); assert.equal(result.sync.requestCount, 1);
  assert.equal(result.sync.lastError.code, 'RATE_LIMITED'); assert.equal(result.sync.lastError.httpStatus, 429); assert.equal(result.sync.lastError.diagnosticCode, 'HTTP_ERROR'); assert.ok(!JSON.stringify(result).includes('SECRET_PROVIDER_KEY'));
  let calls = 0;
  await advanceSync(result, { now: '2026-11-17T12:01:00Z', client: client(async () => { calls++; }) }); assert.equal(calls, 0);
});
test('invalid keys or exhausted credits pause collection until explicit resume', async () => {
  for (const status of [401, 402, 403]) {
    const result = await advanceSync(wb(), { now: START, client: client(async () => { const e = new Error('ignored'); e.status = status; throw e; }) });
    assert.equal(result.sync.paused, true); assert.equal(result.sync.status, 'paused');
    let calls = 0;
    await advanceSync(result, { now: '2026-11-18T00:00:00Z', client: client(async () => { calls++; }) }); assert.equal(calls, 0);
  }
});
test('malformed records or identity conflicts cannot commit a page or advance its cursor', async () => {
  const before = wb(data(), { discovery: { pendingWindows: [{ start: '2026-11-01T00:00:00Z', endExclusive: '2026-11-02T00:00:00Z', cursor: '', previousOldest: null, seenCursors: [] }], nextLane: 'backfill', coveredThrough: null } });
  const result = await advanceSync(before, { now: START, client: client(async () => ({ tweets: [rawTweet('111', { author: { id: '999', userName: 'other' } })], hasNextPage: true, nextCursor: 'unsafe-next' })) });
  assert.deepEqual(result.dataset, before.dataset); assert.equal(result.sync.discovery.pendingWindows[0].cursor, ''); assert.equal(result.sync.lastError.code, 'SYNC_FAILED');
  assert.equal(result.sync.lastError.diagnosticCode, 'POST_OWNERSHIP_CONFLICT');
});
test('empty continuation is a retained coverage gap, never an exhausted window', async () => {
  const result = await advanceSync(wb(data([], [])), { now: START, client: client(async () => ({ tweets: [], hasNextPage: true, nextCursor: 'maybe-more' })) });
  assert.equal(result.sync.discovery.coveredThrough, null); assert.equal(result.sync.discovery.pendingWindows[0].cursor, '');
  assert.equal(result.sync.gaps[0].code, 'EMPTY_CONTINUATION'); assert.equal(result.dataset.meta.coverage, 'partial');
});
test('UTC month rollover polls recent mentions and retains unfinished earlier windows for their next turn', async () => {
  const queries = [];
  const before = wb(data([], []), { discovery: { pendingWindows: [{ start: '2026-11-30T00:00:00Z', endExclusive: '2026-12-01T00:00:00Z', cursor: '', previousOldest: null, seenCursors: [] }], coveredThrough: '2026-11-30T00:00:00Z' } });
  const provider = client(async args => { queries.push(args.query); return { tweets: [], hasNextPage: false, nextCursor: null }; });
  let result = await advanceSync(before, { now: '2026-12-01T00:05:00Z', client: provider });
  assert.equal(result.sync.discovery.pendingWindows.length, 1);
  assert.equal(result.sync.discovery.coveredThrough, '2026-11-30T00:00:00Z');
  result = await advanceSync(result, { now: '2026-12-01T00:10:00Z', client: provider });
  assert.ok(queries[1].includes('since_time:' + Date.parse('2026-11-30T00:00:00Z') / 1000));
  assert.equal(result.sync.discovery.pendingWindows.length, 0);
  assert.equal(result.sync.discovery.coveredThrough, '2026-12-01T00:05:00.000Z');
});

test('fresh discovery and historical pages both progress under a strict one-call tick budget', async () => {
  const searches = [], observed = new Map(); let calls = 0;
  const provider = client(async args => {
    calls++; searches.push(args);
    const since = Number(args.query.match(/since_time:(\d+)/)[1]) * 1000;
    const until = Number(args.query.match(/until_time:(\d+)/)[1]) * 1000;
    if (since < Date.parse('2026-11-17T00:00:00Z')) return { tweets: [], hasNextPage: false, nextCursor: null };
    const tweet = rawTweet(String(2000 + calls), { createdAt: new Date(until - 60000).toISOString() }); observed.set(tweet.id, tweet);
    return { tweets: [tweet], hasNextPage: false, nextCursor: null };
  }, async ids => { calls++; return { tweets: ids.map(id => observed.get(id)), missingIds: [] }; });
  let result = wb(data([], []));
  for (let tick = 0; tick < 12; tick++) {
    const previousCalls = calls;
    result = await advanceSync(result, { now: new Date(Date.parse(START) + tick * 300000).toISOString(), maxRequests: 99, client: provider });
    assert.equal(calls - previousCalls, 1);
  }
  const recentSearches = searches.filter(s => Number(s.query.match(/since_time:(\d+)/)[1]) >= Date.parse('2026-11-17T00:00:00Z') / 1000);
  const oldSearches = searches.filter(s => !recentSearches.includes(s));
  assert.equal(recentSearches.length, 3); assert.equal(oldSearches.length, 3);
  assert.equal(result.sync.discovery.pendingWindows.length, 14);
  assert.equal(result.sync.discovery.coveredThrough, '2026-11-04T00:00:00.000Z');
  assert.ok(result.dataset.posts.some(p => p.publishedAt > LATER));
  assert.equal(result.dataset.meta.coverage, 'partial');
});

test('recent coverage cannot jump an unresolved historical gap after a long outage', async () => {
  const before = wb(data([], []), { discovery: { pendingWindows: [{ start: '2026-11-01T00:00:00Z', endExclusive: '2026-11-02T00:00:00Z', cursor: '', previousOldest: null, seenCursors: [] }], coveredThrough: '2026-11-01T00:00:00Z' } });
  const provider = client(async () => ({ tweets: [], hasNextPage: false, nextCursor: null }));
  let result = await advanceSync(before, { now: '2026-12-10T12:00:00Z', client: provider });
  assert.equal(result.sync.discovery.coveredThrough, '2026-11-01T00:00:00Z');
  assert.equal(result.sync.discovery.recentThrough, '2026-12-10T12:00:00.000Z');
  result = await advanceSync(result, { now: '2026-12-10T12:05:00Z', client: provider });
  assert.equal(result.sync.discovery.coveredThrough, '2026-11-02T00:00:00Z');
});

test('safe diagnostics retain SDK codes and HTTP status without provider messages or stacks', async () => {
  for (const diagnosticCode of ['NETWORK_ERROR','REQUEST_TIMEOUT','INVALID_RESPONSE','PROVIDER_ERROR','INVALID_INPUT']) {
    const error = new Error('SECRET_PROVIDER_BODY_AND_KEY'); error.code = diagnosticCode; error.status = 503;
    const result = await advanceSync(wb(), { now: START, client: client(async () => { throw error; }) });
    assert.equal(result.sync.lastError.code, 'SYNC_FAILED'); assert.equal(result.sync.lastError.diagnosticCode, diagnosticCode);
    assert.equal(result.sync.lastError.httpStatus, 503); assert.ok(!JSON.stringify(result).includes('SECRET_PROVIDER_BODY_AND_KEY'));
    assert.ok(!('stack' in result.sync.lastError));
  }
  assert.deepEqual(classifySyncError(Object.assign(new Error('SECRET'), {code:'SECRET_UNKNOWN_CODE',status:999})), {diagnosticCode:'UNCLASSIFIED_ERROR'});
  for (const name of ['TimeoutError', 'AbortError']) {
    assert.deepEqual(classifySyncError(Object.assign(new Error('SECRET'), { name, cause: 'SECRET_CAUSE' })), { diagnosticCode: 'REQUEST_TIMEOUT' });
  }
});
test('normalization diagnostics expose only fixed allowed fields and never malformed values', async () => {
  for (const [extra, code, field] of [
    [{viewCount:'SECRET_COUNT_VALUE'},'INVALID_COUNT','viewCount'],
    [{author:{id:123,userName:'creator'}},'INVALID_AUTHOR',undefined],
    [{id:111},'INVALID_TWEET_ID',undefined],
    [{createdAt:'2026-11-01T12:00:00'},'MISSING_TIMEZONE',undefined],
    [{createdAt:'2026-99-01T12:00:00Z'},'INVALID_TIMESTAMP',undefined],
  ]) {
    const result = await advanceSync(wb(), { now: START, client: client(async () => ({tweets:[rawTweet('111',extra)],hasNextPage:false,nextCursor:null})) });
    assert.equal(result.sync.lastError.diagnosticCode,code); assert.equal(result.sync.lastError.diagnosticField,field);
    assert.equal(result.sync.lastError.httpStatus,null); assert.ok(!JSON.stringify(result.sync.lastError).includes('SECRET_COUNT_VALUE'));
  }
});
test('known merge and identity errors map to static diagnostics', () => {
  for (const [message,code] of [
    ['Post publication time conflict.','PUBLICATION_TIME_CONFLICT'],
    ['Ambiguous sample identity.','SAMPLE_IDENTITY_CONFLICT'],
    ['Суперечливі дублікати X Post ID.','DUPLICATE_POST'],
    ['Суперечливі імена одного автора у знімку.','AUTHOR_HANDLE_CONFLICT'],
    ['Імпорт зупинено: конфлікт ідентичності автора. PRIVATE_DETAIL','MODEL_IDENTITY_CONFLICT'],
  ]) {
    const result=classifySyncError(new Error(message)); assert.deepEqual(result,{diagnosticCode:code}); assert.ok(!JSON.stringify(result).includes('PRIVATE_DETAIL'));
  }
});

const legacyArgs = args => ({ userName: 'entropyIO', sinceTime: Number(/since_time:(\d+)/.exec(args.query)[1]), untilTime: Number(/until_time:(\d+)/.exec(args.query)[1]), cursor: args.cursor });
const hourlyClient = handler => ({ searchPage: args => handler(legacyArgs(args)), tweetsByIds: async () => { throw new Error('Hourly discovery must not refresh metrics.'); } });
const emptyPage = () => ({ tweets: [], hasNextPage: false, nextCursor: null });
const hourTweet = (id, createdAt = '2026-11-17T11:45:00Z') => rawTweet(id, { createdAt });

test('hourly search excludes replies and unknown types even if the provider returns them', async () => {
  let request;
  const unknown = hourTweet('5012'); delete unknown.isReply;
  const result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: { searchPage: async args => {
    request = args; return { tweets: [hourTweet('5010'), { ...hourTweet('5011'), isReply: true }, unknown], hasNextPage: false };
  } } });
  assert.match(request.query, /-filter:replies/);
  assert.deepEqual(result.dataset.posts.map(post => post.id), ['5010']);
});

test('legacy mention checkpoints restart their time window under the new search filter', async () => {
  const window = { id: 'old', method: 'mentions', start: '2026-11-17T11:00:00Z', endExclusive: START, cursor: 'old-cursor', previousOldest: START, seenCursors: ['old-cursor'], observedPostIds: ['123'] };
  let request;
  const result = await advanceHourlyDiscovery(wb(data([], []), { hourly: { pendingWindows: [window], migratedLegacyRecent: true } }), { now: START, lane: 'catchup', client: { searchPage: async args => { request = args; return emptyPage(); } } });
  assert.equal(request.cursor, ''); assert.match(request.query, /-filter:replies/);
  assert.equal(result.sync.hourly.method, 'search-posts-v1');
});

test('hourly latest always searches current mentions before metrics, history or a legacy recent cursor', async () => {
  const legacy = { start: '2026-11-16T22:00:00.000Z', endExclusive: '2026-11-16T23:00:00.000Z', cursor: 'legacy-search-cursor', seenCursors: ['legacy-search-cursor'], previousOldest: null };
  const before = wb(data([], []), { phase: 'refresh', requestCount: 50, refresh: { pendingIds: ['999'], cycleStartedAt: START }, discovery: {
    recentWindow: legacy, pendingWindows: [{ ...legacy, cursor: 'historical-cursor' }], coveredThrough: null, nextLane: 'backfill' } });
  const calls = [];
  const result = await advanceHourlyDiscovery(before, { now: START, client: hourlyClient(async args => { calls.push(args); return { tweets: [hourTweet('5000')], hasNextPage: true, nextCursor: 'new-mentions-cursor' }; }) });
  assert.deepEqual(calls, [{ userName: 'entropyIO', sinceTime: Date.parse('2026-11-17T10:55:00Z') / 1000, untilTime: Date.parse(START) / 1000, cursor: '' }]);
  assert.equal(result.dataset.posts.length, 1); assert.deepEqual(result.sync.refresh.pendingIds, ['999']);
  assert.equal(result.sync.discovery.recentWindow.cursor, 'legacy-search-cursor'); assert.equal(result.sync.discovery.pendingWindows[0].cursor, 'historical-cursor');
  assert.ok(result.sync.hourly.pendingWindows.some(window => window.kind === 'legacy-recent' && window.cursor === ''));
  assert.ok(result.sync.hourly.pendingWindows.some(window => window.method === 'search-posts-v1' && window.cursor === 'new-mentions-cursor'));
  assert.equal(result.sync.hourly.method, 'search-posts-v1'); assert.equal(result.sync.hourly.lastSuccessAt, START);
  assert.equal(result.sync.hourly.completedThrough, null); assert.equal(result.sync.hourly.latestWindow.status, 'pending');
});

test('every subsequent hourly call starts a new current window and retains older unexhausted pages', async () => {
  const calls = [], provider = hourlyClient(async args => { calls.push(args); return { tweets: [], hasNextPage: true, nextCursor: 'tail-' + calls.length }; });
  // Empty continuation is intentionally an anomaly, so use a valid page instead.
  provider.searchPage = async value => { const args = legacyArgs(value); calls.push(args); return { tweets: [hourTweet('500' + calls.length, new Date(args.untilTime * 1000 - 60000).toISOString())], hasNextPage: true, nextCursor: 'tail-' + calls.length }; };
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T13:00:00Z', client: provider });
  assert.equal(calls.length, 2); assert.equal(calls[1].cursor, '');
  assert.equal(calls[1].sinceTime, Date.parse('2026-11-17T11:55:00Z') / 1000); assert.equal(calls[1].untilTime, Date.parse('2026-11-17T13:00:00Z') / 1000);
  assert.ok(result.sync.hourly.pendingWindows.some(window => window.cursor === 'tail-1')); assert.ok(result.sync.hourly.pendingWindows.some(window => window.cursor === 'tail-2'));
  assert.equal(result.sync.hourly.completedThrough, null); assert.equal(result.sync.hourly.latestPlannedThrough, '2026-11-17T13:00:00.000Z');
});

test('hourly disabled, paused, zero budget and not-due runs never access the provider', async () => {
  let calls = 0; const provider = hourlyClient(async () => { calls++; return emptyPage(); });
  for (const sync of [{ enabled: false }, { paused: true }, { hourly: { nextRunAt: '2026-11-17T13:00:00Z' } }]) await advanceHourlyDiscovery(wb(data([], []), sync), { now: START, client: provider });
  await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider, maxRequests: 0 });
  assert.equal(calls, 0);
});

test('catchup drains a saved page before the latest due time without relabelling fresh-search success', async () => {
  const calls = [], provider = hourlyClient(async args => { calls.push(args); return calls.length === 1
    ? { tweets: [hourTweet('5000')], hasNextPage: true, nextCursor: 'saved-tail' }
    : { tweets: [hourTweet('5001', '2026-11-17T11:10:00Z')], hasNextPage: false, nextCursor: null }; });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T12:00:06Z', client: provider, lane: 'catchup' });
  assert.equal(calls[1].cursor, 'saved-tail'); assert.equal(result.dataset.posts.length, 2);
  assert.equal(result.sync.hourly.pendingWindows.length, 0); assert.equal(result.sync.hourly.lastSuccessAt, START);
  assert.equal(result.sync.hourly.catchupLastSuccessAt, '2026-11-17T12:00:06.000Z');
  assert.equal(result.sync.hourly.nextRunAt, '2026-11-17T13:00:00.000Z'); assert.equal(result.sync.nextRunAt, result.sync.hourly.nextRunAt);
  assert.equal(result.sync.hourly.completedThrough, START); assert.equal(result.sync.hourly.catchupNextAttemptAt, '2026-11-17T12:00:11.100Z');
});

test('hourly catchup observes its own five-second spacing and makes no request without pending pages', async () => {
  let calls = 0; const provider = hourlyClient(async () => { calls++; return emptyPage(); });
  const result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  await advanceHourlyDiscovery(result, { now: '2026-11-17T12:00:01Z', client: provider, lane: 'catchup' });
  await advanceHourlyDiscovery(result, { now: LATER, client: provider, lane: 'catchup' });
  assert.equal(calls, 1);
});

test('outage recovery queues the missed interval while current-hour search still happens first', async () => {
  const before = wb(data([], []), { hourly: { latestPlannedThrough: START, coverageFrom: START, completedThrough: START, migratedLegacyRecent: true, pendingWindows: [] } });
  let called;
  const result = await advanceHourlyDiscovery(before, { now: '2026-11-20T12:00:00Z', client: hourlyClient(async args => { called = args; return emptyPage(); }) });
  assert.equal(called.sinceTime, Date.parse('2026-11-20T10:55:00Z') / 1000);
  assert.equal(called.untilTime, Date.parse('2026-11-20T12:00:00Z') / 1000);
  assert.equal(result.sync.hourly.pendingWindows[0].start, START);
  assert.equal(result.sync.hourly.pendingWindows.at(-1).endExclusive, '2026-11-20T10:55:00.000Z');
  assert.equal(result.sync.hourly.completedThrough, START);
});

test('a long hourly page tail remains resumable after six bounded catchup calls', async () => {
  let calls = 0;
  const provider = hourlyClient(async args => {
    calls++; return { tweets: [hourTweet(String(6000 + calls), new Date(Date.parse(START) - calls * 60000).toISOString())], hasNextPage: true, nextCursor: 'cursor-' + calls };
  });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider, maxRequests: 99 });
  for (let step = 1; step <= 6; step++) result = await advanceHourlyDiscovery(result, { now: new Date(Date.parse(START) + step * 6000).toISOString(), client: provider, lane: 'catchup', maxRequests: 99 });
  assert.equal(calls, 7); assert.equal(result.dataset.posts.length, 7); assert.equal(result.sync.hourly.pendingWindows[0].cursor, 'cursor-7');
  assert.equal(result.sync.hourly.latestPages, 1); assert.equal(result.sync.hourly.catchupPages, 6);
  assert.equal(result.sync.hourly.completedThrough, null); assert.equal(result.dataset.meta.coverage, 'partial');
});

test('failed hourly latest search retains its window and still gives the next hour a fresh current request', async () => {
  const before = wb(data([], [])), calls = [];
  const provider = hourlyClient(async args => { calls.push(args); if (calls.length === 1) throw Object.assign(new Error('SECRET'), { code: 'REQUEST_TIMEOUT' }); return emptyPage(); });
  let result = await advanceHourlyDiscovery(before, { now: START, client: provider });
  assert.equal(result.sync.hourly.pendingWindows.length, 1); assert.equal(result.sync.hourly.latestPlannedThrough, START);
  assert.equal(result.sync.hourly.lastSuccessAt, null); assert.equal(result.sync.hourly.lastError.diagnosticCode, 'REQUEST_TIMEOUT');
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T13:00:00Z', client: provider });
  assert.equal(calls[1].cursor, ''); assert.equal(calls[1].untilTime, Date.parse('2026-11-17T13:00:00Z') / 1000);
  assert.equal(result.sync.hourly.pendingWindows[0].endExclusive, START); assert.equal(result.sync.hourly.lastError, null);
  assert.equal(result.sync.hourly.lastSuccessAt, '2026-11-17T13:00:00.000Z'); assert.equal(result.sync.hourly.completedThrough, null);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('failed catchup cannot delay the next hourly latest run or overwrite its last successful scan', async () => {
  let calls = 0;
  const provider = hourlyClient(async () => { calls++; if (calls === 1) return { tweets: [hourTweet('7000')], hasNextPage: true, nextCursor: 'tail' }; throw Object.assign(new Error('SECRET'), { status: 503 }); });
  let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T12:00:06Z', client: provider, lane: 'catchup' });
  assert.equal(result.sync.nextRunAt, '2026-11-17T13:00:00.000Z'); assert.equal(result.sync.hourly.lastSuccessAt, START);
  assert.equal(result.sync.hourly.lastError, null); assert.equal(result.sync.hourly.catchupLastError.httpStatus, 503);
  assert.equal(result.sync.hourly.pendingWindows[0].cursor, 'tail'); assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('hourly authentication and credits failures pause both lanes without erasing pending pages', async () => {
  for (const status of [401, 402, 403]) {
    let calls = 0;
    const provider = hourlyClient(async () => { calls++; throw Object.assign(new Error('SECRET'), { status }); });
    let result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: provider });
    assert.equal(result.sync.paused, true); assert.equal(result.sync.hourly.pendingWindows.length, 1);
    result = await advanceHourlyDiscovery(result, { now: '2026-11-17T13:00:00Z', client: provider, lane: 'catchup' });
    assert.equal(calls, 1); assert.equal(result.sync.hourly.lastSuccessAt, null);
  }
});

test('legacy search cursors are never sent to the new mentions endpoint', async () => {
  const legacy = { start: '2026-11-16T22:00:00.000Z', endExclusive: '2026-11-16T23:00:00.000Z', cursor: 'old-search', previousOldest: null, seenCursors: ['old-search'] };
  const searches = [], provider = { searchPage: async args => { searches.push(args); return emptyPage(); } };
  let result = await advanceHourlyDiscovery(wb(data([], []), { discovery: { recentWindow: legacy, pendingWindows: [] } }), { now: START, client: provider });
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T12:00:06Z', client: provider, lane: 'catchup' });
  assert.equal(searches.length, 2); assert.equal(searches[0].cursor, ''); assert.equal(searches[1].cursor, '');
  assert.ok(searches.every(call => call.query.includes('-filter:replies')));
  assert.ok(searches[1].query.includes('until_time:' + Date.parse(legacy.endExclusive) / 1000));
});

test('hourly cursor cycles and empty continuations split into independent same-method recovery windows', async () => {
  for (const makePage of [() => ({ tweets: [], hasNextPage: true, nextCursor: 'empty' }), () => ({ tweets: [hourTweet('8000')], hasNextPage: true, nextCursor: '' })]) {
    const result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: hourlyClient(async () => makePage()) });
    assert.equal(result.sync.hourly.pendingWindows.length, 2); assert.equal(result.sync.hourly.splitWindows, 1);
    assert.ok(result.sync.hourly.pendingWindows.every(window => window.method === 'search-posts-v1' && window.cursor === ''));
    assert.equal(result.sync.hourly.completedThrough, null); assert.equal(result.sync.hourly.latestWindow.status, 'split');
  }
  const result = await advanceHourlyDiscovery(wb(data([], [])), { now: START, client: hourlyClient(async () => { throw Object.assign(new Error('Некоректний курсор наступної сторінки.'), { code: 'INVALID_RESPONSE' }); }) });
  assert.equal(result.sync.hourly.pendingWindows.length, 2); assert.equal(result.sync.hourly.lastAnomaly.code, 'CURSOR_CYCLE');
  assert.equal(result.sync.hourly.lastSuccessAt, null);
});

test('known missing posts in a minimum catchup window remain explicit gaps and never become covered', async () => {
  const window = { id: 'tiny', method: 'mentions', kind: 'recovery', start: '2026-11-17T11:55:00Z', endExclusive: START, cursor: '', previousOldest: null, seenCursors: [], observedPostIds: [] };
  const before = wb(data([post('9000', { date: '2026-11-17', publishedAt: '2026-11-17T11:58:00Z' })]), { hourly: { migratedLegacyRecent: true, pendingWindows: [window], coverageFrom: window.start, nextRunAt: '2026-11-17T13:00:00Z' } });
  const result = await advanceHourlyDiscovery(before, { now: START, lane: 'catchup', client: hourlyClient(async () => emptyPage()) });
  assert.equal(result.sync.hourly.pendingWindows.length, 0); assert.equal(result.sync.hourly.gaps[0].code, 'KNOWN_POST_NOT_RETURNED');
  assert.equal(result.sync.hourly.gaps[0].count, 1); assert.equal(result.sync.hourly.completedThrough, null);
  assert.equal(result.dataset.posts[0].metrics.impressions, 100);
});

test('hourly ingestion preserves decisions and work grouping while filtering unrelated, own and repost candidates', async () => {
  const before = wb(data([post('9100', { workId: 'thread:manual', date: '2026-11-17', publishedAt: '2026-11-17T11:45:00Z' })]));
  before.state = Model.decision(before.state, { type: 'ban', authorId: '200', periodKey: '2026-11', reason: 'Public reason', internalNote: 'Private note' }, START);
  const result = await advanceHourlyDiscovery(before, { now: START, client: hourlyClient(async () => ({ tweets: [hourTweet('9100'), hourTweet('9101', START), { ...hourTweet('9102'), text: 'About @entropyIOOther' }, { ...hourTweet('9103'), author: { id: '999', userName: 'entropyIO', followers: 5 } }, { ...hourTweet('9104'), isRetweet: true, retweeted_tweet: { id: '1' } }], hasNextPage: false, nextCursor: null })) });
  assert.equal(result.dataset.posts.length, 1); assert.equal(result.dataset.posts[0].workId, 'thread:manual');
  assert.equal(result.state.bans['200'].reason, 'Public reason'); assert.equal(result.state.bans['200'].internalNote, 'Private note');
  assert.equal(result.sync.hourly.lastDataAt, START);
});

test('hourly fresh search crosses UTC month boundaries without discarding the previous month overlap', async () => {
  let args;
  const result = await advanceHourlyDiscovery(wb(data([], [])), { now: '2026-12-01T00:05:00Z', client: hourlyClient(async value => { args = value; return { tweets: [hourTweet('9200', '2026-11-30T23:55:00Z')], hasNextPage: false, nextCursor: null }; }) });
  assert.equal(args.sinceTime, Date.parse('2026-11-30T23:00:00Z') / 1000); assert.equal(result.dataset.posts[0].date, '2026-11-30');
  assert.equal(result.sync.hourly.completedThrough, '2026-12-01T00:05:00.000Z');
});

test('catchup drains the current mentions tail before a stale legacy cursor', async () => {
  const legacy = { start: '2026-11-16T22:00:00.000Z', endExclusive: '2026-11-16T23:00:00.000Z', cursor: 'old-search', previousOldest: null, seenCursors: ['old-search'] };
  const calls = [], provider = { searchPage: async args => {
    if (args.query.includes('since_time:' + Date.parse(legacy.start) / 1000)) { calls.push(['legacy', args.cursor]); return emptyPage(); }
    calls.push(['mentions', args.cursor]); return args.cursor ? { tweets: [hourTweet('9301', '2026-11-17T11:20:00Z')], hasNextPage: false, nextCursor: null }
      : { tweets: [hourTweet('9300')], hasNextPage: true, nextCursor: 'current-tail' };
  } };
  let result = await advanceHourlyDiscovery(wb(data([], []), { discovery: { recentWindow: legacy, pendingWindows: [] } }), { now: START, client: provider });
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T12:00:06Z', client: provider, lane: 'catchup' });
  assert.deepEqual(calls, [['mentions', ''], ['mentions', 'current-tail']]);
  assert.ok(result.sync.hourly.pendingWindows.some(window => window.kind === 'legacy-recent' && window.cursor === ''));
  assert.ok(!result.sync.hourly.pendingWindows.some(window => window.cursor === 'current-tail'));
});

test('every sixth catchup attempt gives the oldest queue a turn and then returns to the current tail', async () => {
  const legacy = { start: '2026-11-16T22:00:00.000Z', endExclusive: '2026-11-16T23:00:00.000Z', cursor: 'old-search', previousOldest: null, seenCursors: ['old-search'] };
  const calls = []; let mentionPages = 0;
  const provider = { searchPage: async args => {
    if (args.query.includes('since_time:' + Date.parse(legacy.start) / 1000)) { calls.push(['legacy', args.cursor]); return emptyPage(); }
    mentionPages++; calls.push(['mentions', args.cursor]);
    return { tweets: [hourTweet(String(9400 + mentionPages), new Date(Date.parse(START) - mentionPages * 60000).toISOString())], hasNextPage: true, nextCursor: 'tail-' + mentionPages };
  } };
  let result = await advanceHourlyDiscovery(wb(data([], []), { discovery: { recentWindow: legacy, pendingWindows: [] } }), { now: START, client: provider });
  for (let step = 1; step <= 7; step++) result = await advanceHourlyDiscovery(result, { now: new Date(Date.parse(START) + step * 6000).toISOString(), client: provider, lane: 'catchup' });
  assert.deepEqual(calls.map(call => call[0]), ['mentions', 'mentions', 'mentions', 'mentions', 'mentions', 'mentions', 'legacy', 'mentions']);
  assert.equal(calls[6][1], ''); assert.equal(calls[7][1], 'tail-6');
  assert.equal(result.sync.hourly.catchupRequestCount, 7); assert.equal(result.sync.hourly.catchupPages, 7);
  assert.ok(!result.sync.hourly.pendingWindows.some(window => window.cursor === 'old-search'));
});

test('failing current catchup pages cannot prevent the sixth attempt from serving the oldest queue', async () => {
  const legacy = { start: '2026-11-16T22:00:00.000Z', endExclusive: '2026-11-16T23:00:00.000Z', cursor: 'old-search', previousOldest: null, seenCursors: ['old-search'] };
  const calls = []; let first = true;
  const provider = { searchPage: async args => {
    if (args.query.includes('since_time:' + Date.parse(legacy.start) / 1000)) { calls.push(['legacy', args.cursor]); return emptyPage(); }
    calls.push(['mentions', args.cursor]);
    if (first) { first = false; return { tweets: [hourTweet('9500')], hasNextPage: true, nextCursor: 'failing-tail' }; }
    throw Object.assign(new Error('SECRET'), { code: 'NETWORK_ERROR' });
  } };
  let result = await advanceHourlyDiscovery(wb(data([], []), { discovery: { recentWindow: legacy, pendingWindows: [] } }), { now: START, client: provider });
  for (let step = 1; step <= 6; step++) result = await advanceHourlyDiscovery(result, { now: result.sync.hourly.nextAttemptAt, client: provider, lane: 'catchup' });
  assert.equal(calls.at(-1)[0], 'legacy'); assert.equal(calls.at(-1)[1], '');
  assert.equal(result.sync.hourly.catchupRequestCount, 6); assert.equal(result.sync.hourly.catchupPages, 1);
  assert.equal(result.sync.hourly.lastSuccessAt, START); assert.ok(result.sync.hourly.pendingWindows.some(window => window.cursor === 'failing-tail'));
});

test('current-hour split recovery also takes priority over older legacy catchup', async () => {
  const legacy = { start: '2026-11-16T22:00:00.000Z', endExclusive: '2026-11-16T23:00:00.000Z', cursor: 'old-search', previousOldest: null, seenCursors: ['old-search'] };
  const calls = []; let first = true;
  const provider = { searchPage: async value => {
    const args = legacyArgs(value); calls.push(args); if (first) { first = false; return { tweets: [], hasNextPage: true, nextCursor: 'stalled' }; } return emptyPage();
  } };
  let result = await advanceHourlyDiscovery(wb(data([], []), { discovery: { recentWindow: legacy, pendingWindows: [] } }), { now: START, client: provider });
  const children = result.sync.hourly.pendingWindows.filter(window => window.kind === 'recovery').sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  assert.equal(children.length, 2);
  result = await advanceHourlyDiscovery(result, { now: '2026-11-17T12:00:06Z', client: provider, lane: 'catchup' });
  assert.equal(calls[1].sinceTime, Date.parse(children[0].start) / 1000); assert.equal(calls[1].cursor, '');
  assert.ok(result.sync.hourly.pendingWindows.some(window => window.kind === 'legacy-recent' && window.cursor === ''));
});
