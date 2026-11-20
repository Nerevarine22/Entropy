import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { creatorScore } from '../leaderboard-view.mjs';
import { collectCampaignDecisions } from '../campaign-ingestion.mjs';
import { CampaignModelError, classifyCampaignPost } from '../campaign-model.mjs';
import worker from '../leaderboard-worker.mjs';
import { localD1Binding } from '../../entropy-app/local-d1.mjs';

const origin = 'https://leaderboard.example';
const key = '9a'.repeat(32);
const generation = 'leaderboard-test';
const date = '2026-09-01';
const asOf = date + 'T12:00:00.000Z';
const reason = 'Internal moderation example';
const migrations = await Promise.all(['0000_aberrant_gamora.sql', '0001_creator_moderation.sql', '0003_campaign_weeks.sql',
  '0004_campaign_collection.sql', '0005_campaign_read_budget.sql']
  .map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));

function fixture(context) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  for (const migration of migrations) db.exec(migration);
  db.prepare("INSERT INTO entropy_control (id,generation,updated_at) VALUES ('main',?,?)").run(generation, asOf);
  const store = (kind, id, payload) => db.prepare(`
    INSERT INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at) VALUES (?,?,?,0,?,0)
    ON CONFLICT(generation,kind,record_id,chunk_index) DO UPDATE SET payload=excluded.payload
  `).run(generation, kind, id, JSON.stringify(payload));
  const update = () => db.exec("UPDATE entropy_control SET revision=revision+1 WHERE id='main'");
  const savePost = (id, authorId, body, views) => {
    store('post', id, { id, authorId, date, publishedAt: asOf, isReply: false, body,
      metrics: { impressions: views, likes: 2, reposts: 1, quotes: 0, replies: 0 } });
    update();
  };
  store('dataset-meta', 'main', { asOf });
  for (const [id, handle] of [['11', 'alice'], ['22', 'bob']]) store('author', id, { id, handle, displayName: handle });
  savePost('111', '11', 'Original @entropyIO post', 120);
  savePost('222', '22', 'Another @entropyIO post', 80);
  const cache = new Map();
  let datasetReads = 0;
  const binding = localD1Binding(db);
  const env = {
    DB: { ...binding, prepare(sql) {
      if (sql.includes('WHEN kind LIKE')) datasetReads++;
      return binding.prepare(sql);
    } },
    ENTROPY_ADMIN_SECRET: key, ENTROPY_ADMIN_ID: 'moderator',
    previewCache: {
      async match(url) { return cache.get(url)?.clone(); },
      async put(url, response) { cache.set(url, response.clone()); },
    },
  };
  let cookie;
  const call = (path, { action, unrelatedOrigin, anonymous, forgedCookie } = {}) => {
    const headers = new Headers();
    if (!anonymous && (forgedCookie || cookie)) headers.set('Cookie', forgedCookie || cookie);
    if (action) {
      headers.set('Content-Type', 'application/json');
      headers.set('Origin', unrelatedOrigin ?? origin);
    }
    return worker.fetch(new Request(origin + path, { method: action ? 'POST' : 'GET', headers,
      ...(action ? { body: JSON.stringify(action) } : {}) }), env);
  };
  async function login() {
    const response = await call('/api/admin', { action: { action: 'login', key } });
    assert.equal(response.status, 200);
    const issued = response.headers.get('Set-Cookie');
    assert.match(issued, /^__Host-entropy-admin=/);
    assert.match(issued, /HttpOnly; SameSite=Strict; Secure/);
    cookie = issued.split(';')[0];
  }
  return { call, login, savePost, db, datasetReads: () => datasetReads };
}

const data = async response => {
  assert.equal(response.status, 200);
  return response.json();
};

