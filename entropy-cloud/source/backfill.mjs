import Model from './model.cjs';
import { normalizeTweets } from './twitterapi.mjs';
import { mergeDataset, classifySyncError } from './live-engine.mjs';

const TARGET = 'entropyIO';
const DAY = 86400000;
const MIN_WINDOW = 300000;
const SPACING = 5100;
const SNOWFLAKE_EPOCH = 1288834974657n;
const collectionMethods = new Set(['search', 'mentions', 'id-search']);
const copy = value => JSON.parse(JSON.stringify(value));
const activeStatuses = new Set(['running', 'waiting']);
const finishedStatuses = new Set(['complete', 'complete-with-gaps']);

function time(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) throw new Error('Invalid backfill ' + label + '.');
  const day = value.slice(0, 10), midnight = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) throw new Error('Invalid backfill ' + label + '.');
  if (value.length > 10 && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) throw new Error('Backfill times require a timezone.');
  const result = Date.parse(value.length === 10 ? value + 'T00:00:00Z' : value);
  if (!Number.isFinite(result)) throw new Error('Invalid backfill ' + label + '.');
  return result;
}
function nowTime(input) {
  const value = typeof input === 'function' ? input() : input ?? new Date();
  const result = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('Invalid backfill clock.');
  return result;
}
function validate(workbench) {
  return { dataset: Model.validateDataset(copy(workbench.dataset)),
    state: Model.validateState(copy(workbench.state || Model.initialState())), sync: copy(workbench.sync || {}) };
}
function window(start, endExclusive) {
  return { start: new Date(start).toISOString(), endExclusive: new Date(endExclusive).toISOString(),
    cursor: '', previousOldest: null, seenCursors: [] };
}
function dailyWindows(start, end) {
  const result = [];
  for (let point = start; point < end;) {
    const next = Math.min(end, Math.floor(point / DAY) * DAY + DAY);
    result.push(window(point, next)); point = next;
  }
  return result;
}
function requestLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Error('Backfill requestLimit must be an integer from 1 to 1000.');
  return value;
}
function idBound(timestamp) {
  // since_id is exclusive and max_id inclusive. Subtracting one gives the
  // exact half-open UTC window; IDs remain strings and never pass through Number.
  const milliseconds = BigInt(timestamp);
  if (milliseconds < SNOWFLAKE_EPOCH) throw new Error('ID-search bounds must be after the X Snowflake epoch.');
  return (((milliseconds - SNOWFLAKE_EPOCH) << 22n) - 1n).toString();
}

/** Start or explicitly resume an independent, bounded history scan. No I/O. */
export function beginBackfill(workbench, { start, endExclusive, requestLimit: limit = 250, method = 'search', now } = {}) {
  const result = validate(workbench), nowMs = nowTime(now);
  if (!collectionMethods.has(method)) throw new Error('Invalid backfill method.');
  const from = Math.floor(time(start, 'start') / 1000) * 1000;
  const until = Math.floor(time(endExclusive, 'end') / 1000) * 1000;
  limit = requestLimit(limit);
  if (until <= from || until - from > 62 * DAY || until > nowMs) throw new Error('Backfill range must be in the past and span at most 62 days.');
  if (method === 'id-search') { idBound(from); idBound(until); }
  if (result.sync.enabled !== true) throw new Error('Enable the collector before starting a backfill.');
  if (result.sync.paused === true) throw new Error('Resume the collector before starting a backfill.');
  const startIso = new Date(from).toISOString(), endIso = new Date(until).toISOString();
  const id = 'backfill:' + method + ':' + startIso + ':' + endIso;
  const existing = result.sync.backfill;
  const legacyId = 'backfill:' + startIso + ':' + endIso;
  if (existing && (existing.id === id || method === 'search' && existing.id === legacyId && (existing.method || 'search') === 'search')) {
    // A second start request can never erase paid progress or bypass backoff.
    if (!Number.isInteger(existing.requestCount) || existing.requestCount < 0) throw new Error('Invalid backfill checkpoint.');
    existing.method ||= 'search';
    existing.requestLimit = Math.max(requestLimit(existing.requestLimit), limit);
    if (finishedStatuses.has(existing.status)) return result;
    if (existing.requestCount >= existing.requestLimit) existing.status = 'request-limit';
    else if (existing.status === 'request-limit' || existing.status === 'paused') {
      existing.status = 'running'; existing.pauseReason = null;
      existing.nextAttemptAt = new Date(Math.max(nowMs, Date.parse(existing.nextAttemptAt) || 0)).toISOString();
    }
    return result;
  }
  if (existing && activeStatuses.has(existing.status)) throw new Error('A different backfill is already in progress.');
  const windows = dailyWindows(from, until), at = new Date(nowMs).toISOString();
  result.sync.backfill = { version: 1, id, method, target: TARGET, start: startIso, endExclusive: endIso,
    status: 'running', requestCount: 0, requestLimit: limit, successfulPages: 0, addedPosts: 0,
    observedPostIds: [], measuredPages: 0, pageStatsStartedAt: null, lastPageStats: null,
    fetchedRawTweets: 0, fetchedNormalizedNonReposts: 0, fetchedInRangeMentions: 0,
    initialWindows: windows.length, completedWindows: 0, pendingWindows: windows, completedRanges: [],
    gaps: [], splitWindows: 0, lastAttemptAt: null, lastSuccessAt: null, lastError: null,
    nextAttemptAt: at, startedAt: at, finishedAt: null, pauseReason: null };
  return result;
}

