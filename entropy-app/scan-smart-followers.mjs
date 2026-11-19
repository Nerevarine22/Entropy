import { setTimeout as wait } from 'node:timers/promises';
import { readLocalDataset, saveTwitterScore } from './local-d1.mjs';
import { fetchSmartFollowers } from './twitter-score.mjs';

const TOP_COUNT = 20;
const CACHE_MS = 24 * 60 * 60 * 1000;

function topCreators(dataset, limit) {
  const views = new Map();
  for (const post of dataset.posts) {
    if (post.isReply === true) continue;
    const previous = views.get(post.authorId);
    const count = post.metrics.impressions;
    views.set(post.authorId, previous === null || count === null ? null : (previous ?? 0) + count);
  }
  return dataset.authors.filter(author => views.has(author.id) && /^[1-9]\d*$/.test(author.id))
    .sort((a, b) => (views.get(b.id) ?? -1) - (views.get(a.id) ?? -1) || a.handle.localeCompare(b.handle))
    .slice(0, limit);
}

async function main() {
  const dataset = await readLocalDataset();
  if (!dataset) throw new Error('The local D1 database has no dataset.');

  const topOption = process.argv.indexOf('--top');
  const limit = topOption < 0 ? TOP_COUNT : Number(process.argv[topOption + 1]);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--top requires a positive integer.');
  const creators = topCreators(dataset, limit);
  const now = Date.now();
  const pending = creators.filter(author => {
    const age = now - Date.parse(author.twitterScore?.checkedAt);
    return !(age >= 0 && age < CACHE_MS);
  });
  console.log(JSON.stringify({ creators: creators.length, cached: creators.length - pending.length, requestsPlanned: pending.length }));
  if (!process.argv.includes('--run') || !pending.length) return;

  const key = process.env.TWITTERSCORE_API_KEY?.trim();
  if (!key) throw new Error('Set TWITTERSCORE_API_KEY in the local .env file.');

  let saved = 0;
  let unavailable = 0;
  for (const author of pending) {
    if (saved + unavailable > 0) await wait(1000);
    const count = await fetchSmartFollowers(author.id, key);
    await saveTwitterScore(author.id, count, new Date().toISOString());
    if (count === null) unavailable++;
    else saved++;
    console.log(JSON.stringify({ checked: saved + unavailable, saved, unavailable }));
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
