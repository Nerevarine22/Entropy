import { POST_PAGE_SIZE, requestedPage, total } from './leaderboard-view.mjs';

const encoder = new TextEncoder();
const xId = value => typeof value === 'string' && /^[1-9]\d{0,23}$/.test(value);
const postOrder = (a, b) => (b.publishedAt || b.date).localeCompare(a.publishedAt || a.date) || b.id.localeCompare(a.id);

export class ModerationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function currentControl(db) {
  const row = await db.prepare("SELECT generation,revision,lease_token,lease_until FROM entropy_control WHERE id='main'").first();
  if (!row) throw new ModerationError(503, 'No dataset is available.');
  return row;
}

export function storedRecords(rows) {
  const records = [];
  for (const row of rows) {
    const last = records.at(-1);
    if (last?.kind === row.kind && last.id === row.record_id) {
      if (row.chunk_index !== last.chunks.length) throw new Error('Incomplete record.');
      last.chunks.push(row.payload);
    } else {
      if (row.chunk_index !== 0) throw new Error('Incomplete record.');
      records.push({ kind: row.kind, id: row.record_id, chunks: [row.payload] });
    }
  }
  return records;
}

function postFromRecord(record) {
  const post = JSON.parse(record.chunks.join(''));
  return post.id === record.id && xId(post.id) && xId(post.authorId) && post.isReply === false
    && typeof post.date === 'string' ? post : null;
}

