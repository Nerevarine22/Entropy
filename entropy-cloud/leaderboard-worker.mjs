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

export function publicDataset(records) {
  const authors = new Map();
  const posts = [];
  const bans = new Set();
  const periodExclusions = new Set();
  const postExclusions = new Set();
  let asOf = null;
  const entities = [];
  for (const record of records) {
    const last = entities.at(-1);
    if (last?.kind === record.kind && last.id === record.record_id) {
      if (record.chunk_index !== last.chunks.length) throw new Error('Incomplete record.');
      last.chunks.push(record.payload);
    } else {
      if (record.chunk_index !== 0) throw new Error('Incomplete record.');
      entities.push({ kind: record.kind, id: record.record_id, chunks: [record.payload] });
    }
  }

  for (const { kind, id, chunks } of entities) {
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
  const visiblePosts = posts.filter(post => authors.has(post.authorId) && !bans.has(post.authorId)
    && !postExclusions.has(post.id) && !periodExclusions.has(post.date.slice(0, 7) + '|' + post.authorId));
  const visibleAuthors = new Set(visiblePosts.map(post => post.authorId));
  return { meta: { asOf }, authors: [...authors.values()].filter(author => visibleAuthors.has(author.id)), posts: visiblePosts };
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/api/leaderboard') return new Response('Not Found', { status: 404 });
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } });
    try {
      // Only the published generation is visible, and moderation payloads are private.
      const { results } = await env.DB.prepare(`
        SELECT kind, record_id, chunk_index,
          CASE WHEN kind LIKE 'state:%' THEN NULL ELSE payload END AS payload
        FROM entropy_records
        WHERE generation = (SELECT generation FROM entropy_control WHERE id = 'main')
          AND kind IN ('dataset-meta', 'author', 'post', 'state:bans', 'state:periodDecisions', 'state:postExclusions')
        ORDER BY kind, record_id, chunk_index
      `).all();
      if (!results.length) throw new Error('Missing published generation.');
      return Response.json(publicDataset(results), {
        headers: { 'Cache-Control': 'public, max-age=30, s-maxage=60', 'X-Content-Type-Options': 'nosniff' },
      });
    } catch {
      return Response.json({ error: 'Leaderboard temporarily unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
