import Model from '../entropy-app/model.js';

export const EARLY_CREATOR_PERIOD = Model.EARLY_CREATOR_PERIOD;
export const POST_PAGE_SIZE = 10;
const CREATOR_PAGE_SIZE = 20;
const REACH_REFERENCE = 20_000;
const byViews = (a, b) => (b.views ?? -1) - (a.views ?? -1) || a.author.handle.localeCompare(b.author.handle);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const clampUnit = value => Math.max(0, Math.min(value, 1));

export function total(posts, field) {
  let sum = 0;
  for (const post of posts) {
    const value = post.metrics[field];
    if (typeof value !== 'number') return null;
    sum += value;
  }
  return sum;
}

export function creatorScore({ views, likes, reposts, quotes, followers, smartFollowers, postCount }) {
  if (!(views > 0) || ![views, likes, reposts, quotes, postCount].every(isCount)) return null;

  const er = (likes + reposts + quotes) / views;
  const reachScale = clampUnit(views / REACH_REFERENCE);
  const reachPoints = 10 * Math.sqrt(views);
  const audienceQuality = isCount(smartFollowers) ? clampUnit(Math.log10(1 + smartFollowers) / 3) : 0;
  const audiencePoints = Math.min(540, 0.35 * reachPoints) * audienceQuality;

  const weightedReactions = likes + 3 * reposts + (4 + 2 * reachScale) * quotes;
  const reactionCap = views * (0.01 + 0.04 * reachScale);
  const reactionPoints = 0.7 * Math.min(weightedReactions, reactionCap) * reachScale ** 1.5;
  const efficiencyPoints = isCount(followers)
    ? 120 * Math.min(Math.log1p(views / Math.max(followers, 1)), 2) * reachScale
    : 0;

  const postMultiplier = 1 + 0.01 * Math.min(postCount, 20);
  const erMultiplier = 0.90 + 2 * Math.min(er, 0.05);
  const erExcess = clampUnit((er - 0.10) / 0.10);
  const reachConfidence = clampUnit((views - 1000) / 4000);
  const penaltyMultiplier = 1 - 0.35 * erExcess * reachConfidence;
  const score = (reachPoints + audiencePoints + reactionPoints + efficiencyPoints)
    * postMultiplier * erMultiplier * penaltyMultiplier;
  return Math.round(10 * score) / 10;
}

export function postScore(author, { impressions, likes, reposts, quotes }) {
  return creatorScore({ views: impressions, likes, reposts, quotes, followers: author.followers,
    smartFollowers: author.twitterScore?.smartFollowers, postCount: 1 });
}

export function summarizeActivity(posts, through) {
  const days = new Map();
  const firstPostByAuthor = new Map();
  const viewSamples = [];
  for (const { authorId, date, metrics } of posts) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > through) continue;
    if (!days.has(date)) days.set(date, { date, posts: 0, views: 0, postsWithViews: 0, newAuthors: 0 });
    const day = days.get(date);
    day.posts++;
    if (isCount(metrics.impressions)) {
      day.views += metrics.impressions;
      day.postsWithViews++;
      viewSamples.push({ date, views: metrics.impressions });
    }
    const firstPost = firstPostByAuthor.get(authorId);
    if (!firstPost || date < firstPost) firstPostByAuthor.set(authorId, date);
  }
  for (const date of firstPostByAuthor.values()) days.get(date).newAuthors++;

  viewSamples.sort((a, b) => a.views - b.views);
  const medianViews = {};
  for (const period of [7, 30, 90, 'all']) {
    const from = period === 'all' ? '' : new Date(Date.parse(through) - (period - 1) * 86_400_000).toISOString().slice(0, 10);
    const samples = viewSamples.filter(sample => sample.date >= from);
    const middle = Math.floor(samples.length / 2);
    medianViews[period] = samples.length
      ? (samples[Math.floor((samples.length - 1) / 2)].views + samples[middle].views) / 2 : null;
  }
  return { days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), medianViews };
}

export function summarize(dataset) {
  const groups = new Map();
  for (const post of dataset.posts) {
    if (!groups.has(post.authorId)) groups.set(post.authorId, []);
    groups.get(post.authorId).push(post);
  }
  const rows = dataset.authors.map(author => {
    const posts = groups.get(author.id) || [];
    posts.sort((a, b) => (b.publishedAt || b.date).localeCompare(a.publishedAt || a.date) || b.id.localeCompare(a.id));
    const views = total(posts, 'impressions');
    const likes = total(posts, 'likes');
    const reposts = total(posts, 'reposts');
    const quotes = total(posts, 'quotes');
    const engagement = views > 0 && [likes, reposts, quotes].every(value => value !== null)
      ? (likes + reposts + quotes) / views * 100 : null;
    let topPost = null;
    for (const { id, metrics } of posts) {
      const score = postScore(author, metrics);
      if (score !== null && (topPost === null || score > topPost.score)) topPost = { id, score };
    }
    return {
      author, views, likes, engagement, postCount: posts.length,
      score: creatorScore({ views, likes, reposts, quotes, followers: author.followers,
        smartFollowers: author.twitterScore?.smartFollowers, postCount: posts.length }),
      early: posts.some(Model.isEarlyCreatorPost), postIds: posts.map(post => post.id), topPost,
    };
  }).filter(row => row.postCount > 0)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || byViews(a, b));
  rows.forEach((row, index) => { row.rank = row.score === null ? null : index + 1; });
  return {
    version: crypto.randomUUID(), rows, leaders: rows.filter(row => row.views > 0).sort(byViews).slice(0, 20),
    asOf: dataset.meta.asOf,
    totals: { creators: rows.length, posts: dataset.posts.length, views: total(dataset.posts, 'impressions') },
  };
}

export function creatorSummary({ postIds, topPost, author, ...row }) {
  const { followers, ...publicAuthor } = author;
  return { ...row, author: publicAuthor };
}

export function requestedPage(value) {
  if (!/^[1-9]\d{0,5}$/.test(value || '')) return 1;
  return Number(value);
}

export function rankPage(snapshot, page, search) {
  const matches = search ? snapshot.rows.filter(({ author }) =>
    author.handle.toLowerCase().includes(search) || author.displayName.toLowerCase().includes(search)) : snapshot.rows;
  const totalPages = Math.max(1, Math.ceil(matches.length / CREATOR_PAGE_SIZE));
  page = Math.min(page, totalPages);
  const offset = (page - 1) * CREATOR_PAGE_SIZE;
  return {
    page, totalPages, offset, total: matches.length, totals: snapshot.totals, asOf: snapshot.asOf, rankingMetric: 'score',
    rows: matches.slice(offset, offset + CREATOR_PAGE_SIZE).map(creatorSummary),
    leaders: snapshot.leaders.map(creatorSummary),
  };
}
