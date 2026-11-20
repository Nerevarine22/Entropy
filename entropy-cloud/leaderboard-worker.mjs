import { creatorSummary, EARLY_CREATOR_PERIOD, POST_PAGE_SIZE, postScore, rankPage, requestedPage, summarize, summarizeActivity } from './leaderboard-view.mjs';
import { handleAdmin } from './admin-worker.mjs';
import { collectLeaderboardPage } from './leaderboard-ingestion.mjs';
import { collectSmartFollowers } from './leaderboard-smart-followers.mjs';
import { currentControl, ModerationError, rankingReviews, storedRecords } from './moderation-store.mjs';
import { campaignEntries, campaignReviewPage, selectCampaign } from './campaign-store.mjs';
import { collectCampaignDecisions, configuredCampaigns } from './campaign-ingestion.mjs';
import { hasStatsServiceAccess, overallKey, personalRank, recentRanks, storeDailyRanks } from './leaderboard-stats.mjs';

const METRICS = ['impressions', 'likes', 'reposts', 'quotes', 'replies'];
const xId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function avatarUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === 'https://pbs.twimg.com' && !url.username && !url.password
        && /^\/profile_images\//.test(url.pathname)) return url.origin + url.pathname;
  } catch { /* A missing avatar is optional. */ }
  return null;
}

export function publicDataset(records, includeExcluded = false) {
  const authors = new Map();
  const posts = [];
  const bans = new Set();
  const periodExclusions = new Set();
  const postExclusions = new Set();
  let asOf = null;
  for (const { kind, id, chunks } of storedRecords(records)) {
    if (kind === 'state:bans') { bans.add(id); continue; }
    if (kind === 'state:periodDecisions') { periodExclusions.add(id); continue; }
    if (kind === 'state:postExclusions') { postExclusions.add(id); continue; }
    const value = JSON.parse(chunks.join(''));
    if (kind === 'dataset-meta' && typeof value.asOf === 'string' && Number.isFinite(Date.parse(value.asOf))) {
      asOf = new Date(value.asOf).toISOString();
    }
    if (kind === 'author' && value.id === id && xId(id) && typeof value.handle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(value.handle)) {
      authors.set(id, {
        id, handle: value.handle,
        displayName: typeof value.displayName === 'string' ? value.displayName : value.handle,
        avatarUrl: avatarUrl(value.avatarUrl),
        ...(includeExcluded ? { followers: count(value.followers) } : {}),
        twitterScore: { smartFollowers: count(value.twitterScore?.smartFollowers) },
      });
    }
    if (kind === 'post' && value.id === id && xId(id) && value.isReply === false && typeof value.date === 'string') {
      posts.push({
        id, authorId: value.authorId, date: value.date, isReply: false,
        publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : null,
        url: 'https://x.com/i/web/status/' + id,
        body: typeof value.body === 'string' ? value.body : null,
        metrics: Object.fromEntries(METRICS.map(key => [key, count(value.metrics?.[key])])),
      });
    }
  }
  const excluded = post => bans.has(post.authorId) || postExclusions.has(post.id)
    || periodExclusions.has(post.date.slice(0, 7) + '|' + post.authorId);
  if (includeExcluded) {
    return { meta: { asOf }, authors: [...authors.values()], posts: posts.filter(post => authors.has(post.authorId))
      .map(post => ({ ...post, excluded: excluded(post) })) };
  }
  const visiblePosts = posts.filter(post => authors.has(post.authorId) && !excluded(post));
  const visibleAuthors = new Set(visiblePosts.map(post => post.authorId));
  return { meta: { asOf }, authors: [...authors.values()].filter(author => visibleAuthors.has(author.id)), posts: visiblePosts };
}

const publicHeaders = { 'Cache-Control': 'public, max-age=0, must-revalidate', 'X-Content-Type-Options': 'nosniff' };
const privateHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const CACHE_SECONDS = 900;
const CACHE_NAMESPACE = '/__entropy_cache/v5';
const ACTIVITY_REFRESH_MS = 6 * 60 * 60 * 1000;
const ACTIVITY_SNAPSHOT_VERSION = 4;
const cacheFills = new Map();