test('creator score caps audience and volume bonuses and softens high ER only with enough views', () => {
  const small = { views: 900, likes: 45, reposts: 0, quotes: 0, followers: 1000, postCount: 1 };
  assert.equal(creatorScore({ ...small, likes: 270 }), creatorScore(small));
  assert.equal(creatorScore({ ...small, views: 0 }), null);
  assert.equal(creatorScore({ ...small, likes: null }), null);
  assert.equal(creatorScore({ ...small, smartFollowers: 0 }), creatorScore(small));
  assert(creatorScore({ ...small, smartFollowers: 100 }) > creatorScore({ ...small, smartFollowers: 10 }));
  assert.equal(creatorScore({ ...small, smartFollowers: 999 }), creatorScore({ ...small, smartFollowers: 10_000 }));
  assert.equal(creatorScore({ ...small, postCount: 20 }), creatorScore({ ...small, postCount: 21 }));

  const larger = { ...small, views: 6000, likes: 300 };
  const capped = creatorScore(larger);
  const penalized = creatorScore({ ...larger, likes: 1300 });
  assert(Math.abs(penalized - capped * 0.65) < 0.1);
});

test('public and admin ranking order by score while the map orders by views', async context => {
  const { call, login, db } = fixture(context);
  db.exec(`UPDATE entropy_records SET payload=json_set(payload,'$.twitterScore.smartFollowers',999,'$.followers',1000)
    WHERE kind='author' AND record_id='22'`);
  const ranking = await data(await call('/api/leaderboard?view=ranking'));
  assert.equal(ranking.rankingMetric, 'score');
  assert.deepEqual(ranking.rows.map(row => row.author.id), ['22', '11']);
  assert.deepEqual(ranking.rows.map(row => row.rank), [1, 2]);
  assert(ranking.rows[0].score > ranking.rows[1].score);
  assert.deepEqual(ranking.leaders.map(row => row.author.id), ['11', '22']);
  const search = await data(await call('/api/leaderboard?view=ranking&q=alice'));
  assert.equal(search.rows[0].rank, 2);
  await login();
  const admin = await data(await call('/api/admin?view=ranking&q=bob'));
  assert.equal(admin.rows[0].score, ranking.rows[0].score);
  assert.equal(admin.rows[0].author.followers, undefined);
  const legacy = await data(await call('/api/leaderboard'));
  assert(legacy.authors.every(author => !Object.hasOwn(author, 'followers')));
});

test('weekly reviews change only the selected campaign and edited posts require classification again', async context => {
  const { call, login, db, savePost, datasetReads } = fixture(context);
  savePost('112','11','Another qualifying post', 35);
  const addWeek = db.prepare('INSERT INTO entropy_campaign_weeks (id,label,topic,starts_at,ends_at,rubric_id) VALUES (?,?,?,?,?,?)');
  addWeek.run('week-1','Week 1','Role guides','2026-09-01T00:00:00Z','2026-09-07T00:00:00Z','rules-1');
  addWeek.run('week-2','Week 2','Another topic','2026-09-07T00:00:00Z','2026-09-14T00:00:00Z','rules-2');
  const add = db.prepare(`INSERT INTO entropy_campaign_decisions
    (week_id,rubric_id,post_id,post_body,model_status) VALUES ('week-1','rules-1',?,?,?)`);
  add.run('111','Original @entropyIO post','match');
  add.run('112','Another qualifying post','match');
  add.run('222','Another @entropyIO post','review');
  const weekly = () => call('/api/leaderboard?view=campaign&week=week-1').then(data);
  let result = await weekly();
  assert.deepEqual(result.weeks.map(week => week.id), ['week-2','week-1']);
  assert.equal(result.totals.posts, 2);
  assert.equal(result.rows[0].postCount, 2);
  assert.equal(result.rows[0].score, creatorScore({ views: 155, likes: 4, reposts: 2, quotes: 0, postCount: 2 }));
  const profile = await data(await call('/api/leaderboard?view=profile&week=week-1&creator=11'));
  assert.deepEqual(new Set(profile.posts.map(post => post.id)), new Set(['111','112']));
  assert.equal((await call('/api/leaderboard?view=profile&week=week-1&creator=22')).status,404);
  await data(await call('/api/leaderboard?view=campaign&week=week-1&q=alice&page=2'));
  assert.equal(datasetReads(),1);
  assert.equal((await call('/api/admin?view=weekly&week=week-1')).status,401);

  await login();
  const queue = await data(await call('/api/admin?view=weekly&week=week-1'));
  assert.deepEqual(queue.counts,{match:2,review:1,off_topic:0});
  assert.equal(queue.posts[0].post.id,'222');
  await data(await call('/api/admin?view=weekly&week=week-1&status=match'));
  assert.equal(datasetReads(),2);
  const action = {action:'campaign-review',week:'week-1',postId:'222',status:'match',revision:queue.posts[0].revision};
  await data(await call('/api/admin',{action}));
  assert.equal((await call('/api/admin',{action})).status,409);
  assert.equal((await weekly()).totals.posts,3);
  assert.equal((await data(await call('/api/leaderboard?view=campaign&week=week-2'))).totals.posts,0);
  assert.equal((await data(await call('/api/leaderboard?view=ranking'))).totals.posts,3);

  savePost('222','22','Edited after review',80);
  assert.equal((await weekly()).totals.posts,2);
  assert.equal((await data(await call('/api/leaderboard?view=ranking'))).totals.posts,3);
});