function directlyMentioned(tweet) {
  return /(^|[^A-Za-z0-9_])@entropyIO(?![A-Za-z0-9_])/i.test(typeof tweet.text === 'string' ? tweet.text : '') ||
    Array.isArray(tweet.entities?.user_mentions) && tweet.entities.user_mentions.some(m => typeof m?.screen_name === 'string' && m.screen_name.toLowerCase() === TARGET.toLowerCase());
}
function normalizePage(tweets, observedAt, current) {
  const data = normalizeTweets(tweets, { observedAt, query: '@' + TARGET });
  const normalizedNonReposts = data.posts.length;
  const mentionIds = new Set(tweets.filter(directlyMentioned).map(t => t.id));
  const from = Date.parse(current.start), until = Date.parse(current.endExclusive);
  data.posts = data.posts.filter(post => mentionIds.has(post.id) && post.authorHandle.toLowerCase() !== TARGET.toLowerCase()
    && Date.parse(post.publishedAt) >= from && Date.parse(post.publishedAt) < until);
  const authorIds = new Set(data.posts.map(post => post.authorId));
  data.authors = data.authors.filter(author => authorIds.has(author.id));
  data.meta.periodStart = current.start.slice(0, 10);
  data.meta.periodEndExclusive = new Date(Math.ceil(until / DAY) * DAY).toISOString().slice(0, 10);
  return { data, normalizedNonReposts };
}
function appendGap(sync, job, gap) {
  job.gaps.push(gap);
  sync.gaps = [...(Array.isArray(sync.gaps) ? sync.gaps : []), { ...gap, source: 'accelerated-backfill' }].slice(-50);
}
function missingKnownPosts(result, range, legacyOnly = false) {
  const job = result.sync.backfill, observed = new Set(job.observedPostIds || []);
  const from = Date.parse(range.start), until = Date.parse(range.endExclusive), startedAt = Date.parse(job.startedAt);
  return result.dataset.posts.filter(post => {
    const published = Date.parse(post.publishedAt), measured = Date.parse(post.metricsAsOf);
    return published >= from && published < until && !observed.has(post.id) &&
      typeof post.authorHandle === 'string' && post.authorHandle.toLowerCase() !== TARGET.toLowerCase() &&
      directlyMentioned({ text: post.body }) &&
      (!legacyOnly || !Number.isFinite(measured) || measured < startedAt);
  }).length;
}
function recordKnownGap(result, range, at, legacyOnly = false) {
  const { sync } = result, job = sync.backfill, count = missingKnownPosts(result, range, legacyOnly);
  if (!count) return;
  const matches = gap => gap.code === 'KNOWN_POST_NOT_RETURNED' && gap.start === range.start && gap.endExclusive === range.endExclusive;
  const existing = job.gaps.find(matches);
  if (existing) {
    existing.count = Math.max(existing.count || 0, count);
    const mirror = (sync.gaps || []).find(matches);
    if (mirror) mirror.count = existing.count;
  } else appendGap(sync, job, { code: 'KNOWN_POST_NOT_RETURNED', count, at, start: range.start, endExclusive: range.endExclusive });
}
function auditCompletedKnownPosts(result, at) {
  // Older checkpoints did not retain observed IDs. Their pre-job metric
  // timestamps still prove that known posts were not refreshed by this run.
  for (const range of result.sync.backfill.completedRanges || []) recordKnownGap(result, range, at, true);
}
function splitOrGap(sync, job, current, code, at) {
  job.consecutiveTimeouts = 0; job.timeoutWindow = null;
  const from = Date.parse(current.start), until = Date.parse(current.endExclusive);
  // Both children retain a meaningful minimum interval. Re-read observations
  // are deduplicated by exact post ID by mergeDataset.
  if (until - from >= 2 * MIN_WINDOW) {
    const middle = Math.floor((from + until) / 2000) * 1000;
    job.pendingWindows.splice(0, 1, window(from, middle), window(middle, until)); job.splitWindows++;
  } else {
    appendGap(sync, job, { code, at, start: current.start, endExclusive: current.endExclusive });
    job.pendingWindows.shift();
  }
}
function keepUncoveredWindow(current, from, until) {
  const a = Date.parse(current.start), b = Date.parse(current.endExclusive);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [current];
  if (b <= from || a >= until) return [current];
  const result = [];
  if (a < from) result.push(window(a, from));
  if (b > until) result.push(window(until, b));
  return result;
}
function finish(result, nowMs) {
  const { sync } = result, job = sync.backfill, at = new Date(nowMs).toISOString();
  auditCompletedKnownPosts(result, at);
  job.finishedAt = at; job.nextAttemptAt = null;
  job.status = job.gaps.length ? 'complete-with-gaps' : 'complete';
  if (job.gaps.length) return;
  const from = Date.parse(job.start), until = Date.parse(job.endExclusive);
  const discovery = sync.discovery ||= { pendingWindows: [], coveredThrough: null };
  const pending = Array.isArray(discovery.pendingWindows) ? discovery.pendingWindows : [];
  discovery.pendingWindows = pending.flatMap(value => keepUncoveredWindow(value, from, until));
  const priorGap = discovery.pendingWindows.some(value => Date.parse(value.start) < from);
  const oldCovered = Date.parse(discovery.coveredThrough) || 0;
  if (!priorGap) discovery.coveredThrough = new Date(Math.max(oldCovered, until)).toISOString();
  const previousRecent = Date.parse(discovery.recentThrough) || 0;
  if (!priorGap) {
    discovery.recentThrough = new Date(Math.max(previousRecent, until)).toISOString();
    const recentFrom = Date.parse(discovery.recentFrom);
    discovery.recentFrom = new Date(Number.isFinite(recentFrom) ? Math.min(recentFrom, from) : from).toISOString();
    if (discovery.recentWindow && Date.parse(discovery.recentWindow.endExclusive) <= until) discovery.recentWindow = null;
    else if (discovery.recentWindow && Date.parse(discovery.recentWindow.start) < until) {
      discovery.recentWindow = window(Math.max(Date.parse(discovery.recentWindow.start), until - MIN_WINDOW), Date.parse(discovery.recentWindow.endExclusive));
    }
  }
  discovery.nextLane = 'recent'; sync.phase = 'discovery';
  // This is the earliest eligible regular step; the hourly scheduler is unchanged.
  sync.nextRunAt = at;
}
function failure(result, error, nowMs) {
  const { sync } = result, job = sync.backfill, at = new Date(nowMs).toISOString();
  const httpStatus = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
  const code = [401, 403].includes(httpStatus) ? 'AUTH_REQUIRED' : httpStatus === 402 ? 'CREDITS_EXHAUSTED' : httpStatus === 429 ? 'RATE_LIMITED' : 'BACKFILL_FAILED';
  job.consecutiveFailures = (job.consecutiveFailures || 0) + 1;
  const wait = Math.min(3600000, 30000 * 2 ** Math.min(job.consecutiveFailures - 1, 7));
  job.lastError = { code, httpStatus, ...classifySyncError(error), at,
    message: 'The history page was not committed. Existing data and its checkpoint were retained.' };
  job.status = [401, 402, 403].includes(httpStatus) ? 'paused' : 'waiting';
  job.nextAttemptAt = new Date(nowMs + wait).toISOString();
  sync.lastError = job.lastError; sync.status = job.status === 'paused' ? 'paused' : 'error';
  if (job.status === 'paused') sync.paused = true;
  const current = job.pendingWindows[0];
  if (job.lastError.diagnosticCode === 'REQUEST_TIMEOUT' && current) {
    const key = current.start + '/' + current.endExclusive + '/' + current.cursor;
    job.consecutiveTimeouts = job.timeoutWindow === key ? (job.consecutiveTimeouts || 0) + 1 : 1;
    job.timeoutWindow = key;
    if (job.consecutiveTimeouts >= 2) {
      splitOrGap(sync, job, current, 'REQUEST_TIMEOUT', at);
      job.consecutiveFailures = 0; job.status = 'running'; sync.status = 'running';
      job.nextAttemptAt = new Date(nowMs + SPACING).toISOString();
      if (!job.pendingWindows.length) finish(result, nowMs);
      else if (job.requestCount >= job.requestLimit) { job.status = 'request-limit'; job.nextAttemptAt = null; }
    }
  } else { job.consecutiveTimeouts = 0; job.timeoutWindow = null; }
}

