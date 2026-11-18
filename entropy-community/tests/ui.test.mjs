import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { escapeHTML, rankRows, filterRows, safePostUrl, authorPosts, paginatePosts, renderPost, engagementRate, formatPercent, renderScore, renderContributorMetrics } from '../public/app.js';

const row = (id, impressions, likes = 0) => ({
  author: { id, handle: id, displayName: id },
  score: null,
  posts: 2,
  metrics: { impressions, likes, replies: 1 },
});
const period = { key: '2026-11', start: '2026-11-01T00:00:00Z', endExclusive: '2026-12-01T00:00:00Z' };

test('unknown metrics sort after zero and a search keeps the creator’s original rank', () => {
  const ranked = rankRows([row('unknown', null, 2), row('zero', 0, 4), row('b', 100, 5), row('a', 100, 5)]);
  assert.deepEqual(ranked.map((item) => item.author.id), ['a', 'b', 'zero', 'unknown']);
  assert.equal(filterRows(ranked, '@zero')[0].displayRank, 3);
  assert.deepEqual(rankRows(ranked, 'likes').map((item) => item.author.id), ['a', 'b', 'zero', 'unknown']);
  assert.deepEqual(rankRows(ranked, 'score').map((item) => item.author.id), ['a', 'b', 'zero', 'unknown']);
  const mixedScores = [row('unknown-score', 1000), { ...row('known-zero', 10), score: 0 }];
  assert.equal(rankRows(mixedScores, 'score')[0].author.id, 'known-zero');
});

test('Engagement uses the total likes, reposts and quotes over reach, without counting replies', () => {
  const creator = { metrics: { impressions: 1000, likes: 20, reposts: 3, quotes: 2, replies: 900 } };
  assert.equal(engagementRate(creator), 2.5);
  assert.equal(formatPercent(engagementRate(creator)), '2,50%');
  assert.equal(engagementRate({ metrics: { impressions: 1000, likes: 0, reposts: 0, quotes: 0 } }), 0);
  assert.equal(formatPercent(0), '0,00%');
  for (const metrics of [
    { impressions: 0, likes: 0, reposts: 0, quotes: 0 },
    { impressions: null, likes: 10, reposts: 2, quotes: 1 },
    { impressions: 100, likes: 10, reposts: null, quotes: 1 },
    { impressions: 100, likes: 10, reposts: 2 },
  ]) assert.equal(engagementRate({ metrics }), null);
  assert.equal(formatPercent(null), '—');
  assert.equal(engagementRate({ ...creator, engagementRate: null }), null, 'An explicit unknown server observation must not be overwritten');
});

test('Score and Engagement sorting never assign places to unknown observations', () => {
  const rows = [
    { ...row('small', 100, 5), metrics: { impressions: 100, likes: 5, reposts: 0, quotes: 0 } },
    { ...row('large', 10000, 50), metrics: { impressions: 10000, likes: 50, reposts: 0, quotes: 0 } },
    { ...row('unknown', 90000, 500), metrics: { impressions: 90000, likes: 500, reposts: null, quotes: 0 } },
  ];
  const ranked = rankRows(rows, 'engagementRate');
  assert.deepEqual(ranked.map(item => item.author.id), ['small', 'large', 'unknown']);
  assert.deepEqual(ranked.map(item => item.displayRank), [1, 2, null]);
  assert.ok(rankRows(rows, 'score').every(item => item.displayRank === null));
  assert.equal(rankRows([{ ...rows[0], score: 0 }, rows[1]], 'score')[0].displayRank, 1);
});

test('Score remains explicit and a creator detail contains both Score and Engagement', () => {
  const creator = { ...row('creator', 1000, 20), metrics: { impressions: 1000, likes: 20, reposts: 3, quotes: 2, replies: 900 } };
  const unavailable = renderScore(creator);
  assert.ok(unavailable.includes('Недостатньо даних'));
  assert.ok(unavailable.includes('>—<'));
  assert.ok(!unavailable.includes('>0<'));
  assert.ok(renderScore({ ...creator, score: 0 }).includes('>0<'));
  const profile = renderContributorMetrics(creator);
  assert.ok(profile.includes('Score'));
  assert.ok(profile.includes('Engagement'));
  assert.ok(profile.includes('2,50%'));
  assert.ok(profile.includes('Недостатньо даних'));
});

test('Score and Engagement columns and sort choices are present before any scores are available', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<th[^>]*data-metric="score"[^>]*>Score<\/th>/);
  assert.match(html, /<th[^>]*data-metric="engagementRate"[^>]*>Engagement %<\/th>/);
  const scoreOption = html.match(/<option[^>]*value="score"[^>]*>/)?.[0];
  assert.ok(scoreOption && !/hidden|disabled/.test(scoreOption));
  assert.match(html, /option value="engagementRate"/);
});

