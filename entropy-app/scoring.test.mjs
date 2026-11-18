import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./scoring.js', import.meta.url), 'utf8');
const context = vm.createContext({ module: { exports: {} }, URL });
vm.runInContext(source, context);
const { scoreAuthor, assessAccount, computeSmartMetrics, ALGORITHM_VERSION } = context.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const baseline = {
  impressions: 100000, likes: 1000, reposts: 0, quotes: 0,
  followers: 10000, smartFollowers: 1000, smartEngagement: 0, posts: 2,
  smartFollowersComplete: true, smartEngagementComplete: true,
};
const account = (id, trust, extra = {}) => ({
  id, trust, reason: 'Публічна історія перевірена для тесту.',
  evidence: [{ url: `https://x.com/example/status/${id}`, note: 'Приклад.' }], ...extra,
});

test('browser global and CommonJS expose the same versioned API', () => {
  assert.equal(context.EntropyScoring, context.module.exports);
  assert.equal(ALGORITHM_VERSION, 'entropy-zama-adapted-v0.1');
});

test('reference arithmetic uses ER as a fraction and natural log', () => {
  const result = scoreAuthor(baseline);
  assert.equal(result.status, 'eligible');
  near(result.components.er, 0.01);
  near(result.components.ERpercent, 1);
  near(result.components.EngObs, 1000);
  near(result.components.Clamp, 1);
  near(result.components.QE, 2);
  near(result.score, 5360.259265249107, 1e-6);
  near(scoreAuthor({ ...baseline, smartEngagement: 100 }).score, 19712.259265249107, 1e-6);
});

test('quotes get the reach-dependent 4–6 weight and ENG_raw is explicit', () => {
  const result = scoreAuthor({ ...baseline, impressions: 50000, likes: 0, reposts: 1, quotes: 2 });
  near(result.components.qW, 5);
  near(result.components.ENG, 13);
  near(result.components.ENG_raw, 13);
  near(result.components.EngObs, 13);
});

test('unknown input remains incomplete instead of becoming zero', () => {
  const result = scoreAuthor({ ...baseline, quotes: null });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.score, null);
  assert.ok(result.missing.includes('quotes'));
  assert.equal(result.components.ENG, null);
});

test('zero engagement is finite and zero smart followers do not erase reach', () => {
  const result = scoreAuthor({ ...baseline, likes: 0, smartFollowers: 0, smartEngagement: null, smartEngagementComplete: false });
  assert.equal(result.status, 'eligible');
  assert.equal(result.components.EngObs, 0);
  assert.equal(result.components.Clamp, 1);
  assert.equal(result.components.SENG, 0);
  assert.equal(result.components.smartEngagementExact, true);
  assert.ok(result.score > 0 && Number.isFinite(result.score));
});

test('minimum post and impression eligibility does not invent zero scores', () => {
  for (const input of [{ ...baseline, posts: 1 }, { ...baseline, impressions: 0 }]) {
    const result = scoreAuthor(input);
    assert.equal(result.status, 'ineligible');
    assert.equal(result.score, null);
    assert.ok(Object.values(result.components).every(v => typeof v !== 'number' || Number.isFinite(v)));
  }
});

test('20 percent is a strict review threshold, not automatic DQ or ban', () => {
  const exact = scoreAuthor({ ...baseline, likes: 20000 });
  assert.equal(exact.status, 'eligible');
  const over = scoreAuthor({ ...baseline, likes: 20001 });
  assert.equal(over.status, 'review');
  assert.equal(over.requiresReview, true);
  assert.ok(over.score > 0);
  assert.ok(over.reasonCodes.includes('ER_ABOVE_20_REVIEW'));
});

test('low-reach penalty is strict at 10 percent and stops at 50000 impressions', () => {
  near(scoreAuthor({ ...baseline, impressions: 40000, likes: 4000 }).components.penaltyMult, 1);
  near(scoreAuthor({ ...baseline, impressions: 49999, likes: 6000 }).components.penaltyMult, 0.30);
  near(scoreAuthor({ ...baseline, impressions: 50000, likes: 6000 }).components.penaltyMult, 1);
});