async function cached(cache, key, build) {
  if (!cache) return build();
  try {
    const hit = await cache.match(key);
    if (hit) return await hit.json();
  } catch { /* The public API can read D1 if the cache is unavailable. */ }

  if (!cacheFills.has(key)) {
    const work = (async () => {
      const data = await build();
      try {
        await cache.put(key, Response.json(data, { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } }));
      } catch { /* Cache failures do not fail the request. */ }
      return data;
    })().finally(() => cacheFills.delete(key));
    cacheFills.set(key, work);
  }
  return cacheFills.get(key);
}

async function readDataset(db, includeText, generation, includeExcluded = false, week) {
  const campaignFilter = week ? `AND (kind<>'post' OR EXISTS (
    SELECT 1 FROM entropy_campaign_decisions WHERE week_id=? AND rubric_id=? AND post_id=entropy_records.record_id
  ))` : '';
  const { results } = await db.prepare(`
    SELECT kind, record_id, chunk_index,
      CASE WHEN kind LIKE 'state:%' THEN NULL
        WHEN ? = 0 AND kind = 'post' AND chunk_index = 0 AND json_valid(payload) THEN json_remove(payload,'$.body','$.summary')
        ELSE payload END AS payload
    FROM entropy_records
    WHERE generation = ?
      AND kind IN ('dataset-meta', 'author', 'post', 'state:bans', 'state:periodDecisions', 'state:postExclusions')
      ${campaignFilter}
    ORDER BY kind, record_id, chunk_index
  `).bind(includeText ? 1 : 0, generation, ...(week ? [week.id, week.rubricId] : [])).all();
  if (!results.length) throw new Error('Missing published generation.');
  return publicDataset(results, includeExcluded);
}

export async function readCampaignSource(db) {
  const control = await currentControl(db);
  return readDataset(db, true, control.generation, true);
}

function activityCampaignDates(registered, configured, through) {
  const weeks = new Map(configured.map(({ id, rubric, announcedOn }) => [id, {
    label: rubric.week, topic: rubric.topic, startsAt: new Date(rubric.start).toISOString(), announcedOn,
  }]));
  for (const { id, label, topic, startsAt } of registered) {
    const existing = weeks.get(id);
    weeks.set(id, { label, topic, startsAt, announcedOn: existing?.startsAt === startsAt ? existing.announcedOn : null });
  }
  return [...weeks.values()].flatMap(({ label, topic, startsAt, announcedOn }) => {
    const startDate = startsAt.slice(0, 10);
    const event = { label, topic };
    if (announcedOn === startDate) return [{ ...event, date: startDate, type: 'announcement-and-start' }];
    const start = { ...event, date: startDate, type: 'start' };
    return announcedOn ? [{ ...event, date: announcedOn, type: 'announcement' }, start] : [start];
  }).filter(({ date }) => date <= through).sort((a, b) => a.date.localeCompare(b.date));
}

