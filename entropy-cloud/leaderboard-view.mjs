import Model from '../entropy-app/model.js';

export const POST_PAGE_SIZE = 10;
const CREATOR_PAGE_SIZE = 20;

function total(posts, field) {
  let sum = 0;
  for (const post of posts) {
    const value = post.metrics[field];
    if (typeof value !== 'number') return null;
    sum += value;
  }
  return sum;
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
    return {
      author, views, likes, engagement, postCount: posts.length,
      early: posts.some(Model.isEarlyCreatorPost), postIds: posts.map(post => post.id),
    };
  }).filter(row => row.postCount > 0)
    .sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || a.author.handle.localeCompare(b.author.handle));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return {
    version: crypto.randomUUID(), rows, asOf: dataset.meta.asOf,
    totals: { creators: rows.length, posts: dataset.posts.length, views: total(dataset.posts, 'impressions') },
  };
}

export function creatorSummary({ postIds, ...row }) { return row; }

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
    page, totalPages, offset, total: matches.length, totals: snapshot.totals, asOf: snapshot.asOf,
    rows: matches.slice(offset, offset + CREATOR_PAGE_SIZE).map(creatorSummary),
    leaders: snapshot.rows.filter(row => row.views > 0).slice(0, 20).map(creatorSummary),
  };
}
