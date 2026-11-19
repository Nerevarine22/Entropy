import { creatorSummary, EARLY_CREATOR_PERIOD, POST_PAGE_SIZE, rankPage, requestedPage, summarize } from './leaderboard-view.mjs';
import { handleAdmin } from './admin-worker.mjs';
import { collectLeaderboardPage } from './leaderboard-ingestion.mjs';
import { currentControl, rankingReviews, storedRecords } from './moderation-store.mjs';

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

async function readDataset(db, includeText, generation, includeExcluded = false) {
  const { results } = await db.prepare(`
    SELECT kind, record_id, chunk_index,
      CASE WHEN kind LIKE 'state:%' THEN NULL
        WHEN ? = 0 AND kind = 'post' AND chunk_index = 0 AND json_valid(payload) THEN json_remove(payload,'$.body','$.summary')
        ELSE payload END AS payload
    FROM entropy_records
    WHERE generation = ?
      AND kind IN ('dataset-meta', 'author', 'post', 'state:bans', 'state:periodDecisions', 'state:postExclusions')
    ORDER BY kind, record_id, chunk_index
  `).bind(includeText ? 1 : 0, generation).all();
  if (!results.length) throw new Error('Missing published generation.');
  return publicDataset(results, includeExcluded);
}

async function rankingSnapshot(env, url, control) {
  const cache = env.previewCache ?? globalThis.caches?.default;
  const { start, endExclusive } = EARLY_CREATOR_PERIOD;
  const key = `${url.origin}/__entropy_cache/v3/${control.generation}/${control.revision}/ranking/${start}/${endExclusive}`;
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
        author, rank: null, postCount: 0, views: 0, likes: 0, engagement: null, early: false,
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
  const page = rankPage({ ...snapshot, rows }, requestedPage(url.searchParams.get('page')), searchQuery(url));
  return { ...page, leaders: snapshot.rows.filter(row => row.views > 0).slice(0, 20).map(creatorSummary) };
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

export default {
  async scheduled(_controller, env) {
    const result = await collectLeaderboardPage(env);
    if (result.status !== 'idle') console.log('Leaderboard ingestion', result);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/admin') return handleAdmin(request, env, target => adminRanking(env, target));
    if (url.pathname !== '/api/leaderboard') return new Response('Not Found', { status: 404 });
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } });
    try {
      const cache = env.previewCache ?? globalThis.caches?.default;
      const control = await currentControl(env.DB);
      const cacheKey = `${url.origin}/__entropy_cache/v3/${control.generation}/${control.revision}/`;
      const view = url.searchParams.get('view');
      // Existing production clients still consume the legacy response during rollout.
      if (view === null) {
        const dataset = await cached(cache, cacheKey + 'legacy', () => readDataset(env.DB, true, control.generation));
        return Response.json(dataset, { headers: publicHeaders });
      }
      const id = url.searchParams.get('creator');
      if (view !== 'ranking' && (view !== 'profile' || !xId(id) || id.length > 24)) {
        return Response.json({ error: 'Invalid leaderboard request.' }, { status: 400, headers: privateHeaders });
      }
      const snapshot = await rankingSnapshot(env, url, control);
      const page = requestedPage(url.searchParams.get('page'));
      if (view === 'ranking') {
        const search = searchQuery(url);
        return Response.json(rankPage(snapshot, page, search), { headers: search ? privateHeaders : publicHeaders });
      }

      const row = snapshot.rows.find(creator => creator.author.id === id);
      const totalPages = row ? Math.ceil(row.postCount / POST_PAGE_SIZE) : 0;
      if (!row || page > totalPages) {
        return Response.json({ error: 'Profile not found.' }, { status: 404, headers: privateHeaders });
      }
      const offset = (page - 1) * POST_PAGE_SIZE;
      const postIds = row.postIds.slice(offset, offset + POST_PAGE_SIZE);
      const payload = await cached(cache, cacheKey + `profile/${snapshot.version}/${id}/${page}`,
        () => readProfilePage(env.DB, id, postIds));
      return payload.visible
        ? Response.json({ ...creatorSummary(row), posts: payload.posts, offset, page, totalPages }, { headers: publicHeaders })
        : Response.json({ error: 'Profile not found.' }, { status: 404, headers: privateHeaders });
    } catch {
      return Response.json({ error: 'Leaderboard temporarily unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
