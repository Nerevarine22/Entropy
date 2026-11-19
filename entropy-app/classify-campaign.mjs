import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { withLocalD1 } from './local-d1.mjs';
import { readCampaignSource } from '../entropy-cloud/leaderboard-worker.mjs';

import { classifyCampaignPost, identifyCampaign, isText, rubricFrom } from '../entropy-cloud/campaign-model.mjs';
import { campaignDecisionWrite, registerCampaign } from '../entropy-cloud/campaign-store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

async function main() {
  const { values } = parseArgs({
    options: { rubric: { type: 'string' }, limit: { type: 'string', default: '40' },
      sample: { type: 'boolean' }, run: { type: 'boolean' }, help: { type: 'boolean' } },
  });
  if (values.help || !values.rubric) {
    console.log('Usage: node --env-file-if-exists=.env classify-campaign.mjs --rubric <file.json> [--limit 40] [--sample] [--run]');
    console.log('Rubric fields: week, from, until (exclusive), topic, rules and optional examples [{text, label}].');
    return;
  }
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.');
  const rubric = rubricFrom(JSON.parse(await readFile(values.rubric, 'utf8')));
  const campaign = await identifyCampaign(rubric);
  const { id: weekId, rubricId } = campaign;
  const dataset = await withLocalD1(readCampaignSource);
  const candidates = dataset.posts.filter(post => {
    const published = Date.parse(post.publishedAt);
    return !post.excluded && published >= rubric.start && published < rubric.end;
  }).sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || a.id.localeCompare(b.id));
  const legacyFile = new URL(`./runtime/campaign-${rubricId}.jsonl`, import.meta.url);
  const saved = await readFile(legacyFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const pilot = new Map(saved.trim().split('\n').filter(Boolean).map(line => {
    const row = JSON.parse(line);
    return [row.postId, row];
  }));
  const existing = await withLocalD1(db => db.prepare(`SELECT post_id AS id,post_body AS body
    FROM entropy_campaign_decisions WHERE week_id=? AND rubric_id=?`).bind(weekId, rubricId).all());
  const completed = new Map(existing.results.map(row => [row.id, row.body]));
  const fromPilot = candidates.filter(post => completed.get(post.id) !== (post.body ?? '')
    && pilot.get(post.id)?.contentHash === hash(post.body ?? ''));
  for (const post of fromPilot) completed.set(post.id, post.body ?? '');
  const remaining = candidates.filter(post => completed.get(post.id) !== (post.body ?? ''));
  const pending = values.sample && remaining.length > limit
    ? Array.from({ length: limit }, (_, index) => remaining[Math.floor((index + 0.5) * remaining.length / limit)])
    : remaining.slice(0, limit);
  const requests = pending.filter(post => isText(post.body)).length;
  console.log(JSON.stringify({ week: rubric.week, candidates: candidates.length, fromPilot: fromPilot.length, selected: pending.length, requests,
    reviewWithoutText: pending.length - requests, dryRun: !values.run }));
  if (!values.run) return;
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (requests && !key) throw new Error('Set TYPESAFE_API_KEY in the local entropy-app/.env file.');
  await withLocalD1(db => db.batch([
    registerCampaign(db, campaign),
    ...fromPilot.map(post => campaignDecisionWrite(db, campaign, post, pilot.get(post.id))),
  ]));
  for (const post of pending) {
    const decision = await classifyCampaignPost(post, rubric, key);
    await withLocalD1(db => campaignDecisionWrite(db, campaign, post, decision).run());
  }
  console.log(`Saved ${pending.length + fromPilot.length} decisions to local D1 for ${weekId}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
