import { advanceHourlyDiscovery, classifySyncError } from '../entropy-app/live-engine.mjs';
import { createClient } from '../entropy-app/twitterapi.mjs';
import { METRIC_BATCH_SIZE, METRIC_INTERVAL, observePostMetrics, selectMetricPosts } from './leaderboard-metrics.mjs';

const STREAMS = [
  ['mentions', '@entropyIO'],
  ['keywords', 'entropyIO'],
  ['mention-quotes', '@entropyIO filter:quote'],
  ['keyword-quotes', 'entropyIO filter:quote'],
];
const EMPTY = { meta: {}, authors: [], posts: [] };
const DAILY_LIMIT = 168;
const CATCHUP_LIMIT = 48;
const MONTHLY_UNITS = 66666;
const MONTHLY_METRIC_UNITS = 30000;
const DAILY_METRIC_UNITS = 480;
const PAGE_RESERVE = 100;
const LEASE_MS = 90000;
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();

async function loadState(db) {
  const row = await db.prepare("SELECT payload FROM entropy_leaderboard_ingestion WHERE id='main'").first();
  const state = row ? JSON.parse(row.payload) : { version: 1, next: 0, streams: {}, addedPosts: 0 };
  if (state.version !== 1 || !state.streams || !Number.isInteger(state.next) || state.next < 0 || state.next >= STREAMS.length) {
    throw new Error('Invalid ingestion checkpoint.');
  }
  return state;
}

function budgetFor(state, at) {
  const month = at.slice(0, 7), day = at.slice(0, 10);
  const previous = state.budget;
  return { month, day, units: previous?.month === month ? previous.units : 0,
    metricUnits: previous?.month === month ? (previous.metricUnits ?? 0) : 0,
    dailyMetricUnits: previous?.day === day ? (previous.dailyMetricUnits ?? 0) : 0,
    catchupAttempts: previous?.day === day ? (previous.catchupAttempts ?? 0) : 0,
    recoveryAttempts: previous?.day === day ? (previous.recoveryAttempts ?? 0) : 0 };
}

function due(value, now) {
  return !value || Date.parse(value) <= now;
}

function discoveryStep(state, now, budget, lane, recovery = false) {
  for (let offset = 0; offset < STREAMS.length; offset++) {
    const index = (state.next + offset) % STREAMS.length;
    const [key, term] = STREAMS[index];
    const sync = state.streams[key], hourly = sync?.hourly;
    if (sync?.paused) continue;
    const ready = lane === 'latest' ? due(hourly?.nextRunAt || sync?.nextRunAt, now)
      : (recovery || budget.catchupAttempts < CATCHUP_LIMIT) && hourly?.pendingWindows?.length && due(hourly.nextAttemptAt, now);
    if (ready) return { index, key, term, lane, sync };
  }
  return null;
}

function nextStep(state, now, budget) {
  const latest = discoveryStep(state, now, budget, 'latest');
  if (latest) return latest;
  const limit = Math.min(METRIC_BATCH_SIZE, DAILY_METRIC_UNITS - budget.dailyMetricUnits,
    MONTHLY_METRIC_UNITS - budget.metricUnits, MONTHLY_UNITS - budget.units - PAGE_RESERVE);
  if (limit > 0 && due(state.metrics?.nextAttemptAt, now)) return { lane: 'metrics', key: 'metrics', limit };
  return discoveryStep(state, now, budget, 'catchup');
}

function retainCoverage(hourly) {
  if (!hourly) return;
  const through = Date.parse(hourly.completedThrough) || 0;
  const spans = hourly.completedRanges.filter(range => Date.parse(range.endExclusive) > through)
    .sort((a, b) => a.start.localeCompare(b.start));
  const merged = [];
  for (const range of spans) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.endExclusive) {
      if (previous.endExclusive < range.endExclusive) previous.endExclusive = range.endExclusive;
    } else merged.push(range);
  }
  hourly.completedRanges = merged;
  hourly.gaps = hourly.gaps.slice(-50);
}

const guarded = "id='main' AND generation=? AND revision=? AND lease_token=? AND lease_until>?";
const held = 'EXISTS (SELECT 1 FROM entropy_control WHERE ' + guarded + ')';
function checkpointWrite(db, state, args) {
  return db.prepare(`INSERT INTO entropy_leaderboard_ingestion (id,payload)
    SELECT 'main',? WHERE ${held} ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`)
    .bind(JSON.stringify(state), ...args);
}

async function newRecords(db, generation, dataset) {
  if (!dataset.posts.length) return { posts: [], authors: [] };
  const placeholders = dataset.posts.map(() => '?').join(',');
  const { results } = await db.prepare(`SELECT record_id FROM entropy_records
    WHERE generation=? AND kind='post' AND chunk_index=0 AND record_id IN (${placeholders})`)
    .bind(generation, ...dataset.posts.map(post => post.id)).all();
  const existing = new Set(results.map(row => row.record_id));
  const posts = dataset.posts.filter(post => !existing.has(post.id));
  const owners = new Set(posts.map(post => post.authorId));
  return { posts, authors: dataset.authors.filter(author => owners.has(author.id)) };
}

