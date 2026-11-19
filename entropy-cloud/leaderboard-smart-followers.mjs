import { fetchSmartFollowers, SMART_FOLLOWER_INTERVAL, TwitterScoreError } from '../entropy-app/twitter-score.mjs';

const BATCH_SIZE = 10;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const writable = "id='main' AND generation=? AND (lease_token IS NULL OR lease_until<=?)";
const scoreCount = "json_extract(author.payload,'$.twitterScore.smartFollowers')";
const scoreDate = "json_extract(author.payload,'$.twitterScore.checkedAt')";
const singleAuthor = `author.kind='author' AND author.chunk_index=0 AND json_valid(author.payload)
  AND NOT EXISTS (SELECT 1 FROM entropy_records AS chunk
    WHERE chunk.generation=author.generation AND chunk.kind='author'
      AND chunk.record_id=author.record_id AND chunk.chunk_index=1)`;

const observations = `WITH observed AS (
  SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.count') AS count,
    json_extract(value,'$.checkedAt') AS checked_at FROM json_each(?)
), candidates AS (
  SELECT author.record_id AS id, observed.count, observed.checked_at, ${scoreCount} AS previous_count
  FROM entropy_records AS author JOIN observed ON author.record_id=observed.id
  WHERE author.generation=(SELECT generation FROM entropy_control WHERE ${writable})
    AND ${singleAuthor} AND coalesce(${scoreDate},'') < observed.checked_at
)`;

export function smartFollowerWrites(results, generation, now) {
  const args = [JSON.stringify(results), generation, now];
  return [
    [`${observations}
      UPDATE entropy_control SET revision=revision+1 WHERE id='main'
        AND EXISTS (SELECT 1 FROM candidates WHERE count IS NOT NULL AND count IS NOT previous_count)`, args],
    [`${observations}
      UPDATE entropy_records SET payload=json_set(payload,
        '$.twitterScore.smartFollowers',coalesce(candidates.count,candidates.previous_count),
        '$.twitterScore.checkedAt',candidates.checked_at,
        '$.twitterScore.status',CASE WHEN candidates.count IS NULL THEN 'unavailable' ELSE 'observed' END)
      FROM candidates WHERE generation=? AND kind='author' AND chunk_index=0 AND record_id=candidates.id`, [...args, generation]],
  ];
}

function retryDelay(error) {
  if (error.code === 'rate_limited') return Math.max(MINUTE, (error.retryAfterSeconds ?? 0) * 1000);
  if (error.code === 'quota_exceeded') return DAY;
  if (/^api_|^http_40[13]$/.test(error.code)) return 6 * HOUR;
  return 15 * MINUTE;
}

export async function collectSmartFollowers(env, { now = Date.now(), lookup = fetchSmartFollowers } = {}) {
  const key = env.TWITTERSCORE_API_KEY?.trim();
  if (!key) return { status: 'disabled' };
  const db = env.DB;
  const control = await db.prepare(`SELECT generation,lease_token,lease_until,
    (SELECT json_extract(payload,'$.smartFollowers.nextAttemptAt') FROM entropy_leaderboard_ingestion
      WHERE id='main') AS retry_at FROM entropy_control WHERE id='main'`).first();
  if (!control) return { status: 'uninitialized' };
  if (control.lease_token && control.lease_until > now) return { status: 'busy' };
  if (control.retry_at > now) return { status: 'deferred' };

  // Discovery inserts authors directly into D1. Unchecked authors are due on
  // this tick; the rest become due a week after their latest completed check.
  const { results: authors } = await db.prepare(`SELECT author.record_id AS id FROM entropy_records AS author
    WHERE author.generation=? AND ${singleAuthor}
      AND author.record_id GLOB '[1-9]*' AND author.record_id NOT GLOB '*[^0-9]*'
      AND coalesce(${scoreDate},'')<=?
    ORDER BY coalesce(${scoreDate},''),author.created_at DESC,author.record_id LIMIT ?`)
    .bind(control.generation, new Date(now - SMART_FOLLOWER_INTERVAL).toISOString(), BATCH_SIZE).all();
  if (!authors.length) return { status: 'idle' };

  const results = [];
  let error;
  const checkedAt = new Date(now).toISOString();
  for (const { id } of authors) {
    try {
      results.push({ id, count: await lookup(id, key), checkedAt });
    } catch (failure) {
      error = failure instanceof TwitterScoreError ? failure : new TwitterScoreError('network_error');
      break;
    }
  }

  const writes = results.length ? smartFollowerWrites(results, control.generation, now) : [];
  if (error) {
    const cooldown = { nextAttemptAt: now + retryDelay(error), diagnostic: error.code };
    writes.push([`INSERT INTO entropy_leaderboard_ingestion (id,payload)
      SELECT 'main',? WHERE EXISTS (SELECT 1 FROM entropy_control WHERE ${writable})
      ON CONFLICT(id) DO UPDATE SET payload=json_set(
        entropy_leaderboard_ingestion.payload,'$.smartFollowers',json_extract(excluded.payload,'$.smartFollowers'))`,
      [JSON.stringify({ version: 1, next: 0, streams: {}, addedPosts: 0, smartFollowers: cooldown }), control.generation, now]]);
  }
  const saved = await db.batch(writes.map(([query, args]) => db.prepare(query).bind(...args)));
  return {
    status: error ? 'provider-error' : 'checked',
    ...(error ? { diagnostic: error.code } : {}),
    checked: results.length ? saved[1].meta.changes : 0,
  };
}
