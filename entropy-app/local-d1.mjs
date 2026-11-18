// Local preview only: read the same SQLite file created by Wrangler's D1 emulator.
import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Model = require('./model.js');
const dbDir = path.join(root, '..', 'entropy-cloud', '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
async function openDb() {
  const files = (await readdir(dbDir)).filter(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (files.length !== 1) throw new Error('Expected exactly one local D1 database.');
  return new DatabaseSync(path.join(dbDir, files[0]));
}
export function localD1Binding(db) {
  const statement = (sql, values = []) => ({
    bind: (...parameters) => statement(sql, parameters),
    all: () => ({ results: db.prepare(sql).all(...values) }),
    first: () => db.prepare(sql).get(...values) ?? null,
    run: () => ({ meta: { changes: db.prepare(sql).run(...values).changes } }),
  });
  return {
    prepare: statement,
    batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(query => query.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
export async function withLocalD1(use) {
  const db = await openDb();
  try {
    return await use(localD1Binding(db));
  } finally {
    db.close();
  }
}
export async function readLocalDataset() {
  let db;
  try {
    db = await openDb();
    const rows = db.prepare("SELECT kind, payload FROM entropy_records WHERE generation = (SELECT generation FROM entropy_control WHERE id='main') AND chunk_index=0 ORDER BY kind, record_id").all();
    if (!rows.length) return null;
    const data = { meta: {}, authors: [], posts: [], accounts: [], followRelations: [], interactions: [] };
    for (const row of rows) {
      const value = JSON.parse(row.payload);
      if (row.kind === 'dataset-meta') data.meta = value;
      else if (row.kind === 'author') data.authors.push(value);
      else if (row.kind === 'post') data.posts.push(value);
    }
    return Model.validateDataset(data);
  } finally { db?.close(); }
}

export async function saveTwitterScore(authorId, smartFollowers, checkedAt) {
  if (typeof authorId !== 'string' || !/^\d+$/.test(authorId)) throw new Error('Expected a numeric X user ID.');
  if (smartFollowers !== null && (!Number.isSafeInteger(smartFollowers) || smartFollowers < 0)) throw new Error('Invalid Smart Followers count.');
  if (!Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid Smart Followers observation time.');
  const db = await openDb();
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const control = db.prepare("SELECT generation,lease_token,lease_until FROM entropy_control WHERE id='main'").get();
      if (!control || (control.lease_token && control.lease_until > Date.now())) throw new Error('The local database is unavailable or busy.');
      const result = db.prepare(`
        UPDATE entropy_records
        SET payload = json_set(payload, '$.twitterScore', json(?))
        WHERE generation = ? AND kind = 'author' AND record_id = ? AND chunk_index = 0
          AND NOT EXISTS (
            SELECT 1 FROM entropy_records AS chunk
            WHERE chunk.generation = entropy_records.generation AND chunk.kind = 'author'
              AND chunk.record_id = entropy_records.record_id AND chunk.chunk_index > 0
          )
      `).run(JSON.stringify({ smartFollowers, checkedAt }), control.generation, authorId);
      if (result.changes !== 1) throw new Error('The creator record is unavailable for update.');
      db.prepare("UPDATE entropy_control SET revision = revision + 1, updated_at = ? WHERE id = 'main'").run(checkedAt);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function importEarlyCreatorPosts(raw) {
  const dataset = Model.validateDataset(raw);
  if (dataset.posts.some(post => !Model.isEarlyCreatorPost(post))) throw new Error('The import contains a post outside the Early window.');
  return insertCollectedPosts(dataset);
}

export async function importCollectedPosts(raw) {
  const dataset = Model.validateDataset(raw);
  if (dataset.posts.some(post => post.isReply !== false || !/^\d+$/.test(post.id) || !/^\d+$/.test(post.authorId))) {
    throw new Error('The import requires X posts with numeric IDs and an explicit non-reply status.');
  }
  return insertCollectedPosts(dataset);
}

async function insertCollectedPosts(dataset) {
  if (!dataset.posts.length) return { newAuthors: 0, newPosts: 0 };
  const dates = dataset.posts.map(post => post.date).sort();
  const earliest = dates[0];
  const endExclusive = new Date(Date.parse(dates.at(-1) + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const observedAt = dataset.meta.asOf;
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid observation timestamp.');

  const db = await openDb();
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const control = db.prepare("SELECT generation,lease_token,lease_until FROM entropy_control WHERE id='main'").get();
      if (!control || (control.lease_token && control.lease_until > Date.now())) throw new Error('The local database is unavailable or busy.');

      // Preserve existing authors, including their newer avatar and Smart Followers data.
      const insert = db.prepare(`
        INSERT INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at)
        VALUES (?,?,?,0,?,?) ON CONFLICT(generation,kind,record_id,chunk_index) DO NOTHING
      `);
      const store = (kind, value) => insert.run(control.generation, kind, value.id, JSON.stringify(value), Date.now()).changes;
      const newAuthors = dataset.authors.reduce((count, author) => count + store('author', author), 0);
      const newPosts = dataset.posts.reduce((count, post) => count + store('post', post), 0);
      if (newPosts > 0) {
        const meta = db.prepare(`
          UPDATE entropy_records SET payload=json_set(payload,
            '$.periodStart', min(coalesce(json_extract(payload,'$.periodStart'),?),?),
            '$.periodEndExclusive', max(coalesce(json_extract(payload,'$.periodEndExclusive'),?),?),
            '$.asOf', max(coalesce(json_extract(payload,'$.asOf'),?),?))
          WHERE generation=? AND kind='dataset-meta' AND record_id='main' AND chunk_index=0
        `).run(earliest, earliest, endExclusive, endExclusive, observedAt, observedAt, control.generation);
        if (meta.changes !== 1) throw new Error('Missing local dataset metadata.');
        db.prepare("UPDATE entropy_control SET revision=revision+1,updated_at=? WHERE id='main'").run(new Date().toISOString());
      }
      db.exec('COMMIT');
      return { newAuthors, newPosts };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

async function initialize(file) {
  const sample = JSON.parse(await readFile(path.join(root, 'seed.json'), 'utf8'));
  const incoming = Model.validateDataset(JSON.parse(await readFile(file, 'utf8')));
  if (incoming.posts.some(p => p.isReply !== false)) throw new Error('Only explicitly identified non-replies can be imported.');
  const existingIds = new Set(sample.posts.map(p => p.id));
  if (incoming.posts.some(p => existingIds.has(p.id)) || incoming.authors.some(a => sample.authors.some(b => a.id === b.id || a.handle.toLowerCase() === b.handle.toLowerCase()))) throw new Error('Overlapping records need identity-aware merging.');
  const dataset = Model.validateDataset({ ...sample, authors: [...sample.authors, ...incoming.authors], posts: [...sample.posts, ...incoming.posts] });
  dataset.meta.asOf = incoming.meta.asOf;
  const db = await openDb();
  try {
    if (db.prepare("SELECT 1 FROM entropy_control WHERE id='main'").get()) throw new Error('Local database is already initialized; existing data was preserved.');
    const generation = randomUUID(), now = new Date().toISOString();
    const insert = db.prepare('INSERT INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at) VALUES (?,?,?,?,?,?)');
    db.exec('BEGIN');
    try {
      const add = (kind, id, value) => insert.run(generation, kind, id, 0, JSON.stringify(value), Date.now());
      add('dataset-meta', 'main', dataset.meta);
      for (const a of dataset.authors) add('author', a.id, a);
      for (const p of dataset.posts) add('post', p.id, p);
      add('state-meta', 'main', { version: 1, ui: Model.initialState().ui });
      add('sync', 'main', { version: 1, enabled: false, paused: false });
      db.prepare('INSERT INTO entropy_control (id,generation,revision,updated_at) VALUES (?,?,0,?)').run('main', generation, now);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    console.log(JSON.stringify({ authors: dataset.authors.length, posts: dataset.posts.length, newPosts: incoming.posts.length, avatars: incoming.authors.filter(a => a.avatarUrl).length }));
  } finally { db.close(); }
}
async function removeSample() {
  const db = await openDb();
  try {
    db.exec('BEGIN');
    try {
      const generation = db.prepare("SELECT generation FROM entropy_control WHERE id='main'").get()?.generation;
      if (!generation) throw new Error('Local database is not initialized.');
      const removePosts = db.prepare("DELETE FROM entropy_records WHERE generation=? AND kind='post' AND json_extract(payload, '$.authorId') LIKE 'sample:%'").run(generation);
      const removeAuthors = db.prepare("DELETE FROM entropy_records WHERE generation=? AND kind='author' AND record_id LIKE 'sample:%'").run(generation);
      db.prepare("UPDATE entropy_control SET revision=revision+1,updated_at=? WHERE id='main'").run(new Date().toISOString());
      db.exec('COMMIT');
      console.log(JSON.stringify({ removedPosts: Number(removePosts.changes), removedAuthors: Number(removeAuthors.changes) }));
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2] === '--remove-sample' ? removeSample() : initialize(process.argv[2]);
  action.catch(error => { console.error(error.message); process.exitCode = 1; });
}