function recordWrites(db, generation, incoming, args, now) {
  const statements = [];
  for (const [kind, values] of [['author', incoming.authors], ['post', incoming.posts]]) {
    for (const value of values) {
      statements.push(db.prepare(`INSERT INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at)
        SELECT ?,?,?,0,?,? WHERE ${held} ON CONFLICT (generation,kind,record_id,chunk_index) DO NOTHING`)
        .bind(generation, kind, value.id, JSON.stringify(value), now, ...args));
    }
  }
  if (incoming.posts.length) {
    const dates = incoming.posts.map(post => post.date).sort();
    const start = dates[0], end = iso(Date.parse(dates.at(-1)) + DAY).slice(0, 10);
    statements.push(db.prepare(`UPDATE entropy_records SET payload=json_set(payload,
      '$.asOf',max(coalesce(json_extract(payload,'$.asOf'),?),?),
      '$.periodStart',min(coalesce(json_extract(payload,'$.periodStart'),?),?),
      '$.periodEndExclusive',max(coalesce(json_extract(payload,'$.periodEndExclusive'),?),?))
      WHERE generation=? AND kind='dataset-meta' AND record_id='main' AND chunk_index=0 AND ${held}`)
      .bind(iso(now), iso(now), start, start, end, end, generation, ...args));
  }
  return statements;
}

async function scanDiscovery(db, state, step, api, control, args, now, startingAt) {
  const { key, term, lane, sync } = step;
  let units = 0;
  const result = await advanceHourlyDiscovery({
    dataset: EMPTY,
    sync: sync ?? { enabled: true, discovery: { recentThrough: iso(startingAt) } },
  }, { now, lane, client: { async searchPage({ query, cursor }) {
    units = PAGE_RESERVE;
    const page = await api.searchPage({ query: query.replace(/^@entropyIO\b/, term), cursor });
    units = Math.max(1, page.tweets.length);
    return page;
  } } });
  const hourly = result.sync.hourly;
  retainCoverage(hourly);
  state.streams[key] = result.sync;
  const incoming = await newRecords(db, control.generation, result.dataset);
  const error = lane === 'latest' ? hourly.lastError : hourly.catchupLastError;
  state.addedPosts += incoming.posts.length;
  return { units, changed: incoming.posts.length, writes: recordWrites(db, control.generation, incoming, args, now),
    report: { status: error ? 'provider-error' : hourly.lastWindow?.status || 'idle', addedPosts: incoming.posts.length,
      ...(error ? { diagnostic: error.diagnosticCode || classifySyncError(error).diagnosticCode } : {}) } };
}

async function refreshMetrics(db, state, api, posts, generation, args, now) {
  const at = iso(now);
  const result = await observePostMetrics(api, posts, at);
  const previous = state.metrics || {};
  state.metrics = { ...previous, nextAttemptAt: iso(now + METRIC_INTERVAL), lastAttemptAt: at,
    lastSuccessAt: result.diagnostic ? previous.lastSuccessAt || null : at,
    batches: (previous.batches || 0) + 1, checkedPosts: (previous.checkedPosts || 0) + result.available,
    changedPosts: (previous.changedPosts || 0) + result.changed,
    lastBatchSize: posts.length, lastBatchChanged: result.changed, lastError: result.diagnostic || null };
  const writes = result.updated.map(post => db.prepare(`UPDATE entropy_records SET payload=?
    WHERE generation=? AND kind='post' AND record_id=? AND chunk_index=0 AND ${held}`)
    .bind(JSON.stringify(post), generation, post.id, ...args));
  if (result.changed) writes.push(db.prepare(`UPDATE entropy_records SET payload=json_set(payload,
    '$.asOf',max(coalesce(json_extract(payload,'$.asOf'),?),?))
    WHERE generation=? AND kind='dataset-meta' AND record_id='main' AND chunk_index=0 AND ${held}`)
    .bind(at, at, generation, ...args));
  return { units: result.units, changed: result.changed, writes, report: {
    status: result.diagnostic ? 'provider-error' : 'metrics-updated', checkedPosts: result.available,
    changedPosts: result.changed, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
  } };
}