export async function refreshActivitySnapshot({ DB: db }, now = Date.now()) {
  const previous = await db.prepare(`SELECT refreshed_at, json_extract(payload,'$.version') AS version
    FROM entropy_activity_snapshot WHERE id='main'`).first();
  if (previous?.version >= ACTIVITY_SNAPSHOT_VERSION && now - previous.refreshed_at < ACTIVITY_REFRESH_MS) return false;
  const { generation, revision } = await currentControl(db);
  const [dataset, { view: { weeks } }, configured] = await Promise.all([
    readDataset(db, false, generation), selectCampaign(db, null), configuredCampaigns(),
  ]);
  const refreshedAt = new Date(now).toISOString();
  const through = refreshedAt.slice(0, 10);
  const campaigns = activityCampaignDates(weeks, configured, through);
  const payload = JSON.stringify({ version: ACTIVITY_SNAPSHOT_VERSION,
    ...summarizeActivity(dataset.posts, through), campaigns, through, refreshedAt });
  const result = await db.prepare(`INSERT INTO entropy_activity_snapshot (id,refreshed_at,payload)
    SELECT 'main',?,? WHERE EXISTS (SELECT 1 FROM entropy_control WHERE id='main' AND generation=? AND revision=?)
    ON CONFLICT(id) DO UPDATE SET refreshed_at=excluded.refreshed_at,payload=excluded.payload
    WHERE excluded.refreshed_at >= entropy_activity_snapshot.refreshed_at
      AND (COALESCE(json_extract(entropy_activity_snapshot.payload,'$.version'), 0) < ?
        OR excluded.refreshed_at - entropy_activity_snapshot.refreshed_at >= ?)`)
    .bind(now, payload, generation, revision, ACTIVITY_SNAPSHOT_VERSION, ACTIVITY_REFRESH_MS).run();
  return result.meta.changes === 1;
}

async function rankingSnapshot(env, url, control) {
  const cache = env.previewCache ?? globalThis.caches?.default;
  const { start, endExclusive } = EARLY_CREATOR_PERIOD;
  const key = `${url.origin}${CACHE_NAMESPACE}/${control.generation}/${control.revision}/ranking/${start}/${endExclusive}`;
  return cached(cache, key, async () => {
    const [dataset, reviews] = await Promise.all([
      readDataset(env.DB, false, control.generation, true), rankingReviews(env.DB, control.generation),
    ]);
    const snapshot = summarize({ ...dataset, posts: dataset.posts.filter(post => !post.excluded) });
    const counts = new Map();
    for (const post of dataset.posts) counts.set(post.authorId, (counts.get(post.authorId) || 0) + 1);
    snapshot.rows = snapshot.rows.map(row => ({ ...row, reviewedAt: reviews.get(row.author.id)?.status === 'reviewed'
      ? reviews.get(row.author.id).reviewedAt : null }));
    const ranked = new Set(snapshot.rows.map(row => row.author.id));
    const excludedCreators = dataset.authors.filter(author => counts.has(author.id) && !ranked.has(author.id))
      .sort((a,b) => a.handle.localeCompare(b.handle)).map(author => ({
        author, rank: null, postCount: 0, score: null, views: 0, likes: 0, engagement: null, early: false,
      }));
    const adminRows = [...snapshot.rows, ...excludedCreators].map(row => ({ ...row,
      totalPosts: counts.get(row.author.id), review: reviews.get(row.author.id) ?? { status: 'unreviewed' },
    }));
    return { ...snapshot, adminRows };
  });
}

const searchQuery = url => (url.searchParams.get('q') || '').trim().replace(/^@/, '').toLowerCase().slice(0, 80);

async function adminRanking(env, url) {
  const snapshot = await rankingSnapshot(env, url, await currentControl(env.DB));
  const status = url.searchParams.get('status');
  const rows = ['reviewed', 'needs-review', 'unreviewed'].includes(status)
    ? snapshot.adminRows.filter(row => row.review.status === status) : snapshot.adminRows;
  return rankPage({ ...snapshot, rows }, requestedPage(url.searchParams.get('page')), searchQuery(url));
}

async function loadCampaign(env, url, includeReview = false) {
  const db = env.DB;
  const { week, view } = await selectCampaign(db, url.searchParams.get('week'));
  if (!week) return { view, authors: [], entries: [], posts: [],
    snapshot: summarize({ meta: { asOf: null }, authors: [], posts: [] }) };
  return { view, ...await campaignSnapshot(env, url, await currentControl(db), week, includeReview) };
}

