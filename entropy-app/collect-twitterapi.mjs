import { parseArgs } from 'node:util';
import { open, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createClient, normalizeTweets } from './twitterapi.mjs';

const require = createRequire(import.meta.url);
const Model = require('./model.js');
const DAY = 86400000;
export const DEFAULT_HANDLE = 'entropyIO';

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Потрібна дата YYYY-MM-DD.');
  const time = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('Некоректна дата.');
  return time;
}

export function makePlan({ handle = DEFAULT_HANDLE, start, end, maxRequests = 5 }) {
  if (typeof handle !== 'string' || !/^@?[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('Потрібен точний @handle проєкту.');
  handle = handle.replace(/^@/, '');
  const from = day(start), until = day(end);
  if (until <= from || until - from > 62 * DAY) throw new Error('Інтервал має бути від 1 до 62 днів; end — виключна межа UTC.');
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000) throw new Error('Ліміт запитів має бути цілим числом від 1 до 1000.');
  const windows = [];
  for (let time = from; time < until; time += DAY) {
    const endTime = Math.min(time + DAY, until);
    windows.push({ start: new Date(time).toISOString(), endExclusive: new Date(endTime).toISOString(),
      query: '@' + handle + ' since_time:' + time / 1000 + ' until_time:' + endTime / 1000 + ' -filter:replies' });
  }
  return { provider: 'twitterapi.io', handle, start, end, maxRequests, windows };
}

// Deliberately bounded and manually invoked. No timers run after this function returns.
export async function collectSearch({ client, plan, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => new Date().toISOString() }) {
  plan = makePlan(plan);
  const startedAt = now(), raw = [], windows = [];
  let requests = 0, stopReason = null;
  outer: for (const window of plan.windows) {
    let cursor = '', previousOldest = null;
    const cursors = new Set();
    const progress = { ...window, pages: 0, exhausted: false, nextCursor: null };
    windows.push(progress);
    while (true) {
      if (requests >= plan.maxRequests) { stopReason = 'request-limit'; progress.nextCursor = cursor; break outer; }
      if (requests > 0) await wait(5100);
      const page = await client.searchPage({ query: window.query, cursor });
      requests++; progress.pages++;
      if (!page || !Array.isArray(page.tweets) || typeof page.hasNextPage !== 'boolean') throw new Error('Некоректна сторінка джерела.');
      raw.push(...page.tweets);
      const times = page.tweets.map(t => Date.parse(t.createdAt)).filter(Number.isFinite);
      if (previousOldest !== null && times.length && Math.max(...times) > previousOldest) {
        stopReason = 'pagination-order'; progress.nextCursor = page.nextCursor || null; break outer;
      }
      if (times.length) previousOldest = Math.min(...times);
      if (!page.hasNextPage) { progress.exhausted = true; break; }
      if (!page.tweets.length || typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor)) {
        stopReason = 'pagination-stalled'; progress.nextCursor = page.nextCursor || null; break outer;
      }
      cursor = page.nextCursor; cursors.add(cursor); progress.nextCursor = cursor;
    }
  }
  const observedAt = now();
  const dataset = normalizeTweets(raw, { observedAt, query: '@' + plan.handle, periodStart: plan.start, periodEndExclusive: plan.end });
  const totalNormalized = dataset.posts.length;
  const mention = new RegExp('(^|[^A-Za-z0-9_])@' + plan.handle + '(?![A-Za-z0-9_])', 'i');
  const directMentionIds = new Set(raw.filter(t => mention.test(typeof t.text === 'string' ? t.text : '') ||
    Array.isArray(t.entities?.user_mentions) && t.entities.user_mentions.some(m => typeof m?.screen_name === 'string' && m.screen_name.toLowerCase() === plan.handle.toLowerCase())).map(t => t.id));
  // Providers can return boundary duplicates or own-project posts. Both are excluded explicitly.
  const ownIds = new Set(dataset.authors.filter(a => a.handle.toLowerCase() === plan.handle.toLowerCase()).map(a => a.id));
  dataset.posts = dataset.posts.filter(p => directMentionIds.has(p.id) && !ownIds.has(p.authorId) && p.isReply === false && p.date >= plan.start && p.date < plan.end);
  const authorIds = new Set(dataset.posts.map(p => p.authorId));
  dataset.authors = dataset.authors.filter(a => authorIds.has(a.id));
  dataset.meta.collection = { startedAt, finishedAt: observedAt, requestCount: requests, requestLimit: plan.maxRequests,
    stopReason, returnedRows: raw.length, filteredRows: totalNormalized - dataset.posts.length + (dataset.meta.diagnostics?.outsidePeriod || 0), windows,
    pendingWindows: plan.windows.length - windows.filter(w => w.exhausted).length };
  dataset.meta.coverage = 'partial';
  dataset.meta.sourceNote = 'Ручний обмежений збір twitterapi.io. Накопичені перегляди постів, опублікованих у вибраному інтервалі; органічність і повноту не підтверджено.';
  return Model.validateDataset(dataset);
}

async function main() {
  const { values } = parseArgs({ options: { handle: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
    'max-requests': { type: 'string', default: '5' }, output: { type: 'string' }, run: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) {
    console.log('node collect-twitterapi.mjs [--handle entropyIO] --start YYYY-MM-DD --end YYYY-MM-DD [--max-requests 5] [--output FILE --run]');
    console.log('Без --run показує лише план. --end — виключна межа UTC. Ключ — тільки у серверній змінній TWITTERAPI_IO_KEY.');
    return;
  }
  const plan = makePlan({ handle: values.handle, start: values.start, end: values.end, maxRequests: Number(values['max-requests']) });
  if (!values.run) { console.log(JSON.stringify({ mode: 'plan-only-no-network', ...plan }, null, 2)); return; }
  if (!values.output) throw new Error('Для ручного запуску потрібен --output FILE.');
  const apiKey = process.env.TWITTERAPI_IO_KEY;
  if (!apiKey) throw new Error('Не задано TWITTERAPI_IO_KEY у серверному середовищі. Ключ не вставляйте в HTML або командний рядок.');
  // Reserve the output before any billable request; never overwrite a previous run.
  const file = await open(values.output, 'wx', 0o600);
  let dataset;
  try {
    dataset = await collectSearch({ client: createClient({ apiKey }), plan });
    await file.writeFile(JSON.stringify(dataset, null, 2), 'utf8');
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(values.output).catch(() => {});
    throw error;
  }
  console.log(JSON.stringify({ authors: dataset.authors.length, posts: dataset.posts.length, requests: dataset.meta.collection.requestCount,
    coverage: dataset.meta.coverage, stopReason: dataset.meta.collection.stopReason, output: values.output }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
