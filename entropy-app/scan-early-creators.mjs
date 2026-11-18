import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import Model from './model.js';
import { advanceBackfill, beginBackfill } from './backfill.mjs';
import { importEarlyCreatorPosts } from './local-d1.mjs';
import { createClient } from './twitterapi.mjs';

const phase = Model.EARLY_CREATOR_PERIOD;
const runtime = new URL('./runtime/', import.meta.url);
const checkpoint = new URL(`early-creators-${phase.start}-${phase.endExclusive}.json`, runtime);
const REQUESTS_PER_RUN = 10;

async function main() {
  const previous = await readFile(checkpoint, 'utf8').then(JSON.parse, error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (process.argv.includes('--import')) {
    if (!previous) throw new Error('Run the Early Creators scan before importing.');
    console.log(JSON.stringify(await importEarlyCreatorPosts(previous.dataset)));
    return;
  }
  const priorAttempts = previous?.sync.backfill.requestCount ?? 0;
  const limit = Math.min(priorAttempts + REQUESTS_PER_RUN, 1000);
  let work = beginBackfill(previous ?? {
    dataset: { meta: {}, authors: [], posts: [] },
    state: Model.initialState(),
    sync: { enabled: true },
  }, { ...phase, requestLimit: limit });

  function report() {
    const job = work.sync.backfill;
    console.log(JSON.stringify({
      start: job.start, endExclusive: job.endExclusive, status: job.status,
      requests: job.requestCount - priorAttempts, totalRequests: job.requestCount,
      remainingWindows: job.pendingWindows.length, nextWindow: job.pendingWindows[0]?.start ?? null,
      gaps: job.gaps.length, posts: work.dataset.posts.length, creators: work.dataset.authors.length,
      error: job.lastError?.code ?? null,
    }));
  }

  if (!process.argv.includes('--run')) {
    report();
    return;
  }
  const apiKey = process.env.TWITTERAPI_IO_KEY?.trim();
  if (!apiKey) throw new Error('Set TWITTERAPI_IO_KEY in the local .env file.');
  await mkdir(runtime, { recursive: true });
  const client = createClient({ apiKey, timeoutMs: 15000 });
  const pending = new URL(`early-creators-${process.pid}.tmp`, runtime);
  while (['running', 'waiting'].includes(work.sync.backfill.status) && work.sync.backfill.requestCount < limit) {
    const delay = Date.parse(work.sync.backfill.nextAttemptAt) - Date.now();
    if (delay > 6000) break;
    if (delay > 0) await wait(delay + 10);
    work = await advanceBackfill(work, { client });
    await writeFile(pending, JSON.stringify(work));
    await rename(pending, checkpoint);
    report();
    if (work.sync.backfill.lastError) return;
  }
  report();
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