test('posting boost caps at forty percent', () => {
  near(scoreAuthor({ ...baseline, posts: 20 }).components.postMult, 1.4);
  near(scoreAuthor({ ...baseline, posts: 200 }).components.postMult, 1.4);
});

test('partial smart data cannot produce an exact score below saturation', () => {
  const result = scoreAuthor({ ...baseline, smartFollowers: 998, smartFollowersComplete: false });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.score, null);
  assert.ok(result.missing.includes('smartFollowersComplete'));
  assert.equal(result.components.finalScore, null);
  const se = scoreAuthor({ ...baseline, smartEngagement: 100, smartEngagementComplete: false });
  assert.equal(se.status, 'incomplete');
});

test('mathematically saturated caps allow exact components despite partial lists', () => {
  const result = scoreAuthor({ ...baseline, smartFollowers: 999, smartFollowersComplete: false,
    smartEngagement: 500, smartEngagementComplete: false });
  assert.equal(result.status, 'eligible');
  near(result.components.SF, 3);
  near(result.components.SENG, 500);
  assert.equal(result.components.smartFollowersCapReached, true);
  assert.equal(result.components.smartEngagementCapReached, true);
});

test('invalid values cannot escape as NaN or numeric zero observations', () => {
  for (const invalid of [-1, NaN, Infinity, '1000']) {
    const result = scoreAuthor({ ...baseline, likes: invalid });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.score, null);
    assert.ok(result.invalid.includes('likes'));
  }
  assert.equal(scoreAuthor({ ...baseline, posts: 2.5 }).status, 'incomplete');
});

test('editorial trust needs a reason and a usable evidence URL', () => {
  assert.equal(assessAccount({ id: 'a', trust: null }).status, 'unassessed');
  assert.equal(assessAccount({ id: 'a', trust: 0.5 }).trust, null);
  assert.equal(assessAccount(account('a', 1)).trust, 1);
  assert.equal(assessAccount(account('a', 0)).trust, 0);
  assert.equal(assessAccount(account('a', 1, { evidence: [{ url: 'javascript:alert(1)' }] })).status, 'invalid');
  assert.equal(assessAccount(account('a', 0.8)).status, 'invalid');
});

test('smart sums deduplicate IDs, exclude self and retain unknown assessments', () => {
  const accounts = [account('u1', 1), account('u2', 0.5), account('u3', 0), account('creator', 1)];
  const followers = [
    { authorId: 'creator', accountId: 'u1', confirmed: true },
    { authorId: 'creator', accountId: 'u1', confirmed: true },
    { authorId: 'creator', accountId: 'u2', confirmed: true },
    { authorId: 'creator', accountId: 'unknown', confirmed: true },
    { authorId: 'creator', accountId: 'creator', confirmed: true },
    { authorId: 'creator', accountId: 'u3', confirmed: false },
  ];
  const event = (accountId, type = 'reply', postId = 'p1', meaningful = true) => ({authorId: 'creator', accountId, type, postId, meaningful});
  const interactions = [event('u1'), event('u1', 'quote'), event('u1', 'reply', 'p2'), event('u2'),
    event('u3'), event('unknown'), event('creator'), event('u2', 'like'), event('u2', 'reply', 'excluded'), event('u1', 'reply', 'p1', false)];
  const result = computeSmartMetrics('creator', accounts, followers, interactions, ['p1', 'p2']);
  near(result.smartFollowers, 1.5);
  near(result.smartEngagement, 1.5);
  assert.equal(result.followers.confirmedCount, 3);
  assert.deepEqual(plain(result.followers.unknownAccountIds), ['unknown']);
  assert.equal(result.engagement.qualifiedAccountCount, 4);
  assert.equal(result.smartFollowersComplete, false);
  assert.equal(result.smartEngagementComplete, false);
});