test('campaign scheduler classifies new text, preserves decisions for metrics updates, and retries failed work', async context => {
  const { db, call } = fixture(context);
  const env = { DB: localD1Binding(db), TYPESAFE_API_KEY: 'fixture' };
  const now = Date.parse('2026-11-19T12:00:00Z');
  db.exec(`UPDATE entropy_records SET payload=json_set(payload,'$.publishedAt','2026-11-19T10:00:00Z','$.date','2026-11-19')
    WHERE kind='post' AND record_id='111'`);
  const evaluated = [];
  const evaluate = async post => {
    evaluated.push(post.id);
    return { status: 'match', choice: 'match', confidence: 0.93, model: 'fixture-jev' };
  };
  assert.deepEqual(await collectCampaignDecisions(env,{now,evaluate}),{status:'classified',saved:1});
  assert.deepEqual(evaluated,['111']);
  assert.equal((await data(await call('/api/leaderboard?view=campaign'))).totals.posts,1);
  db.exec(`UPDATE entropy_records SET payload=json_set(payload,'$.metrics.impressions',220)
    WHERE kind='post' AND record_id='111';
    UPDATE entropy_control SET revision=revision+1 WHERE id='main'`);
  assert.deepEqual(await collectCampaignDecisions(env,{now:now+300000,evaluate}),{status:'idle',saved:0});
  assert.deepEqual(evaluated,['111']);
  assert.equal((await data(await call('/api/leaderboard?view=campaign'))).totals.views,220);
  db.exec(`UPDATE entropy_records SET payload=json_set(payload,'$.body','Changed body')
    WHERE kind='post' AND record_id='111';
    UPDATE entropy_control SET revision=revision+1 WHERE id='main'`);
  const failure = async () => { throw new CampaignModelError(429,600); };
  assert.equal((await collectCampaignDecisions(env,{now:now+600000,evaluate:failure})).status,'deferred');
  assert.deepEqual(await collectCampaignDecisions(env,{now:now+600000,evaluate:failure,newPosts:true}),
    {status:'provider-error',providerStatus:429,saved:0});
  assert.equal((await collectCampaignDecisions(env,{now:now+900000,evaluate,newPosts:true})).status,'deferred');
  assert.equal((await data(await call('/api/leaderboard?view=campaign'))).totals.posts,0);
  assert.deepEqual(await collectCampaignDecisions(env,{now:now+1200000,evaluate}),{status:'classified',saved:1});
  assert.deepEqual(evaluated,['111','111']);
});

