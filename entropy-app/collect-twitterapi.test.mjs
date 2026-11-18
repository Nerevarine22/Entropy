import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, collectSearch } from './collect-twitterapi.mjs';

const tweet = (id, createdAt = '2026-11-01T10:00:00Z', userName = 'creator') => ({ id, createdAt, isReply: false, text: 'A post about @Entropy',
  author: { id: userName === 'Entropy' ? '100' : '200', userName, name: userName, followers: 12 },
  viewCount: 50, likeCount: 2, retweetCount: 0, quoteCount: 0, replyCount: 1 });
const config = { handle: 'Entropy', start: '2026-11-01', end: '2026-11-03', maxRequests: 2 };
const clock = () => '2026-11-04T00:00:00Z';

test('daily UTC windows have exclusive end and require bounded valid inputs', () => {
  const p = makePlan(config);
  assert.equal(p.windows.length, 2);
  assert.match(p.windows[0].query, /@Entropy since_time:\d+ until_time:\d+/);
  assert.equal(p.windows[0].endExclusive, p.windows[1].start);
  assert.equal(makePlan({ start: config.start, end: config.end }).handle, 'entropyIO');
  for (const change of [{ handle: 'Entropy OR a' }, { end: '2026-11-00' }, { maxRequests: Infinity }, { maxRequests: 0 }]) assert.throws(() => makePlan({ ...config, ...change }));
});
test('replies and posts with an unknown type are excluded', async () => {
  const reply = { ...tweet('222'), isReply: true }, unknown = tweet('333'); delete unknown.isReply;
  const d = await collectSearch({ plan: { ...config, end: '2026-11-02' }, now: clock, client: { searchPage: async () => ({ tweets: [tweet('111'), reply, unknown], hasNextPage: false }) } });
  assert.deepEqual(d.posts.map(p => p.id), ['111']);
});
test('request budget stops pagination without claiming complete coverage', async () => {
  const requests = [], sleeps = [];
  const d = await collectSearch({ plan: config, now: clock, wait: async ms => sleeps.push(ms), client: { searchPage: async args => {
    requests.push(args); return { tweets: [tweet('1234567890123456789')], hasNextPage: true, nextCursor: 'page-' + requests.length };
  } } });
  assert.equal(requests.length, 2); assert.equal(requests[1].cursor, 'page-1'); assert.deepEqual(sleeps, [5100]);
  assert.equal(d.meta.collection.stopReason, 'request-limit'); assert.equal(d.meta.coverage, 'partial'); assert.equal(d.posts.length, 1);
});
test('own-project posts and out-of-period rows cannot enter contributor totals', async () => {
  const d = await collectSearch({ plan: { ...config, end: '2026-11-02' }, now: clock, wait: async () => {}, client: { searchPage: async () => ({
    tweets: [tweet('111'), tweet('222', '2026-11-01T10:00:00Z', 'Entropy'), tweet('333', '2026-10-31T23:59:59Z')], hasNextPage: false, nextCursor: ''
  }) } });
  assert.deepEqual(d.posts.map(p => p.id), ['111']); assert.equal(d.authors.length, 1); assert.equal(d.meta.collection.filteredRows, 2);
  assert.equal(d.meta.collection.windows[0].exhausted, true); assert.equal(d.meta.coverage, 'partial');
});
test('empty pages with continuation and cursor cycles stop safely', async () => {
  const d = await collectSearch({ plan: config, now: clock, wait: async () => {}, client: { searchPage: async () => ({ tweets: [], hasNextPage: true, nextCursor: 'again' }) } });
  assert.equal(d.meta.collection.requestCount, 1); assert.equal(d.meta.collection.stopReason, 'pagination-stalled');
});
test('matching a different handle or quoted search context does not prove a direct mention', async () => {
  const exact = tweet('111'); exact.text = 'About @eNtRoPy!';
  const other = tweet('222'); other.text = 'About @EntropyOther';
  const missing = tweet('333'); missing.text = null;
  const d = await collectSearch({ plan: { ...config, end: '2026-11-02' }, now: clock, wait: async () => {}, client: { searchPage: async () => ({
    tweets: [exact, other, missing], hasNextPage: false, nextCursor: ''
  }) } });
  assert.deepEqual(d.posts.map(p => p.id), ['111']);
});
test('paging that jumps back to newer posts is flagged instead of silently accepted as complete', async () => {
  let requests = 0;
  const d = await collectSearch({ plan: config, now: clock, wait: async () => {}, client: { searchPage: async () => ({
    tweets: [tweet(String(++requests), requests === 1 ? '2026-11-01T10:00:00Z' : '2026-11-01T11:00:00Z')], hasNextPage: true, nextCursor: String(requests)
  }) } });
  assert.equal(d.meta.collection.stopReason, 'pagination-order'); assert.equal(d.meta.coverage, 'partial');
});