async function campaignSnapshot(env, url, control, week, includeReview = false) {
  const db = env.DB;
  const scope = includeReview ? 'review' : 'public';
  const cache = env.previewCache ?? globalThis.caches?.default;
  const key = `${url.origin}${CACHE_NAMESPACE}/campaign/${control.generation}/${control.revision}/${week.id}/${week.rubricId}/${week.revision}/${scope}`;
  return cached(cache, key, async () => {
    const dataset = await readDataset(db, true, control.generation, true, week);
    const entries = await campaignEntries(db, week, dataset.posts);
    if (includeReview) return { authors: dataset.authors, entries };
    const posts = entries.filter(entry => entry.status === 'match').map(({ post: { excluded, ...post } }) => post);
    return { posts, snapshot: summarize({ ...dataset, posts }) };
  });
}

async function adminCampaign(env, url) {
  const { view, authors, entries } = await loadCampaign(env, url, true);
  return { ...view, ...campaignReviewPage(entries, authors, url) };
}

async function publicCampaign(env, url, profile) {
  const { view, posts, snapshot } = await loadCampaign(env, url);
  const page = requestedPage(url.searchParams.get('page'));
  if (!profile) return Response.json({ ...view, ...rankPage(snapshot, page, searchQuery(url)) }, { headers: privateHeaders });
  const id = url.searchParams.get('creator');
  const row = snapshot.rows.find(creator => creator.author.id === id);
  const totalPages = row ? Math.ceil(row.postCount / POST_PAGE_SIZE) : 0;
  if (!row || page > totalPages) return Response.json({ error: 'Profile not found.' }, { status: 404, headers: privateHeaders });
  const offset = (page - 1) * POST_PAGE_SIZE;
  const byId = new Map(posts.map(post => [post.id, post]));
  return Response.json({ ...creatorSummary(row), posts: row.postIds.slice(offset, offset + POST_PAGE_SIZE).map(id => byId.get(id)),
    offset, page, totalPages }, { headers: privateHeaders });
}

async function readProfilePage(db, id, postIds) {
  // The snapshot provides the IDs, so opening a profile performs indexed lookups.
  const values = postIds.map(() => '(?)').join(',');
  const { results } = await db.prepare(`
    WITH active AS (SELECT generation FROM entropy_control WHERE id = 'main'),
      wanted(id) AS (VALUES ${values}),
      creator(id) AS (VALUES (?))
    SELECT kind, record_id, chunk_index, payload FROM entropy_records JOIN active USING(generation)
      WHERE kind = 'author' AND record_id = (SELECT id FROM creator)
    UNION ALL
    SELECT kind, record_id, chunk_index, payload FROM entropy_records JOIN active USING(generation)
      WHERE kind = 'post' AND record_id IN (SELECT id FROM wanted)
    UNION ALL
    SELECT kind, record_id, chunk_index, NULL FROM entropy_records JOIN active USING(generation)
      WHERE kind = 'state:bans' AND record_id = (SELECT id FROM creator)
    UNION ALL
    SELECT kind, record_id, chunk_index, NULL FROM entropy_records JOIN active USING(generation)
      WHERE kind = 'state:postExclusions' AND record_id IN (SELECT id FROM wanted)
    UNION ALL
    SELECT kind, record_id, chunk_index, NULL FROM entropy_records JOIN active USING(generation)
      WHERE kind = 'state:periodDecisions' AND substr(record_id, 9) = (SELECT id FROM creator)
    ORDER BY kind, record_id, chunk_index
  `).bind(...postIds, id).all();
  const dataset = publicDataset(results);
  const byId = new Map(dataset.posts.map(post => [post.id, post]));
  const visible = results.some(record => record.kind === 'author') && !results.some(record => record.kind === 'state:bans');
  return { posts: postIds.map(key => byId.get(key)).filter(Boolean), visible };
}

async function loadStatsWeeks(env, url, control) {
  const { weeks: registered } = await selectCampaign(env.DB, null);
  const weeks = [];
  for (const week of registered) {
    const { snapshot } = await campaignSnapshot(env, url, control, week);
    weeks.push({ id: week.id, label: week.label, historyKey: `${week.id}/${week.rubricId}`, snapshot });
  }
  return weeks;
}