test('interaction period is start-inclusive and end-exclusive; undated is unknown', () => {
  const makeEvent = (accountId, occurredAt) => ({ authorId: 'a', accountId, postId: 'p', type: 'quote', meaningful: true, occurredAt });
  const result = computeSmartMetrics('a', [account('one', 1), account('two', 1), account('three', 1)], [], [
    makeEvent('one', '2026-11-01T00:00:00Z'),
    makeEvent('two', '2026-12-01T00:00:00Z'),
    makeEvent('three', undefined),
  ], new Set(['p']), { start: '2026-11-01T00:00:00Z', endExclusive: '2026-12-01T00:00:00Z' });
  near(result.smartEngagement, 1);
  assert.deepEqual(plain(result.engagement.undatedAccountIds), ['three']);
  assert.equal(result.diagnostics.outOfPeriodInteractions, 1);
  assert.ok(result.missing.includes('INTERACTION_DATES_UNVERIFIED'));
});

test('conflicting duplicate assessments are unverified, not arbitrarily chosen', () => {
  const result = computeSmartMetrics('a', [account('u', 1), account('u', 0)],
    [{ authorId: 'a', accountId: 'u', confirmed: true }], [], []);
  near(result.smartFollowers, 0);
  assert.deepEqual(plain(result.followers.unknownAccountIds), ['u']);
  assert.deepEqual(plain(result.diagnostics.duplicateAccountIds), ['u']);
});

test('unclassified meaningfulness is an engagement gap, not a verified zero', () => {
  const event = (accountId, meaningful) => ({ authorId: 'a', accountId, postId: 'p', type: 'quote', meaningful });
  const result = computeSmartMetrics('a', [account('one', 1), account('two', 1)], [],
    [event('one', null), event('two', undefined)], ['p']);
  near(result.smartEngagement, 0);
  assert.deepEqual(plain(result.engagement.unclassifiedAccountIds), ['one', 'two']);
  assert.ok(result.engagement.missing.includes('INTERACTION_MEANINGFULNESS_UNVERIFIED'));
  const sourceCoverageComplete = true;
  assert.equal(sourceCoverageComplete && result.engagement.missing.length === 0, false);

  const classified = computeSmartMetrics('a', [account('one', 1)], [], [event('one', false)], ['p']);
  near(classified.smartEngagement, 0);
  assert.deepEqual(plain(classified.engagement.missing), []);
});

test('follower and engagement gaps are independent for source-coverage decisions', () => {
  const event = { authorId: 'a', accountId: 'reviewed', postId: 'p', type: 'reply', meaningful: true };
  const followerGap = computeSmartMetrics('a', [account('reviewed', 1)],
    [{ authorId: 'a', accountId: 'unreviewed', confirmed: true }], [event], ['p']);
  assert.deepEqual(plain(followerGap.followers.missing), ['FOLLOWER_ASSESSMENTS_MISSING']);
  assert.deepEqual(plain(followerGap.engagement.missing), []);
  near(followerGap.smartEngagement, 1);

  const engagementGap = computeSmartMetrics('a', [account('reviewed', 1)],
    [{ authorId: 'a', accountId: 'reviewed', confirmed: true }], [{ ...event, meaningful: null }], ['p']);
  assert.deepEqual(plain(engagementGap.followers.missing), []);
  assert.deepEqual(plain(engagementGap.engagement.missing), ['INTERACTION_MEANINGFULNESS_UNVERIFIED']);
  near(engagementGap.smartFollowers, 1);
});

test('one confirmed meaningful interaction resolves the same account’s classification uncertainty', () => {
  const event = { authorId: 'a', accountId: 'u', postId: 'p', type: 'reply' };
  const result = computeSmartMetrics('a', [account('u', 1)], [],
    [{ ...event, meaningful: null }, { ...event, meaningful: true }], ['p']);
  near(result.smartEngagement, 1);
  assert.deepEqual(plain(result.engagement.unclassifiedAccountIds), []);
  assert.deepEqual(plain(result.engagement.missing), []);
});
