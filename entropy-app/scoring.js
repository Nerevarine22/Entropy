(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EntropyScoring = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ALGORITHM_VERSION = 'entropy-zama-adapted-v0.1';
  const NUMERIC_INPUTS = [
    'impressions', 'likes', 'reposts', 'quotes', 'followers',
    'smartFollowers', 'smartEngagement', 'posts',
  ];

  function finiteNonnegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  function canonicalId(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function unique(values) {
    return Array.from(new Set(values));
  }

  /**
   * Entropy's explicit interpretation of the supplied Zama v0.1 arithmetic.
   * ER is a fraction internally, ENG_raw is ENG, and QE uses natural log.
   * ER > 20% requests review; it never creates a ban or automatic DQ here.
   * No missing numerical observation is converted into an observed zero.
   */
  function scoreAuthor(rawInput) {
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    const invalid = [];
    const missing = [];
    const reasonCodes = [];
    const values = {};
    for (const key of NUMERIC_INPUTS) {
      const value = input[key];
      if (value === null || value === undefined) values[key] = null;
      else if (!finiteNonnegative(value) || (key === 'posts' && !Number.isInteger(value))) {
        values[key] = null;
        invalid.push(key);
      } else values[key] = value;
    }

    const components = {
      er: null, ERpercent: null, SRM: null, SF: null, IMP: null,
      qW: null, ENG: null, ENG_raw: null, EngObs: null, ERcap: null,
      EffEng: null, Clamp: null, SENG: null, QE: null,
      postMult: null, erMult: null, engageBlock: null,
      audienceBlock: null, reachBlock: null, efficiencyBlock: null,
      baseScore: null, penaltyMult: null, finalScore: null,
      smartFollowersExact: false, smartEngagementExact: false,
      smartFollowersCapReached: false, smartEngagementCapReached: false,
    };

    const I = values.impressions;
    const P = values.posts;
    const coreKeys = ['impressions', 'likes', 'reposts', 'quotes', 'followers', 'posts'];
    for (const key of coreKeys) if (values[key] === null) missing.push(key);
    for (const key of invalid) reasonCodes.push('INVALID_' + key.replace(/[A-Z]/g, m => '_' + m).toUpperCase());

    if (I !== null) {
      components.SRM = Math.min(1, I / 100000);
      components.IMP = Math.sqrt(I);
      components.reachBlock = components.IMP * 10;
      components.qW = 4 + 2 * components.SRM;
      components.ERcap = 0.01 + 0.04 * components.SRM;
    }
    if (P !== null) components.postMult = 1 + 0.02 * Math.min(P, 20);

    if (values.smartFollowers !== null) {
      components.SF = Math.min(Math.log10(values.smartFollowers + 1), 3);
      components.audienceBlock = components.SF * 500;
      components.smartFollowersCapReached = values.smartFollowers >= 999;
      components.smartFollowersExact = input.smartFollowersComplete === true || components.smartFollowersCapReached;
      if (!components.smartFollowersExact) {
        missing.push('smartFollowersComplete');
        reasonCodes.push('SMART_FOLLOWERS_PARTIAL');
      }
    } else missing.push('smartFollowers');

    const reactionsKnown = ['likes', 'reposts', 'quotes'].every(k => values[k] !== null);
    if (I !== null && components.qW !== null && reactionsKnown) {
      const unweighted = values.likes + values.reposts + values.quotes;
      components.ENG = values.likes + 3 * values.reposts + components.qW * values.quotes;
      components.ENG_raw = components.ENG;
      if (I > 0) {
        components.er = unweighted / I;
        components.ERpercent = 100 * components.er;
        components.EngObs = Math.max(components.ENG_raw, components.er * I);
        components.EffEng = Math.min(components.EngObs, I * components.ERcap);
        components.Clamp = components.EngObs === 0 ? 1 : components.EffEng / components.EngObs;
        components.erMult = 0.90 + 2 * Math.min(components.er, 0.05);
        components.penaltyMult = components.er > 0.10 && I < 50000 ? 0.30 : 1;
        if (components.er > 0.20) reasonCodes.push('ER_ABOVE_20_REVIEW');
        if (components.penaltyMult === 0.30) reasonCodes.push('ER_ABOVE_10_LOW_REACH_PENALTY');
      }
    }

    if (I !== null && values.followers !== null) {
      components.QE = Math.min(Math.log1p(I / Math.max(values.followers, 1)), 2) * components.SRM;
      components.efficiencyBlock = components.QE * 120;
    }

    if (components.EffEng !== null) {
      const smartCap = 0.5 * components.EffEng;
      if (smartCap === 0) {
        // A zero cap establishes an exact zero contribution, even if its input is unknown.
        components.SENG = 0;
        components.smartEngagementCapReached = true;
        components.smartEngagementExact = true;
      } else if (values.smartEngagement !== null) {
        components.SENG = Math.min(values.smartEngagement, smartCap);
        components.smartEngagementCapReached = values.smartEngagement >= smartCap;
        components.smartEngagementExact = input.smartEngagementComplete === true || components.smartEngagementCapReached;
      }
    }
    if (!components.smartEngagementExact) {
      if (values.smartEngagement === null) missing.push('smartEngagement');
      else {
        missing.push('smartEngagementComplete');
        reasonCodes.push('SMART_ENGAGEMENT_PARTIAL');
      }
    }

    const engagementKnown = ['ENG', 'Clamp', 'SENG', 'SRM'].every(k => components[k] !== null);
    if (engagementKnown) {
      components.engageBlock = (
        0.7 * components.ENG * components.Clamp + 150 * components.SENG
      ) * Math.pow(components.SRM, 1.5);
    }
    if (['audienceBlock', 'reachBlock', 'engageBlock', 'efficiencyBlock'].every(k => components[k] !== null)) {
      components.baseScore = components.audienceBlock + components.reachBlock + components.engageBlock + components.efficiencyBlock;
      if (components.erMult !== null && components.postMult !== null && components.penaltyMult !== null) {
        components.finalScore = components.baseScore * components.erMult * components.postMult * components.penaltyMult;
      }
    }

    let arithmeticOverflow = false;
    for (const key of Object.keys(components)) {
      if (typeof components[key] === 'number' && !Number.isFinite(components[key])) {
        components[key] = null;
        arithmeticOverflow = true;
      }
    }
    if (arithmeticOverflow) {
      reasonCodes.push('NUMERIC_OVERFLOW');
      components.finalScore = null;
    }

    const requiresReview = components.er !== null && components.er > 0.20;
    const ineligible = (P !== null && P < 2) || I === 0;
    if (P !== null && P < 2) reasonCodes.push('POSTS_LT_2');
    if (I === 0) reasonCodes.push('NO_IMPRESSIONS');
    let status;
    let score = null;
    if (ineligible && invalid.length === 0) status = 'ineligible';
    else if (missing.length || invalid.length || arithmeticOverflow || components.finalScore === null) {
      status = 'incomplete';
      reasonCodes.push('INCOMPLETE_INPUTS');
    } else {
      status = requiresReview ? 'review' : 'eligible';
      score = components.finalScore;
    }
    if (status === 'incomplete' || status === 'ineligible') components.finalScore = null;
    return {
      algorithmVersion: ALGORITHM_VERSION,
      status,
      score,
      provisional: status === 'review' || status === 'incomplete',
      requiresReview,
      reasonCodes: unique(reasonCodes),
      components,
      missing: unique(missing.concat(invalid)),
      invalid: unique(invalid),
    };
  }

  function usableEvidence(evidence) {
    if (!Array.isArray(evidence)) return [];
    return evidence.filter(item => {
      if (!item || typeof item.url !== 'string') return false;
      try {
        const parsed = new URL(item.url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
      } catch (_) { return false; }
    }).map(item => ({ url: item.url.trim(), note: typeof item.note === 'string' ? item.note.trim() : '' }));
  }

  /** Validate an editorial assessment. This function does not classify accounts as bots. */
  function assessAccount(account) {
    const record = account && typeof account === 'object' ? account : {};
    const id = canonicalId(record.id);
    const evidence = usableEvidence(record.evidence);
    const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
    const reasonCodes = [];
    if (!id) reasonCodes.push('MISSING_ACCOUNT_ID');
    if (record.trust === null || record.trust === undefined) {
      return { id, status: id ? 'unassessed' : 'invalid', trust: null, reason, evidence,
        reviewedAt: record.reviewedAt || null, reasonCodes: reasonCodes.concat('TRUST_UNASSESSED') };
    }
    if (![0, 0.5, 1].includes(record.trust)) reasonCodes.push('INVALID_TRUST');
    if (!reason) reasonCodes.push('MISSING_ASSESSMENT_REASON');
    if (!evidence.length) reasonCodes.push('MISSING_ASSESSMENT_EVIDENCE');
    return {
      id,
      status: reasonCodes.length ? 'invalid' : 'assessed',
      trust: reasonCodes.length ? null : record.trust,
      reason,
      evidence,
      reviewedAt: record.reviewedAt || null,
      reasonCodes: reasonCodes.length ? reasonCodes : ['TRUST_ASSESSED'],
    };
  }

  /**
   * Known weighted sums for explicitly supplied identities and relationships.
   * A list's end is NOT evidence that the platform's full population was fetched.
   * Completeness therefore stays false; callers own verified source-coverage metadata.
   * Optional period {start,endExclusive} filters interaction timestamps. Missing
   * timestamps in that mode remain unverified and are reported separately.
   */
  function computeSmartMetrics(authorId, accounts, followRelations, interactions, includedPostIds, period) {
    const author = canonicalId(authorId);
    const assessments = new Map();
    const duplicateAccountIds = new Set();
    for (const record of Array.isArray(accounts) ? accounts : []) {
      const assessment = assessAccount(record);
      if (!assessment.id) continue;
      const prior = assessments.get(assessment.id);
      if (prior && (prior.status !== assessment.status || prior.trust !== assessment.trust)) {
        duplicateAccountIds.add(assessment.id);
        assessments.set(assessment.id, { ...assessment, status: 'invalid', trust: null, reasonCodes: ['CONFLICTING_ACCOUNT_ASSESSMENTS'] });
      } else if (!duplicateAccountIds.has(assessment.id)) assessments.set(assessment.id, assessment);
    }

    const included = new Set(Array.from(includedPostIds || []).map(canonicalId));
    const followerIds = new Set();
    for (const rel of Array.isArray(followRelations) ? followRelations : []) {
      if (rel && rel.confirmed === true && canonicalId(rel.authorId) === author) {
        const id = canonicalId(rel.accountId);
        if (id && id !== author) followerIds.add(id);
      }
    }

    const periodProvided = !!(period && (period.start !== undefined || period.endExclusive !== undefined));
    const start = periodProvided && period.start !== undefined ? Date.parse(period.start) : -Infinity;
    const end = periodProvided && period.endExclusive !== undefined ? Date.parse(period.endExclusive) : Infinity;
    const invalidPeriod = periodProvided && (Number.isNaN(start) || Number.isNaN(end) || end <= start);
    const qualifiedIds = new Set();
    const undatedIds = new Set();
    const unclassifiedIds = new Set();
    let ignoredInteractions = 0;
    let outOfPeriodInteractions = 0;
    for (const event of Array.isArray(interactions) ? interactions : []) {
      if (!event || canonicalId(event.authorId) !== author || !included.has(canonicalId(event.postId)) ||
          !['quote', 'reply'].includes(event.type)) {
        ignoredInteractions++;
        continue;
      }
      const id = canonicalId(event.accountId);
      if (!id || id === author) { ignoredInteractions++; continue; }
      if (event.meaningful === false) { ignoredInteractions++; continue; }
      if (periodProvided) {
        const timestamp = event.occurredAt ? Date.parse(event.occurredAt) : NaN;
        if (invalidPeriod || Number.isNaN(timestamp)) {
          undatedIds.add(id);
          if (event.meaningful !== true) unclassifiedIds.add(id);
          continue;
        }
        if (timestamp < start || timestamp >= end) { outOfPeriodInteractions++; continue; }
      }
      if (event.meaningful !== true) { unclassifiedIds.add(id); continue; }
      qualifiedIds.add(id);
    }

    function totalFor(ids) {
      let total = 0;
      let assessedCount = 0;
      const contributors = [];
      const unknownAccountIds = [];
      for (const id of ids) {
        const assessment = assessments.get(id);
        if (!assessment || assessment.status !== 'assessed') unknownAccountIds.push(id);
        else {
          total += assessment.trust;
          assessedCount++;
          contributors.push({ accountId: id, trust: assessment.trust, contribution: assessment.trust });
        }
      }
      return { total, assessedCount, unknownAccountIds, contributors };
    }
    const followers = totalFor(followerIds);
    const engagement = totalFor(qualifiedIds);
    const undatedUnresolved = Array.from(undatedIds).filter(id => !qualifiedIds.has(id));
    const unclassifiedUnresolved = Array.from(unclassifiedIds).filter(id => !qualifiedIds.has(id));
    const followerMissing = [];
    const engagementMissing = [];
    if (followers.unknownAccountIds.length) followerMissing.push('FOLLOWER_ASSESSMENTS_MISSING');
    if (engagement.unknownAccountIds.length) engagementMissing.push('ENGAGEMENT_ASSESSMENTS_MISSING');
    if (undatedUnresolved.length) engagementMissing.push('INTERACTION_DATES_UNVERIFIED');
    if (unclassifiedUnresolved.length) engagementMissing.push('INTERACTION_MEANINGFULNESS_UNVERIFIED');
    if (invalidPeriod) engagementMissing.push('INVALID_PERIOD');
    const missing = unique(followerMissing.concat(engagementMissing));
    return {
      algorithmVersion: ALGORITHM_VERSION,
      smartFollowers: followers.total,
      smartEngagement: engagement.total,
      smartFollowersComplete: false,
      smartEngagementComplete: false,
      followers: { ...followers, confirmedCount: followerIds.size, missing: followerMissing },
      engagement: { ...engagement, qualifiedAccountCount: qualifiedIds.size, undatedAccountIds: undatedUnresolved,
        unclassifiedAccountIds: unclassifiedUnresolved, missing: engagementMissing },
      missing,
      diagnostics: { ignoredInteractions, outOfPeriodInteractions, invalidPeriod, duplicateAccountIds: Array.from(duplicateAccountIds) },
    };
  }

  return { ALGORITHM_VERSION, scoreAuthor, assessAccount, computeSmartMetrics };
});
