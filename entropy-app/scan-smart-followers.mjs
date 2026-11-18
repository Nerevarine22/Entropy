import { setTimeout as wait } from 'node:timers/promises';
import { readLocalDataset, saveTwitterScore } from './local-d1.mjs';

const ENDPOINT = 'https://twitterscore.io/api/v1/get_followers_score_sum';
const TOP_COUNT = 20;
const CACHE_MS = 24 * 60 * 60 * 1000;
const ERROR_CODES = new Set([
  'api_key_missing', 'api_key_invalid', 'api_key_revoked', 'api_access_deactivated',
  'invalid_params', 'rate_limited', 'quota_exceeded', 'server_error',
]);

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

async function fetchCount(authorId, key) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('twitter_id', authorId);
  let response, body;
  try {
    response = await fetch(url, {
      headers: { 'X-API-Key': key, 'User-Agent': 'Entropy-Creators/1.0', Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    body = await response.json();
  } catch {
    if (response && !response.ok) throw new Error(`TwitterScore returned HTTP ${response.status}.`);
    throw new Error('TwitterScore request failed or returned unreadable data.');
  }

  const code = body?.error?.code;
  if (body?.success === false && code === 'account_not_found') return null;
  if (body?.success === false || !response.ok) {
    const reason = ERROR_CODES.has(code) ? code : `HTTP ${response.status}`;
    throw new Error(`TwitterScore stopped the scan (${reason}).`);
  }
  const count = body?.smart_followers_count;
  if (body?.success !== true || String(body.twitter_id) !== authorId || !Number.isSafeInteger(count) || count < 0) {
    throw new Error('TwitterScore response did not contain a valid Smart Followers count for the requested X account.');
  }
  return count;
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
    const count = await fetchCount(author.id, key);
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
