import weekOne from './campaigns/week-1.json' with { type: 'json' };
import { CampaignModelError, classifyCampaignPost, identifyCampaign, rubricFrom } from './campaign-model.mjs';
import { campaignDecisionWrite, registerCampaign } from './campaign-store.mjs';

const rubrics = [weekOne].map(rubricFrom);
const BATCH_SIZE = 12;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const CATCH_UP = 7 * DAY;
const LEASE = 4 * MINUTE;
const IDLE_INTERVAL = 15 * MINUTE;
// Matches the partial date index. Its -1 key identifies split JSON payloads.
const indexedDate = "CASE WHEN json_valid(p.payload) THEN julianday(json_extract(p.payload,'$.publishedAt')) ELSE -1 END";
export const configuredCampaigns = () => Promise.all(rubrics.map(identifyCampaign));

export async function pendingCampaignPosts(db, { id, rubricId, rubric }, now, limit) {
  const { results } = await db.prepare(`
    WITH active AS (SELECT generation FROM entropy_control WHERE id='main'),
      indexed AS MATERIALIZED (
        SELECT p.generation,p.record_id AS id,p.payload
        FROM entropy_records p JOIN active USING(generation)
        WHERE p.kind='post' AND p.chunk_index=0
          AND (${indexedDate})>=julianday(?1) AND (${indexedDate})<julianday(?2) AND (${indexedDate})<=julianday(?3)
        UNION ALL
        SELECT p.generation,p.record_id AS id,(
            SELECT group_concat(payload,'') FROM (
              SELECT c.payload FROM entropy_records c WHERE c.generation=p.generation
                AND c.kind='post' AND c.record_id=p.record_id ORDER BY c.chunk_index
            )
          ) AS payload
        FROM entropy_records p JOIN active USING(generation)
        WHERE p.kind='post' AND p.chunk_index=0 AND (${indexedDate})=-1
      ),
      candidates AS MATERIALIZED (
        SELECT generation,id,json_extract(payload,'$.authorId') AS author_id,
          json_extract(payload,'$.publishedAt') AS published_at,json_extract(payload,'$.date') AS post_date,
          CASE WHEN json_type(payload,'$.body')='text' THEN json_extract(payload,'$.body') ELSE '' END AS body
        FROM indexed WHERE json_valid(payload) AND json_type(payload,'$.isReply')='false'
          AND julianday(json_extract(payload,'$.publishedAt'))>=julianday(?1)
          AND julianday(json_extract(payload,'$.publishedAt'))<julianday(?2)
          AND julianday(json_extract(payload,'$.publishedAt'))<=julianday(?3)
      ),
      pending AS MATERIALIZED (
        SELECT p.* FROM candidates p LEFT JOIN entropy_campaign_decisions d
          ON d.week_id=?4 AND d.rubric_id=?5 AND d.post_id=p.id
        WHERE d.post_body IS NOT p.body
      )
    SELECT p.id,p.body FROM pending p
    WHERE NOT EXISTS (
      SELECT 1 FROM entropy_records r
      WHERE r.generation=p.generation AND r.kind='state:bans' AND r.record_id=p.author_id
    ) AND NOT EXISTS (
      SELECT 1 FROM entropy_records r
      WHERE r.generation=p.generation AND r.kind='state:postExclusions' AND r.record_id=p.id
    ) AND NOT EXISTS (
      SELECT 1 FROM entropy_records r
      WHERE r.generation=p.generation AND r.kind='state:periodDecisions'
        AND r.record_id=substr(p.post_date,1,7)||'|'||p.author_id
    )
    ORDER BY p.published_at,p.id LIMIT ?6`
  ).bind(rubric.from, rubric.until, new Date(now).toISOString(), id, rubricId, limit).all();
  return results;
}

function cooldown(error) {
  if ([401, 402, 403].includes(error.status)) return 6 * 60 * MINUTE;
  return Math.max(10 * MINUTE, (error.retryAfter ?? 0) * 1000);
}

export async function collectCampaignDecisions(env, { now = Date.now(), evaluate = classifyCampaignPost, newPosts = false } = {}) {
  const key = env.TYPESAFE_API_KEY?.trim();
  if (!key) return { status: 'disabled' };
  const weeks = (await configuredCampaigns()).filter(({ rubric }) => now >= rubric.start && now < rubric.end + CATCH_UP);
  if (!weeks.length) return { status: 'idle' };
  const db = env.DB;
  const token = crypto.randomUUID();
  const claim = await db.prepare(`UPDATE entropy_campaign_collection SET lease_token=?,lease_until=?
    WHERE id='main' AND lease_until<=? AND (next_attempt_at<=? OR (?=1 AND last_status='idle'))`)
    .bind(token, now + LEASE, now, now, Number(newPosts)).run();
  if (!claim.meta.changes) return { status: 'deferred' };

  let released = false;
  let error;
  try {
    const writes = [];
    for (const week of weeks) {
      await registerCampaign(db, week).run();
      const posts = await pendingCampaignPosts(db, week, now, BATCH_SIZE - writes.length);
      for (const post of posts) {
        try {
          const decision = await evaluate(post, week.rubric, key);
          writes.push(campaignDecisionWrite(db, week, post, decision));
        } catch (failure) {
          error = failure instanceof CampaignModelError ? failure : new CampaignModelError();
          break;
        }
      }
      if (error || writes.length >= BATCH_SIZE) break;
    }
    const finish = db.prepare(`UPDATE entropy_campaign_collection SET lease_token=NULL,lease_until=0,next_attempt_at=?,
      last_status=?,last_attempt_at=? WHERE id='main' AND lease_token=?`)
      .bind(error ? now + cooldown(error) : writes.length ? 0 : now + IDLE_INTERVAL,
        error ? `provider-error-${error.status}` : writes.length ? 'classified' : 'idle', now, token);
    const result = await db.batch([...writes, finish]);
    released = true;
    const saved = result.slice(0,-1).reduce((sum, row) => sum + row.meta.changes, 0);
    return error ? { status: 'provider-error', providerStatus: error.status, saved }
      : { status: saved ? 'classified' : 'idle', saved };
  } finally {
    if (!released) await db.prepare(`UPDATE entropy_campaign_collection SET lease_token=NULL,lease_until=0
      WHERE id='main' AND lease_token=?`).bind(token).run();
  }
}
