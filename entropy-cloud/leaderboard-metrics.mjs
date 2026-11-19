import { classifySyncError, mergePost } from '../entropy-app/live-engine.mjs';
import { normalizeTweets } from '../entropy-app/twitterapi.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();

export const METRIC_INTERVAL = HOUR;
export const METRIC_BATCH_SIZE = 20;

export async function selectMetricPosts(db, generation, now, limit, preferOlder) {
  const { results } = await db.prepare(`
    WITH eligible AS (
      SELECT r.record_id, r.payload,
        coalesce(json_extract(r.payload,'$.publishedAt'), json_extract(r.payload,'$.date') || 'T00:00:00.000Z') AS published,
        json_extract(r.payload,'$.leaderboardMetricsCheckedAt') AS refreshed,
        json_extract(r.payload,'$.metricsAsOf') AS observed
      FROM entropy_records r
      WHERE r.generation=?1 AND r.kind='post' AND r.chunk_index=0
        AND json_valid(r.payload) AND json_type(r.payload,'$.isReply')='false'
        AND r.record_id NOT GLOB '*[^0-9]*' AND substr(r.record_id,1,1) BETWEEN '1' AND '9'
        AND NOT EXISTS (SELECT 1 FROM entropy_records d WHERE d.generation=?1
          AND d.kind='state:postExclusions' AND d.record_id=r.record_id)
        AND NOT EXISTS (SELECT 1 FROM entropy_records d WHERE d.generation=?1
          AND d.kind='state:bans' AND d.record_id=json_extract(r.payload,'$.authorId'))
        AND NOT EXISTS (SELECT 1 FROM entropy_records d WHERE d.generation=?1 AND d.kind='state:periodDecisions'
          AND d.record_id=substr(json_extract(r.payload,'$.date'),1,7) || '|' || json_extract(r.payload,'$.authorId'))
    )
    SELECT payload FROM eligible
    WHERE published <= ?2 AND CASE
      WHEN refreshed IS NULL THEN coalesce(observed,published) <= ?2
      WHEN published > ?3 THEN refreshed <= ?4
      WHEN published > ?5 THEN refreshed <= ?6
      ELSE refreshed <= ?7
    END
    ORDER BY CASE WHEN (published <= ?5)=?8 THEN 0 ELSE 1 END,
      coalesce(refreshed,observed,published), record_id
    LIMIT ?9
  `).bind(generation, iso(now - 12 * HOUR), iso(now - 2 * DAY), iso(now - DAY),
    iso(now - 7 * DAY), iso(now - 3 * DAY), iso(now - 30 * DAY), Number(preferOlder), limit).all();
  return results.map(row => JSON.parse(row.payload));
}

export async function observePostMetrics(client, posts, at) {
  let units = posts.length;
  try {
    const result = await client.tweetsByIds(posts.map(post => post.id));
    units = Math.max(1, result.tweets.length + (result.unavailableEntries || 0));
    const observations = normalizeTweets(result.tweets, { observedAt: at }).posts;
    const byId = new Map(observations.filter(post => post.isReply !== true).map(post => [post.id, post]));
    let changed = 0, available = 0;
    const updated = posts.map(previous => {
      const observed = byId.get(previous.id);
      const sameDate = previous.publishedAt ? Date.parse(observed?.publishedAt) === Date.parse(previous.publishedAt)
        : observed?.date === previous.date;
      if (!observed || observed.authorId !== previous.authorId || !sameDate) {
        return { ...previous, leaderboardMetricsCheckedAt: at, lastCheckedAt: at,
          availability: { status: 'unavailable', lastAttemptAt: at, lastSeenAt: previous.availability?.lastSeenAt || previous.metricsAsOf || null } };
      }
      available++;
      // The refresh owns observations only; content and moderation stay intact.
      const updated = mergePost(previous, { authorId: observed.authorId, metrics: observed.metrics,
        metricsAsOf: observed.metricsAsOf }, previous.metricsAsOf, at);
      if (Object.keys(updated.metrics).some(field => updated.metrics[field] !== (previous.metrics[field] ?? null))) changed++;
      return { ...updated, leaderboardMetricsCheckedAt: at };
    });
    return { units, updated, changed, available };
  } catch (error) {
    return { units, updated: [], changed: 0, available: 0, diagnostic: classifySyncError(error).diagnosticCode };
  }
}
