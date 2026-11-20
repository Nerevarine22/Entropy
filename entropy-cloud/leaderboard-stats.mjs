const DAY_MS = 86_400_000;
const dayFor = time => new Date(time).toISOString().slice(0, 10);
export const overallKey = 'overall';

export async function storeDailyRanks(db, loadBoards, now) {
  const day = dayFor(now);
  if (await db.prepare('SELECT 1 FROM entropy_daily_ranks WHERE day=? AND board=?').bind(day, overallKey).first()) return false;
  const { overall, weeks } = await loadBoards();
  const boards = [[overallKey, overall], ...weeks.map(week => [week.historyKey, week.snapshot])];
  const saved = await db.batch(boards.map(([key, snapshot]) => {
    const ranks = Object.fromEntries(snapshot.rows.filter(row => row.rank !== null).map(row => [row.author.id, row.rank]));
    return db.prepare('INSERT OR IGNORE INTO entropy_daily_ranks (day,board,ranks) VALUES (?,?,?)')
      .bind(day, key, JSON.stringify(ranks));
  }));
  return saved[0].meta.changes > 0;
}

export async function recentRanks(db, id, now, currentRank) {
  const days = Array.from({ length: 6 }, (_, i) => dayFor(now - (6 - i) * DAY_MS));
  const yesterday = days.at(-1);
  const { results } = await db.prepare(`SELECT day,board,json_extract(ranks,?) AS rank
    FROM entropy_daily_ranks WHERE day=? OR (board=? AND day IN (?,?,?,?,?))`
  ).bind(`$.${id}`, yesterday, overallKey, ...days.slice(0, -1)).all();
  const previous = new Map();
  const overall = new Map();
  for (const { day, board, rank } of results) {
    if (day === yesterday) previous.set(board, rank);
    if (board === overallKey) overall.set(day, rank);
  }
  const history = days.map(day => ({ day, rank: overall.get(day) ?? null }));
  history.push({ day: dayFor(now), rank: currentRank ?? null });
  return { previous, history };
}

export function personalRank(row, previousRank) {
  const rank = row?.rank ?? null;
  return {
    rank,
    previousRank: previousRank ?? null,
    hasPreviousSnapshot: previousRank !== undefined,
    rankChange: rank === null || previousRank == null ? null : previousRank - rank,
    newRank: previousRank === null && rank !== null,
    postCount: row?.postCount ?? 0,
  };
}

export function hasStatsServiceAccess(request, token) {
  const supplied = request.headers.get('Authorization');
  if (!/^[a-f0-9]{64}$/.test(token ?? '') || !/^Bearer [a-f0-9]{64}$/.test(supplied ?? '')) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ supplied.charCodeAt(i + 7);
  return mismatch === 0;
}