test('campaign scheduler respects bans, individual exclusions and month exclusions', async context => {
  const { db } = fixture(context);
  const now = Date.parse('2026-11-19T12:00:00Z');
  const stamp = '2026-11-19T10:00:00Z';
  const add = db.prepare('INSERT INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at) VALUES (?,?,?,0,?,0)');
  for (const [id, authorId] of [['101','11'],['102','12'],['103','13'],['104','14']]) {
    add.run(generation,'post',id,JSON.stringify({id,authorId,publishedAt:stamp,date:'2026-11-19',isReply:false,body:'A post'}));
  }
  add.run(generation,'state:bans','11','{}');
  add.run(generation,'state:postExclusions','102','{}');
  add.run(generation,'state:periodDecisions','2026-11|13','{}');
  const evaluated = [];
  const evaluate = async post => {
    evaluated.push(post.id);
    return { status: 'match', choice: 'match', confidence: 0.93, model: 'fixture-jev' };
  };
  assert.deepEqual(await collectCampaignDecisions({DB:localD1Binding(db),TYPESAFE_API_KEY:'fixture'},{now,evaluate}),
    {status:'classified',saved:1});
  assert.deepEqual(evaluated,['104']);
});

test('the campaign date index still discovers split post records inside the week', async context => {
  const { db } = fixture(context);
  const now = Date.parse('2026-11-20T10:00:00Z');
  const add = db.prepare("INSERT INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at) VALUES (?,'post','901',?,?,0)");
  const entry = JSON.stringify({ id:'901',authorId:'11',publishedAt:'2026-11-19T10:00:00Z',
    date:'2026-11-19',isReply:false,body:'Split post body' });
  add.run(generation,0,entry.slice(0,26));
  add.run(generation,1,entry.slice(26));
  const evaluate = async post => {
    assert.equal(post.id,'901');
    assert.equal(post.body,'Split post body');
    return {status:'match',choice:'match',confidence:0.95,model:'fixture-jev'};
  };
  assert.deepEqual(await collectCampaignDecisions({DB:localD1Binding(db),TYPESAFE_API_KEY:'fixture'},{now,evaluate}),
    {status:'classified',saved:1});
});

test('the shared campaign client uses the Workers-compatible redirect mode', async () => {
  const rubric = { topic: 'Roles',rules:'Explain roles.',examples:[],reviewThreshold:0.8 };
  const fetcher = async (url, options) => {
    assert.equal(options.redirect,'manual');
    return Response.json({ answers:{ topicFit:{type:'choice',choice:'match',confidence:.7,probabilities:{match:.8,review:.1,off_topic:.1}} }});
  };
  assert.equal((await classifyCampaignPost({body:'A role guide'},rubric,'test',fetcher)).status,'review');
});