async function readTopPost(db, id, topPost) {
  if (!topPost) return null;
  const { posts, visible } = await readProfilePage(db, id, [topPost.id]);
  const post = posts[0];
  return visible && post?.authorId === id ? { ...post, score: topPost.score } : null;
}

export function captureDailyRanks(env, url, now = Date.now()) {
  return storeDailyRanks(env.DB, async () => {
    const control = await currentControl(env.DB);
    const [overall, weeks] = await Promise.all([rankingSnapshot(env, url, control), loadStatsWeeks(env, url, control)]);
    return { overall, weeks };
  }, now);
}

async function creatorStats(env, url, control, id, row, smartFollowers, now) {
  const [weeks, { previous, history }, topPost] = await Promise.all([
    loadStatsWeeks(env, url, control), recentRanks(env.DB, id, now, row?.rank), readTopPost(env.DB, id, row?.topPost),
  ]);
  return {
    overall: { ...personalRank(row, previous.get(overallKey)), views: row?.views ?? null,
      score: row?.score ?? null, early: row?.early ?? false },
    weeks: weeks.map(week => ({ id: week.id, label: week.label,
      ...personalRank(week.snapshot.rows.find(({ author }) => author.id === id), previous.get(week.historyKey)) })),
    smartFollowers,
    rankHistory: history,
    topPost,
  };
}

export async function readMyStats(env, url, id, now = Date.now()) {
  const control = await currentControl(env.DB);
  const overall = await rankingSnapshot(env, url, control);
  const row = overall.rows.find(({ author }) => author.id === id);
  const indexed = row ?? overall.adminRows.find(({ author }) => author.id === id);
  return creatorStats(env, url, control, id, row, indexed?.author.twitterScore?.smartFollowers ?? null, now);
}

async function publicCreatorStats(env, url) {
  const handle = searchQuery(url);
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) {
    return Response.json({ error: 'Enter a valid X username.' }, { status: 400, headers: privateHeaders });
  }
  const control = await currentControl(env.DB);
  const snapshot = await rankingSnapshot(env, url, control);
  const row = snapshot.rows.find(({ author }) => author.handle.toLowerCase() === handle);
  if (!row) return Response.json({ error: 'No creator found.' }, { status: 404, headers: privateHeaders });
  const { id, handle: username, displayName, avatarUrl, twitterScore } = row.author;
  const stats = await creatorStats(env, url, control, id, row, twitterScore?.smartFollowers ?? null, Date.now());
  return Response.json({ account: { id, handle: username, displayName, avatarUrl }, stats }, { headers: privateHeaders });
}

