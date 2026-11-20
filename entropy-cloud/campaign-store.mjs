import { ModerationError } from './moderation-store.mjs';
import { requestedPage } from './leaderboard-view.mjs';

const statusValues = ['match', 'review', 'off_topic'];
const pageSize = 15;
const idPattern = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function registerCampaign(db, { id, rubricId, rubric }) {
  return db.prepare(`INSERT INTO entropy_campaign_weeks (id,label,topic,starts_at,ends_at,rubric_id) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET label=excluded.label,topic=excluded.topic,starts_at=excluded.starts_at,
      ends_at=excluded.ends_at,rubric_id=excluded.rubric_id
    WHERE entropy_campaign_weeks.rubric_id<>excluded.rubric_id`)
    .bind(id, rubric.week, rubric.topic, new Date(rubric.start).toISOString(), new Date(rubric.end).toISOString(), rubricId);
}

function activeBody(postId) {
  return `(
    SELECT CASE WHEN json_valid(payload) THEN
      CASE WHEN json_type(payload,'$.body')='text' THEN json_extract(payload,'$.body') ELSE '' END
    END FROM (
      SELECT group_concat(payload,'') AS payload FROM (
        SELECT p.payload FROM entropy_records p JOIN entropy_control c ON c.id='main' AND c.generation=p.generation
        WHERE p.kind='post' AND p.record_id=${postId} ORDER BY p.chunk_index
      )
    )
  )`;
}

export function campaignDecisionWrite(db, { id, rubricId }, post, decision) {
  return db.prepare(`INSERT INTO entropy_campaign_decisions
    (week_id,rubric_id,post_id,post_body,model_status,model_choice,confidence,model)
    SELECT ?,?,?,?,?,?,?,? WHERE ?=(SELECT rubric_id FROM entropy_campaign_weeks WHERE id=?)
      AND ?=${activeBody('?')}
    ON CONFLICT (week_id,rubric_id,post_id) DO UPDATE SET
      post_body=excluded.post_body,model_status=excluded.model_status,model_choice=excluded.model_choice,
      confidence=excluded.confidence,model=excluded.model,manual_status=NULL,reviewed_at=NULL,reviewed_by=NULL,revision=revision+1
    WHERE entropy_campaign_decisions.post_body<>excluded.post_body`)
    .bind(id, rubricId, post.id, post.body ?? '', decision.status, decision.choice ?? null,
      decision.confidence ?? null, decision.model ?? null, rubricId, id, post.body ?? '', post.id);
}

export async function selectCampaign(db, id) {
  if (id !== null && !idPattern.test(id)) throw new ModerationError(400, 'Invalid campaign week.');
  const { results } = await db.prepare(`SELECT id,label,topic,starts_at AS startsAt,ends_at AS endsAt,rubric_id AS rubricId,revision
    FROM entropy_campaign_weeks ORDER BY starts_at DESC,id`).all();
  const week = id === null ? results[0] : results.find(item => item.id === id);
  if (id !== null && !week) throw new ModerationError(404, 'Campaign week not found.');
  const publicWeek = ({ rubricId, revision, ...view }) => view;
  return { week, view: { weeks: results.map(publicWeek), week: week ? publicWeek(week) : null } };
}

export async function campaignEntries(db, week, posts) {
  const { results } = await db.prepare(`SELECT post_id AS postId,post_body AS body,model_status AS modelStatus,
    model_choice AS choice,confidence,model,manual_status AS manualStatus,reviewed_at AS reviewedAt,revision
    FROM entropy_campaign_decisions WHERE week_id=? AND rubric_id=?`).bind(week.id, week.rubricId).all();
  const decisionByPost = new Map(results.map(row => [row.postId, row]));
  const start = Date.parse(week.startsAt);
  const end = Date.parse(week.endsAt);
  return posts.flatMap(post => {
    const decision = decisionByPost.get(post.id);
    const at = Date.parse(post.publishedAt);
    if (!decision || post.excluded || decision.body !== (post.body ?? '') || !(at >= start && at < end)) return [];
    const { body, ...result } = decision;
    return [{ ...result, post, status: decision.manualStatus ?? decision.modelStatus }];
  });
}

export function campaignReviewPage(entries, authors, url) {
  const authorById = new Map(authors.map(author => [author.id, author]));
  const counts = { match: 0, review: 0, off_topic: 0 };
  for (const entry of entries) counts[entry.status]++;
  const requested = url.searchParams.get('status');
  const status = statusValues.includes(requested) ? requested : 'review';
  const matches = entries.filter(entry => entry.status === status)
    .sort((a, b) => b.post.publishedAt.localeCompare(a.post.publishedAt) || b.post.id.localeCompare(a.post.id));
  const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
  const page = Math.min(requestedPage(url.searchParams.get('page')), totalPages);
  const offset = (page - 1) * pageSize;
  return { counts, status, page, totalPages, posts: matches.slice(offset, offset + pageSize).map(entry => ({
    ...entry, handle: authorById.get(entry.post.authorId)?.handle ?? '',
  })) };
}

export async function reviewCampaignPost(db, input, actor) {
  const { week, postId, status, revision } = input;
  if (typeof week !== 'string' || !idPattern.test(week) || typeof postId !== 'string'
    || !/^[1-9]\d{0,23}$/.test(postId) || !statusValues.includes(status)
    || !Number.isSafeInteger(revision) || revision < 0) {
    throw new ModerationError(400, 'Invalid weekly review.');
  }
  const saved = await db.prepare(`UPDATE entropy_campaign_decisions
    SET manual_status=?,reviewed_at=?,reviewed_by=?,revision=revision+1
    WHERE week_id=? AND post_id=? AND revision=?
      AND rubric_id=(SELECT rubric_id FROM entropy_campaign_weeks WHERE id=?)
      AND post_body=${activeBody('entropy_campaign_decisions.post_id')}
   `).bind(status, new Date().toISOString(), actor, week, postId, revision, week).run();
  if (saved.meta.changes !== 1) throw new ModerationError(409, 'This decision changed. Reload the queue and try again.');
}