/** One search request only. Host must reserve usage, serialize and persist atomically. */
export async function advanceBackfill(workbench, { client, now } = {}) {
  const result = validate(workbench), { sync } = result, job = sync.backfill;
  const nowMs = nowTime(now), at = new Date(nowMs).toISOString();
  if (!job || !activeStatuses.has(job.status)) return result;
  if (sync.enabled !== true || sync.paused === true) {
    job.pauseReason = sync.paused ? 'COLLECTOR_PAUSED' : 'COLLECTOR_DISABLED'; return result;
  }
  job.pauseReason = null;
  if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > nowMs) return result;
  if (!Number.isInteger(job.requestCount) || job.requestCount < 0 || !Array.isArray(job.pendingWindows)) throw new Error('Invalid backfill checkpoint.');
  requestLimit(job.requestLimit);
  if (!job.pendingWindows.length) { finish(result, nowMs); return result; }
  if (job.requestCount >= job.requestLimit) { job.status = 'request-limit'; job.nextAttemptAt = null; return result; }
  auditCompletedKnownPosts(result, at);
  const current = copy(job.pendingWindows[0]);
  const method = job.method || 'search';
  if (!collectionMethods.has(method)) throw new Error('Invalid backfill method checkpoint.');
  if (!client || typeof client[method === 'mentions' ? 'mentionsPage' : 'searchPage'] !== 'function') throw new Error('A read-only collection client is required.');
  const from = time(current.start, 'checkpoint start'), until = time(current.endExclusive, 'checkpoint end');
  if (until <= from || typeof current.cursor !== 'string' || !Array.isArray(current.seenCursors)) throw new Error('Invalid backfill checkpoint.');
  if (method === 'id-search') { idBound(from); idBound(until); }
  job.lastAttemptAt = at; job.requestCount++;
  sync.lastAttemptAt = at; sync.requestCount = (Number.isInteger(sync.requestCount) ? sync.requestCount : 0) + 1;
  try {
    const query = method === 'id-search'
      ? '@' + TARGET + ' since_id:' + idBound(from) + ' max_id:' + idBound(until)
      : '@' + TARGET + ' since_time:' + Math.floor(from / 1000) + ' until_time:' + Math.floor(until / 1000);
    const page = method === 'mentions'
      ? await client.mentionsPage({ userName: TARGET, sinceTime: Math.floor(from / 1000), untilTime: Math.floor(until / 1000), cursor: current.cursor })
      : await client.searchPage({ query, cursor: current.cursor });
    if (!page || !Array.isArray(page.tweets) || typeof page.hasNextPage !== 'boolean') throw new Error('Invalid discovery response.');
    const times = page.tweets.map(tweet => Date.parse(tweet?.createdAt)).filter(Number.isFinite);
    job.lastPageStats = { rawTweets: page.tweets.length, normalizedNonReposts: null, inRangeMentions: null,
      oldest: times.length ? new Date(Math.min(...times)).toISOString() : null,
      newest: times.length ? new Date(Math.max(...times)).toISOString() : null };
    job.measuredPages = (job.measuredPages || 0) + 1; job.pageStatsStartedAt ||= at;
    job.fetchedRawTweets = (job.fetchedRawTweets || 0) + page.tweets.length;
    const normalized = normalizePage(page.tweets, at, current), incoming = normalized.data;
    job.lastPageStats.normalizedNonReposts = normalized.normalizedNonReposts;
    job.lastPageStats.inRangeMentions = incoming.posts.length;
    job.fetchedNormalizedNonReposts = (job.fetchedNormalizedNonReposts || 0) + normalized.normalizedNonReposts;
    job.fetchedInRangeMentions = (job.fetchedInRangeMentions || 0) + incoming.posts.length;
    const merged = mergeDataset(result.dataset, incoming), migrated = Model.reconcileImport(result.dataset, merged, result.state);
    const oldIds = new Set(result.dataset.posts.map(post => post.id));
    const added = incoming.posts.filter(post => !oldIds.has(post.id)).length;
    const cycle = page.hasNextPage && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor === current.cursor || current.seenCursors.includes(page.nextCursor));
    const jump = current.previousOldest !== null && times.length && Math.max(...times) > current.previousOldest;
    const empty = page.hasNextPage && !page.tweets.length;
    result.dataset = merged; result.state = migrated;
    job.observedPostIds = [...new Set([...(job.observedPostIds || []), ...incoming.posts.map(post => post.id)])];
    job.successfulPages++; job.addedPosts += added; job.lastPageAdded = added;
    job.lastSuccessAt = at; job.lastError = null; job.consecutiveFailures = 0; job.consecutiveTimeouts = 0; job.timeoutWindow = null; job.status = 'running';
    job.nextAttemptAt = new Date(nowMs + SPACING).toISOString();
    sync.lastSuccessAt = at; sync.lastError = null; sync.consecutiveFailures = 0; sync.status = 'running';
    if (incoming.posts.length) sync.lastDataAt = at;
    if (cycle || jump || empty) splitOrGap(sync, job, current, cycle ? 'CURSOR_CYCLE' : jump ? 'PAGINATION_ORDER' : 'EMPTY_CONTINUATION', at);
    else if (page.hasNextPage) {
      current.cursor = page.nextCursor;
      current.previousOldest = times.length ? Math.min(...times) : current.previousOldest;
      current.seenCursors = [...current.seenCursors, page.nextCursor].slice(-1000);
      job.pendingWindows[0] = current;
    } else {
      recordKnownGap(result, current, at);
      job.pendingWindows.shift(); job.completedWindows++;
      job.completedRanges.push({ start: current.start, endExclusive: current.endExclusive });
    }
    if (!job.pendingWindows.length) finish(result, nowMs);
    else if (job.requestCount >= job.requestLimit) { job.status = 'request-limit'; job.nextAttemptAt = null; }
  } catch (error) {
    // The provider adapter rejects a repeated immediate cursor before returning
    // that page. Re-query smaller windows rather than retrying it forever.
    if (error?.code === 'INVALID_RESPONSE' && error?.message === 'Некоректний курсор наступної сторінки.') {
      splitOrGap(sync, job, current, 'CURSOR_CYCLE', at);
      job.paginationRetries = (job.paginationRetries || 0) + 1;
      job.status = 'running'; job.nextAttemptAt = new Date(nowMs + SPACING).toISOString();
      job.lastError = null; sync.lastError = null; sync.status = 'running';
      if (!job.pendingWindows.length) finish(result, nowMs);
      else if (job.requestCount >= job.requestLimit) { job.status = 'request-limit'; job.nextAttemptAt = null; }
    } else failure(result, error, nowMs);
  }
  return result;
}