test('admin authenticates before reading or changing moderation state', async context => {
  const { call, login } = fixture(context);
  assert.equal((await call('/api/admin?view=ranking')).status, 401);
  assert.equal((await call('/api/admin?view=profile&creator=11')).status, 401);
  assert.equal((await call('/api/admin', { action: { action: 'login', key: 'ff'.repeat(32) } })).status, 401);
  assert.equal((await call('/api/admin', { action: { action: 'login', key }, unrelatedOrigin: 'https://other.example' })).status, 403);
  await login();
  assert.deepEqual(await data(await call('/api/admin?view=session')), { authenticated: true });
  const forgedCookie = '__Host-entropy-admin=' + (Math.floor(Date.now() / 1000) + 600) + '.12345678-0000-0000-0000-123456789abc.' + key;
  assert.equal((await call('/api/admin?view=ranking', { forgedCookie })).status, 401);
  assert.equal((await call('/api/admin', { action: { action: 'review' }, unrelatedOrigin: 'https://other.example' })).status, 403);
  const logout = await call('/api/admin', { action: { action: 'logout' } });
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('exclude and restore affect the current ranking while posts and private action history persist', async context => {
  const { call, login, db } = fixture(context);
  const initial = await data(await call('/api/leaderboard?view=ranking'));
  assert.equal(initial.totals.posts, 2);
  assert.equal(initial.rows[0].author.id, '11');
  await login();
  const profile = await data(await call('/api/admin?view=profile&creator=11'));
  const input = { action: 'exclude', creator: '11', postId: '111', snapshotId: profile.snapshotId, reason };
  assert.equal((await call('/api/admin', { action: { ...input, reason: '  ' } })).status, 400);
  assert.equal((await call('/api/admin', { action: { ...input, postId: '222' } })).status, 404);
  const concurrent = await Promise.all([call('/api/admin', { action: input }), call('/api/admin', { action: input })]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
  const excluded = await data(await call('/api/leaderboard?view=ranking'));
  assert.equal(excluded.totals.posts, 1);
  assert.equal(excluded.totals.views, 80);
  assert.equal(excluded.leaders[0].author.id, '22');
  assert.equal((await call('/api/leaderboard?view=profile&creator=11')).status, 404);
  assert(!JSON.stringify(await data(await call('/api/leaderboard'))).includes(reason));
  const adminRank = await data(await call('/api/admin?view=ranking&q=alice'));
  assert.equal(adminRank.rows[0].rank, null);
  const moderated = await data(await call('/api/admin?view=profile&creator=11'));
  assert.equal(moderated.posts[0].body, profile.posts[0].body);
  assert.equal(moderated.posts[0].exclusion.reason, reason);
  assert.deepEqual(moderated.totals, { posts: 0, views: 0, likes: 0 });
  assert.equal(moderated.history[0].actorId, 'moderator');
  await data(await call('/api/admin', { action: { ...input, action: 'restore' } }));
  assert.equal((await data(await call('/api/leaderboard?view=ranking'))).totals.posts, 2);
  const restored = await data(await call('/api/admin?view=profile&creator=11'));
  assert.equal(restored.posts[0].exclusion, null);
  assert.deepEqual(restored.totals, profile.totals);
  assert.deepEqual(new Set(restored.history.map(event => event.action)), new Set(['restore', 'exclude']));
  assert(restored.history.every(event => event.reason === reason));
  assert.equal(db.prepare("SELECT count(*) AS count FROM entropy_records WHERE kind='post'").get().count, 2);
});

test('review versions change with creator content and survive metric refreshes', async context => {
  const { call, login, savePost } = fixture(context);
  await login();
  const profile = await data(await call('/api/admin?view=profile&creator=11'));
  const review = { action: 'review', creator: '11', snapshotId: profile.snapshotId };
  await data(await call('/api/admin', { action: review }));
  const reviewed = await data(await call('/api/admin?view=ranking&status=reviewed'));
  assert.equal(reviewed.rows[0].review.status, 'reviewed');
  assert.equal(reviewed.rows[0].review.snapshotId, profile.snapshotId);
  assert.equal(reviewed.rows[0].review.datasetAsOf, asOf);
  const publicReview = (await data(await call('/api/leaderboard?view=ranking'))).rows[0];
  assert(publicReview.reviewedAt);
  assert(!Object.hasOwn(publicReview, 'review'));
  savePost('111', '11', profile.posts[0].body, 200);
  assert((await data(await call('/api/leaderboard?view=ranking'))).rows[0].reviewedAt);
  savePost('111', '11', 'Updated @entropyIO post', 200);
  assert.equal((await data(await call('/api/leaderboard?view=ranking'))).rows[0].reviewedAt, null);
  const pending = await data(await call('/api/admin?view=ranking&status=needs-review'));
  assert.equal(pending.rows[0].review.snapshotId, profile.snapshotId);
  assert.equal((await call('/api/admin', { action: review })).status, 409);
  const edited = await data(await call('/api/admin?view=profile&creator=11'));
  await data(await call('/api/admin', { action: { ...review, snapshotId: edited.snapshotId } }));
  savePost('112', '11', 'New @entropyIO post', 50);
  const withNewPost = await data(await call('/api/admin?view=profile&creator=11'));
  assert.equal(withNewPost.review.status, 'needs-review');
  assert.equal(withNewPost.totalPosts, 2);
  assert.equal(withNewPost.history.filter(event => event.action === 'review').length, 2);
});