export async function collectLeaderboardPage(env, { now = Date.now(), client, recoveryLimit = 0 } = {}) {
  if (!Number.isSafeInteger(recoveryLimit) || recoveryLimit < 0) throw new Error('Invalid recovery request limit.');
  const recovery = recoveryLimit > 0;
  const chooseStep = (state, budget) => recovery ? discoveryStep(state, now, budget, 'catchup', true) : nextStep(state, now, budget);
  const key = env.TWITTERAPI_IO_KEY?.trim();
  const startingAt = Date.parse(env.ENTROPY_SCAN_START_UTC);
  if ((!key && !client) || !Number.isFinite(startingAt) || startingAt >= now) return { status: 'disabled' };
  const db = env.DB, at = iso(now), day = at.slice(0,10);
  let state = await loadState(db);
  let budget = budgetFor(state, at);
  if (budget.units + PAGE_RESERVE > MONTHLY_UNITS) return { status: 'monthly-budget' };
  if (recovery && budget.recoveryAttempts >= recoveryLimit) return { status: 'recovery-budget' };
  if (!chooseStep(state, budget)) return { status: 'idle' };

  const control = await db.prepare("SELECT generation,revision,daily_date,daily_attempts FROM entropy_control WHERE id='main'").first();
  if (!control) return { status: 'uninitialized' };
  const dailyLimit = DAILY_LIMIT + budget.recoveryAttempts + Number(recovery);
  if (control.daily_date === day && control.daily_attempts >= dailyLimit) return { status: 'daily-budget' };
  const token = crypto.randomUUID();
  const claim = await db.prepare(`UPDATE entropy_control SET lease_token=?,lease_until=?
    WHERE id='main' AND generation=? AND revision=? AND (lease_token IS NULL OR lease_until<=?)
      AND (daily_date<>? OR daily_attempts<?)`)
    .bind(token, now + LEASE_MS, control.generation, control.revision, now, day, dailyLimit).run();
  if (claim.meta.changes !== 1) return { status: 'busy' };

  const guardArgs = [control.generation, control.revision, token, now];
  let released = false;
  try {
    state = await loadState(db);
    budget = budgetFor(state, at);
    if (budget.units + PAGE_RESERVE > MONTHLY_UNITS) return { status: 'monthly-budget' };
    if (recovery && budget.recoveryAttempts >= recoveryLimit) return { status: 'recovery-budget' };
    let step = chooseStep(state, budget);
    if (!step) return { status: 'idle' };
    let posts;
    if (step.lane === 'metrics') {
      posts = await selectMetricPosts(db, control.generation, now, step.limit, (state.metrics?.batches ?? 0) % 2 === 0);
      if (!posts.length) {
        state.metrics = { ...state.metrics, nextAttemptAt: iso(now + METRIC_INTERVAL) };
        step = discoveryStep(state, now, budget, 'catchup');
        if (!step) {
          await checkpointWrite(db, state, guardArgs).run();
          return { status: 'idle' };
        }
      }
    }
    const { index, key: stream, lane } = step;
    const metrics = lane === 'metrics';
    const reserved = metrics ? posts.length : PAGE_RESERVE;

    // Reserve the largest expected response before sending a paid request.
    // If an execution is interrupted, the reservation remains charged.
    if (!metrics) state.next = (index + 1) % STREAMS.length;
    state.budget = { ...budget, units: budget.units + reserved,
      metricUnits: budget.metricUnits + (metrics ? reserved : 0),
      dailyMetricUnits: budget.dailyMetricUnits + (metrics ? reserved : 0),
      catchupAttempts: budget.catchupAttempts + Number(lane === 'catchup' && !recovery),
      recoveryAttempts: budget.recoveryAttempts + Number(recovery) };
    state.lastResult = { at, stream, lane, status: 'attempted' };
    const reserve = db.prepare(`UPDATE entropy_control
      SET daily_attempts=CASE WHEN daily_date=? THEN daily_attempts+1 ELSE 1 END,daily_date=? WHERE ${guarded}`)
      .bind(day, day, ...guardArgs);
    const reservation = await db.batch([checkpointWrite(db, state, guardArgs), reserve]);
    if (reservation.some(result => result.meta.changes !== 1)) throw new Error('Could not reserve a collector attempt.');

    const api = client ?? createClient({ apiKey: key, timeoutMs: metrics || recovery ? 35000 : 15000 });
    const result = metrics ? await refreshMetrics(db, state, api, posts, control.generation, guardArgs, now)
      : await scanDiscovery(db, state, step, api, control, guardArgs, now, startingAt);
    state.budget.units = budget.units + result.units;
    if (metrics) {
      state.budget.metricUnits = budget.metricUnits + result.units;
      state.budget.dailyMetricUnits = budget.dailyMetricUnits + result.units;
    }
    state.lastResult = { at, stream, lane, ...result.report };
    const finish = db.prepare(`UPDATE entropy_control SET lease_token=NULL,lease_until=0,
      revision=revision+?,updated_at=CASE WHEN ? > 0 THEN ? ELSE updated_at END WHERE ${guarded}`)
      .bind(Number(result.changed > 0), result.changed, at, ...guardArgs);
    const saved = await db.batch([...result.writes, checkpointWrite(db, state, guardArgs), finish]);
    if (saved.at(-1)?.meta.changes !== 1) throw new Error('The collector could not publish the saved page.');
    released = true;
    return state.lastResult;
  } finally {
    if (!released) await db.prepare("UPDATE entropy_control SET lease_token=NULL,lease_until=0 WHERE id='main' AND lease_token=?")
      .bind(token).run();
  }
}