test('monthly posts use UTC inclusive start and exclusive end, while all posts stay author-specific', () => {
  const posts = [
    { id: 'before', authorId: 'a', publishedAt: '2026-10-31T23:59:59Z' },
    { id: 'start', authorId: 'a', publishedAt: '2026-11-01T00:00:00Z' },
    { id: 'last', authorId: 'a', publishedAt: '2026-11-30T23:59:59Z' },
    { id: 'after', authorId: 'a', publishedAt: '2026-12-01T00:00:00Z' },
    { id: 'other-author', authorId: 'b', publishedAt: '2026-11-01T00:00:00Z' },
  ];
  assert.deepEqual(authorPosts(posts, 'a', period).map((post) => post.id), ['last', 'start']);
  assert.equal(authorPosts(posts, 'a', period, 'all').length, 4);
  assert.equal(authorPosts([{ id: 'legacy-date', authorId: 'a', date: '2026-11-02' }], 'a', { key: '2026-11' }).length, 1);
});

test('45 posts can all be reached in pages of 20 without duplication or a blank out-of-range page', () => {
  const posts = Array.from({ length: 45 }, (_, index) => ({ id: String(index) }));
  assert.equal(paginatePosts(posts).posts.length, 20);
  assert.equal(paginatePosts(posts, 2).posts.length, 5);
  assert.equal(paginatePosts(posts, 999).page, 2);
  assert.equal(paginatePosts(posts, -1).page, 0);
  assert.equal(paginatePosts([], 2).page, 0);
  assert.equal(new Set([0, 1, 2].flatMap((page) => paginatePosts(posts, page).posts.map((post) => post.id))).size, 45);
});

test('post links allow only canonical HTTPS X status pages and discard tracking parameters', () => {
  for (const url of ['javascript:alert(1)', 'http://x.com/a/status/123', 'https://x.com.evil.test/a/status/123', 'https://user@x.com/a/status/123', 'https://x.com/a/status/123/anything', 'https://x.com/a']) {
    assert.equal(safePostUrl({ url }), null, url);
  }
  assert.equal(safePostUrl({ url: 'https://x.com/a/status/123?tracking=1#x' }), 'https://x.com/a/status/123');
  assert.equal(safePostUrl({ url: 'https://twitter.com/a/status/123' }), 'https://x.com/a/status/123');
});

test('untrusted tweet text is escaped, and a legacy summary is labelled rather than presented as a full tweet', () => {
  assert.equal(escapeHTML('<img src=x onerror="x">&'), '&lt;img src=x onerror=&quot;x&quot;&gt;&amp;');
  const hostile = renderPost({ id: 'x', body: '<img src=x onerror="alert(1)"><script>alert(1)</script>', url: 'javascript:alert(1)', metrics: { impressions: 0, likes: null }, publishedAt: '2026-11-01' });
  assert.ok(hostile.includes('&lt;img'));
  assert.ok(!hostile.includes('<img'));
  assert.ok(!hostile.includes('<script>'));
  assert.ok(!hostile.includes('href='));
  assert.ok(hostile.includes('0 переглядів'));
  assert.ok(hostile.includes('— лайків'));
  const fallback = renderPost({ body: null, summary: '<b>Summary</b>', metrics: {} });
  assert.ok(fallback.includes('Короткий опис'));
  assert.ok(fallback.includes('&lt;b&gt;Summary&lt;/b&gt;'));
});

test('public UI ships no admin engine, stored account state, login endpoints or inline styles', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.ok(!/scoring\.js|model\.js|seed\.js/.test(html));
  assert.ok(!/\/api\/(workbench|me|auth|moderation)|localStorage|sessionStorage/.test(script));
  assert.ok(!/style=/.test(script));
  assert.ok(!/type=["']password|data-action=["'](?:ban|exclude|delete)/.test(html + script));
});

test('every static element required at startup exists, including the refresh button', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  const staticIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const dynamicIds = new Set(['creator-heading', 'posts-title', 'post-list']);
  assert.ok(staticIds.has('refresh-button'));
  for (const [, id] of script.matchAll(/byId\('([^']+)'\)/g)) assert.ok(staticIds.has(id) || dynamicIds.has(id), `Missing DOM id: ${id}`);
});

test('clipped screen reader table labels are anchored rather than extending the mobile document', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const declarations = Object.fromEntries([...css.matchAll(/\.sr-only\s*\{([^}]+)\}/g)]
    .flatMap((match) => match[1].split(';'))
    .filter((declaration) => declaration.includes(':'))
    .map((declaration) => declaration.split(':').map((value) => value.trim())));
  // A 390px browser regression showed the final table label at its 961px static x position.
  // Clipping hides pixels but does not prevent that unanchored position from widening the root.
  assert.equal(declarations.position, 'absolute');
  assert.equal(declarations.top, '0');
  assert.equal(declarations.left, '0');
  assert.equal(declarations.width, '1px');
  assert.equal(declarations.overflow, 'hidden');
});