async function creatorSnapshot(posts) {
  const content = [...posts].sort((a, b) => a.id.localeCompare(b.id))
    .map(post => [post.id, post.body || post.summary || null]);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(content)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function reviewStatus(review, snapshotId) {
  if (!review) return { status: 'unreviewed' };
  return {
    status: review.snapshot_id === snapshotId ? 'reviewed' : 'needs-review',
    snapshotId: review.snapshot_id, reviewedAt: review.reviewed_at, datasetAsOf: review.dataset_as_of,
  };
}

export async function rankingReviews(db, generation) {
  const { results: reviews } = await db.prepare('SELECT author_id,snapshot_id,dataset_as_of,reviewed_at FROM entropy_creator_reviews').all();
  if (!reviews.length) return new Map();
  const groups = new Map(reviews.map(review => [review.author_id, []]));
  const { results } = await db.prepare(`
    WITH wanted AS (
      SELECT record_id FROM entropy_records
      WHERE generation=?1 AND kind='post' AND chunk_index=0
      AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.authorId') IN
        (SELECT author_id FROM entropy_creator_reviews) ELSE 1 END
    )
    SELECT r.kind,r.record_id,r.chunk_index,r.payload FROM wanted
    JOIN entropy_records r ON r.generation=?1 AND r.kind='post' AND r.record_id=wanted.record_id
    ORDER BY r.record_id,r.chunk_index
  `).bind(generation).all();
  for (const record of storedRecords(results)) {
    const post = postFromRecord(record);
    if (post) groups.get(post.authorId)?.push(post);
  }
  return new Map(await Promise.all(reviews.map(async review => [
    review.author_id, reviewStatus(review, await creatorSnapshot(groups.get(review.author_id))),
  ])));
}

async function profileData(db, id, generation) {
  if (!xId(id)) throw new ModerationError(400, 'Invalid creator ID.');
  const { results } = await db.prepare(`
    WITH wanted AS (
      SELECT record_id FROM entropy_records
      WHERE generation=?1 AND kind='post' AND chunk_index=0
        AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.authorId')=?2 ELSE 1 END
    )
    SELECT kind,record_id,chunk_index,payload FROM entropy_records
    WHERE generation=?1 AND ((kind='author' AND record_id=?2)
      OR (kind='dataset-meta' AND record_id='main')
      OR (kind IN ('post','state:postExclusions') AND record_id IN (SELECT record_id FROM wanted))
      OR (kind='state:bans' AND record_id=?2)
      OR (kind='state:periodDecisions' AND substr(record_id,9)=?2))
    ORDER BY kind,record_id,chunk_index
  `).bind(generation, id).all();
  const posts = [], exclusions = new Map(), periods = new Set();
  let author, datasetAsOf = null, banned = false;
  for (const record of storedRecords(results)) {
    switch (record.kind) {
      case 'author': author = JSON.parse(record.chunks.join('')); break;
      case 'dataset-meta': datasetAsOf = JSON.parse(record.chunks.join('')).asOf ?? null; break;
      case 'state:postExclusions': exclusions.set(record.id, JSON.parse(record.chunks.join(''))); break;
      case 'state:bans': banned = true; break;
      case 'state:periodDecisions': periods.add(record.id.slice(0, 7)); break;
      case 'post': {
        const post = postFromRecord(record);
        if (post?.authorId === id) posts.push(post);
        break;
      }
    }
  }
  if (!author || !posts.length) throw new ModerationError(404, 'Creator not found.');
  return { posts: posts.sort(postOrder), exclusions, periods, banned, datasetAsOf, snapshotId: await creatorSnapshot(posts) };
}

export async function adminProfile(db, id, selectedPage) {
  const { generation } = await currentControl(db);
  const data = await profileData(db, id, generation);
  const { posts, exclusions, periods, banned, snapshotId, datasetAsOf } = data;
  const [review, history] = await Promise.all([
    db.prepare('SELECT snapshot_id,dataset_as_of,reviewed_at,actor_id FROM entropy_creator_reviews WHERE author_id=?').bind(id).first(),
    db.prepare(`
      SELECT action,post_id AS postId,reason,actor_id AS actorId,created_at AS at,snapshot_id AS snapshotId
      FROM entropy_moderation_log WHERE author_id=? ORDER BY created_at DESC,id DESC LIMIT 30
    `).bind(id).all(),
  ]);
  const totalPages = Math.ceil(posts.length / POST_PAGE_SIZE);
  const page = Math.min(requestedPage(selectedPage), totalPages);
  const offset = (page - 1) * POST_PAGE_SIZE;
  const included = posts.filter(post => !banned && !exclusions.has(post.id) && !periods.has(post.date.slice(0, 7)));
  return {
    snapshotId, datasetAsOf, totalPages, page, offset, totalPosts: posts.length,
    totals: { posts: included.length, views: total(included, 'impressions'), likes: total(included, 'likes') },
    review: { ...reviewStatus(review, snapshotId), ...(review ? { actorId: review.actor_id } : {}) },
    history: history.results,
    posts: posts.slice(offset, offset + POST_PAGE_SIZE).map(post => {
      const decision = exclusions.get(post.id);
      return {
        id: post.id, date: post.date, body: post.body || post.summary || null,
        url: 'https://x.com/i/web/status/' + post.id, views: post.metrics.impressions, likes: post.metrics.likes,
        exclusion: decision ? { reason: decision.reason, at: decision.at, actorId: decision.actorUserId || null } : null,
        blockedBy: banned ? 'Creator ban' : periods.has(post.date.slice(0, 7)) ? 'Period exclusion' : null,
      };
    }),
  };
}

export async function moderate(db, input, actorId) {
  const { action, creator, postId, snapshotId } = input;
  if (!['exclude', 'restore', 'review'].includes(action) || !xId(creator)
      || (action !== 'review' && !xId(postId)) || !/^[a-f0-9]{64}$/.test(snapshotId || '')) {
    throw new ModerationError(400, 'Invalid moderation request.');
  }
  const reasonText = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (action === 'exclude' && (reasonText.length < 3 || reasonText.length > 1000)) {
    throw new ModerationError(400, 'Enter a reason between 3 and 1,000 characters.');
  }
  const control = await currentControl(db);
  const now = Date.now(), at = new Date(now).toISOString();
  if (control.lease_token && control.lease_until > now) throw new ModerationError(409, 'The dataset is being updated. Try again in a moment.');
  const data = await profileData(db, creator, control.generation);
  if (snapshotId !== data.snapshotId) throw new ModerationError(409, 'This creator’s posts changed. Reload the profile before saving.');
  const decision = data.exclusions.get(postId);
  if (action !== 'review' && !data.posts.some(post => post.id === postId)) throw new ModerationError(404, 'Post not found for this creator.');
  if (action === 'exclude' && decision) throw new ModerationError(409, 'This post is already excluded.');
  if (action === 'restore' && !decision) throw new ModerationError(409, 'This post is already included.');

  const guard = "id='main' AND generation=? AND revision=? AND (lease_token IS NULL OR lease_until<=?)";
  const args = [control.generation, control.revision, now];
  const exists = 'EXISTS (SELECT 1 FROM entropy_control WHERE ' + guard + ')';
  let change;
  if (action === 'exclude') {
    const payload = JSON.stringify({ authorId: creator, reason: reasonText, at, actorUserId: actorId, snapshotId });
    change = db.prepare(`INSERT INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at)
      SELECT ?, 'state:postExclusions', ?, 0, ?, ? WHERE ${exists}`).bind(control.generation, postId, payload, now, ...args);
  } else if (action === 'restore') {
    change = db.prepare(`DELETE FROM entropy_records WHERE generation=? AND kind='state:postExclusions'
      AND record_id=? AND ${exists}`).bind(control.generation, postId, ...args);
  } else {
    change = db.prepare(`INSERT INTO entropy_creator_reviews (author_id,snapshot_id,dataset_as_of,reviewed_at,actor_id)
      SELECT ?,?,?,?,? WHERE ${exists}
      ON CONFLICT(author_id) DO UPDATE SET snapshot_id=excluded.snapshot_id,dataset_as_of=excluded.dataset_as_of,
        reviewed_at=excluded.reviewed_at,actor_id=excluded.actor_id`)
      .bind(creator, snapshotId, data.datasetAsOf, at, actorId, ...args);
  }
  const reason = action === 'exclude' ? reasonText : action === 'restore' ? decision.reason : null;
  const event = db.prepare(`INSERT INTO entropy_moderation_log (id,author_id,post_id,action,reason,snapshot_id,actor_id,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${exists}`)
    .bind(crypto.randomUUID(), creator, action === 'review' ? null : postId, action, reason, snapshotId, actorId, at, ...args);
  const revision = db.prepare('UPDATE entropy_control SET revision=revision+1,updated_at=? WHERE ' + guard).bind(at, ...args);
  const result = await db.batch([change, event, revision]);
  if (result.at(-1)?.meta.changes !== 1) throw new ModerationError(409, 'The dataset or a moderation decision changed. Reload and try again.');
}
