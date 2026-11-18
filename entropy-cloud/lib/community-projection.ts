import { Model } from './entropy-engine.mjs';

type ObjectValue = Record<string, any>;
type Source = { dataset: ObjectValue; state: ObjectValue; revision: number; updatedAt: string; sync: ObjectValue };
const METRICS = ['impressions', 'likes', 'reposts', 'quotes', 'replies'] as const;
type Metrics = Record<(typeof METRICS)[number], number | null>;
type PublicAuthor = { id: string; handle: string; displayName: string };
type PublicRow = { rank: number; author: PublicAuthor; score: number | null; posts: number; metrics: Metrics };
type PublicPost = { id: string; authorId: string; date: string; publishedAt: string | null; url: string; body: string | null; summary: string; metrics: Metrics; metricsAsOf: string | null };
type PublicPeriod = { key: string; start: string; endExclusive: string; rows: PublicRow[] };
export type CommunitySnapshot = {
  schemaVersion: 1; revision: number; updatedAt: string;
  public: { target: '@entropyIO'; defaultPeriod: string; periods: PublicPeriod[]; posts: PublicPost[];
    freshness: { lastDiscoveryAt: string | null; coverage: 'partial' } };
};
export type CommunityDelivery = { configured: boolean; delivered: boolean; revision: number };
type DeliveryConfiguration = { url?: unknown; secret?: unknown };

function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function metrics(raw: ObjectValue): Metrics {
  return Object.fromEntries(METRICS.map(key => [key, Number.isSafeInteger(raw?.[key]) && raw[key] >= 0 ? raw[key] : null])) as Metrics;
}
function publicUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)
      || !/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/[1-9]\d*\/?$/.test(url.pathname)) throw new Error('Invalid public post URL.');
  // Provider/import URLs may contain tracking or other private parameters.
  url.username = ''; url.password = ''; url.search = ''; url.hash = ''; url.port = '';
  return url.toString();
}
function publicPost(post: ObjectValue): PublicPost {
  const publishedAt = timestamp(post.publishedAt);
  return { id: post.id, authorId: post.authorId, date: post.date, publishedAt: publishedAt?.slice(0, 10) === post.date ? publishedAt : null, url: publicUrl(post.url),
    body: typeof post.body === 'string' ? post.body : null, summary: typeof post.summary === 'string' ? post.summary : '',
    metrics: metrics(post.metrics), metricsAsOf: timestamp(post.metricsAsOf) };
}
function lexical(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }

/** Build a new allowlisted object. Never spread stored authors, posts, state or sync into a public response. */
export function projectCommunitySnapshot(source: Source, now = new Date()): CommunitySnapshot {
  if (!Number.isSafeInteger(source.revision) || source.revision < 0 || !timestamp(source.updatedAt)) throw new Error('Invalid source snapshot.');
  const defaultPeriod = now.toISOString().slice(0, 7);
  const authors = new Map<string, ObjectValue>(source.dataset.authors.map((author: ObjectValue) => [author.id, author]));
  const groups = new Map<string, Map<string, ObjectValue[]>>([[defaultPeriod, new Map()]]);
  for (const post of source.dataset.posts as ObjectValue[]) {
    const key = post.date.slice(0, 7);
    if (source.state.bans[post.authorId] || source.state.periodDecisions[key + '|' + post.authorId] || source.state.postExclusions[post.id]) continue;
    if (!groups.has(key)) groups.set(key, new Map());
    const month = groups.get(key)!;
    if (!month.has(post.authorId)) month.set(post.authorId, []);
    month.get(post.authorId)!.push(post);
  }
  const publicPosts = new Map<string, PublicPost>();
  const periods: PublicPeriod[] = [];
  for (const [key, month] of [...groups].sort(([a], [b]) => lexical(b, a))) {
    const period = Model.periodFor(key, source.dataset);
    const rows: PublicRow[] = [];
    for (const [authorId, posts] of month) {
      const author = authors.get(authorId);
      if (!author) continue;
      const handle = author.handle.replace(/^@/, '');
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) continue;
      // Reuse private scoring semantics, but scope the post scan to this group.
      // Audience evidence and account reviews remain server-only.
      const aggregate = Model.aggregateAuthor({ ...source.dataset, posts }, source.state, author, period);
      if (!aggregate.participates) continue;
      rows.push({ rank: 0, author: { id: author.id, handle,
        displayName: typeof author.displayName === 'string' ? author.displayName : author.handle },
        score: aggregate.score.status === 'eligible' && aggregate.score.score <= Number.MAX_SAFE_INTEGER ? number(aggregate.score.score) : null,
        posts: aggregate.posts.length, metrics: metrics(aggregate.metrics) });
      for (const post of aggregate.posts) publicPosts.set(post.id, publicPost(post));
    }
    rows.sort((a, b) => {
      if (a.metrics.impressions === null && b.metrics.impressions !== null) return 1;
      if (a.metrics.impressions !== null && b.metrics.impressions === null) return -1;
      return (b.metrics.impressions ?? 0) - (a.metrics.impressions ?? 0)
        || lexical(a.author.handle.toLowerCase(), b.author.handle.toLowerCase()) || lexical(a.author.id, b.author.id);
    });
    rows.forEach((row, index) => { row.rank = index + 1; });
    periods.push({ key, start: period.start, endExclusive: period.endExclusive, rows });
  }
  return { schemaVersion: 1, revision: source.revision, updatedAt: timestamp(source.updatedAt)!, public: {
    target: '@entropyIO', defaultPeriod, periods,
    posts: [...publicPosts.values()].sort((a, b) => lexical(b.date, a.date) || lexical(b.publishedAt || '', a.publishedAt || '') || lexical(a.id, b.id)),
    freshness: { lastDiscoveryAt: timestamp(source.sync.hourly?.lastSuccessAt), coverage: 'partial' },
  } };
}

/** A mirror failure must never undo or fail an already committed admin write. */
export async function publishCommunitySnapshot(source: Source, configuration: DeliveryConfiguration): Promise<CommunityDelivery> {
  const configured = typeof configuration.url === 'string' && !!configuration.url.trim()
    && typeof configuration.secret === 'string' && !!configuration.secret.trim();
  const result: CommunityDelivery = { configured, delivered: false, revision: source.revision };
  if (!configured) return result;
  try {
    const base = new URL((configuration.url as string).trim());
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return result;
    const destination = new URL('/internal/snapshot', base.origin);
    const response = await fetch(destination, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (configuration.secret as string).trim() },
      body: JSON.stringify(projectCommunitySnapshot(source)) });
    return { ...result, delivered: response.ok };
  } catch { return result; }
}