export default {
  async scheduled(_controller, env) {
    let newPosts = false;
    try {
      const result = await collectLeaderboardPage(env);
      newPosts = result.addedPosts > 0;
      if (result.status !== 'idle') console.log('Leaderboard ingestion', result);
    } finally {
      const jobs = await Promise.allSettled([collectSmartFollowers(env), collectCampaignDecisions(env, { newPosts })]);
      const names = ['Smart Followers collection', 'Campaign collection'];
      jobs.forEach((job, index) => {
        if (job.status === 'rejected') console.error(names[index], 'failed');
        else if (['checked', 'classified', 'provider-error'].includes(job.value.status)) console.log(names[index], job.value);
      });
      try {
        if (await captureDailyRanks(env, new URL('https://entropy-rank-snapshots.internal'))) console.log('Saved daily leaderboard ranks');
      } catch { console.error('Could not save daily leaderboard ranks'); }
      try {
        if (await refreshActivitySnapshot(env)) console.log('Saved posting activity snapshot');
      } catch { console.error('Could not save posting activity snapshot'); }
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/internal/my-stats') {
      if (!hasStatsServiceAccess(request, env.X_STATS_SERVICE_KEY)) {
        return Response.json({ error: 'Unauthorized.' }, { status: 401, headers: privateHeaders });
      }
      const id = url.searchParams.get('creator');
      if (request.method !== 'GET' || !xId(id) || id.length > 24) {
        return Response.json({ error: 'Invalid My Stats request.' }, { status: 400, headers: privateHeaders });
      }
      try { return Response.json(await readMyStats(env, url, id), { headers: privateHeaders }); }
      catch { return Response.json({ error: 'My Stats is temporarily unavailable.' }, { status: 503, headers: privateHeaders }); }
    }
    if (url.pathname === '/api/admin') return handleAdmin(request, env, target => adminRanking(env, target), target => adminCampaign(env, target));
    if (url.pathname !== '/api/leaderboard') return new Response('Not Found', { status: 404 });
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } });
    try {
      const view = url.searchParams.get('view');
      if (view === 'stats') return await publicCreatorStats(env, url);
      if (view === 'activity') {
        const snapshot = await env.DB.prepare("SELECT payload FROM entropy_activity_snapshot WHERE id='main'").first();
        return snapshot ? Response.json(JSON.parse(snapshot.payload), { headers: publicHeaders })
          : Response.json({ days: [], through: null, refreshedAt: null }, { headers: privateHeaders });
      }
      if (view === 'campaign' || (view === 'profile' && url.searchParams.has('week'))) {
        return await publicCampaign(env, url, view === 'profile');
      }
      const cache = env.previewCache ?? globalThis.caches?.default;
      const control = await currentControl(env.DB);
      const cacheKey = `${url.origin}${CACHE_NAMESPACE}/${control.generation}/${control.revision}/`;
      // Existing production clients still consume the legacy response during rollout.
      if (view === null) {
        const dataset = await cached(cache, cacheKey + 'legacy', () => readDataset(env.DB, true, control.generation));
        return Response.json(dataset, { headers: publicHeaders });
      }
      const id = url.searchParams.get('creator');
      const otherPosts = view === 'posts';
      if (view !== 'ranking' && (!(view === 'profile' || otherPosts) || !xId(id) || id.length > 24)) {
        return Response.json({ error: 'Invalid leaderboard request.' }, { status: 400, headers: privateHeaders });
      }
      const snapshot = await rankingSnapshot(env, url, control);
      const page = requestedPage(url.searchParams.get('page'));
      if (view === 'ranking') {
        const search = searchQuery(url);
        return Response.json(rankPage(snapshot, page, search), { headers: search ? privateHeaders : publicHeaders });
      }

      const row = snapshot.rows.find(creator => creator.author.id === id);
      const ids = otherPosts ? row?.postIds.filter(postId => postId !== row.topPost?.id) : row?.postIds;
      const totalPages = ids ? Math.ceil(ids.length / POST_PAGE_SIZE) : 0;
      if (otherPosts && row && totalPages === 0 && page === 1) {
        return Response.json({ posts: [], page, totalPages }, { headers: publicHeaders });
      }
      if (!row || page > totalPages) {
        return Response.json({ error: 'Profile not found.' }, { status: 404, headers: privateHeaders });
      }
      const offset = (page - 1) * POST_PAGE_SIZE;
      const postIds = ids.slice(offset, offset + POST_PAGE_SIZE);
      const payload = await cached(cache, cacheKey + `${view}/${snapshot.version}/${id}/${page}`,
        () => readProfilePage(env.DB, id, postIds));
      if (!payload.visible) return Response.json({ error: 'Profile not found.' }, { status: 404, headers: privateHeaders });
      if (otherPosts) {
        const posts = payload.posts.map(post => ({ ...post, score: postScore(row.author, post.metrics) }));
        return Response.json({ posts, page, totalPages }, { headers: publicHeaders });
      }
      return Response.json({ ...creatorSummary(row), posts: payload.posts, offset, page, totalPages }, { headers: publicHeaders });
    } catch (error) {
      if (error instanceof ModerationError) return Response.json({ error: error.message }, { status: error.status, headers: privateHeaders });
      return Response.json({ error: 'Leaderboard temporarily unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
