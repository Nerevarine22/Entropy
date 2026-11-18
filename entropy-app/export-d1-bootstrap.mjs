import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { readLocalDataset } from './local-d1.mjs';

const output = process.argv[2];
if (!output) throw new Error('Provide a path in the ignored runtime directory for the SQL export.');
const dataset = await readLocalDataset();
if (!dataset?.posts.length || dataset.posts.some(post => post.isReply !== false)
    || dataset.authors.some(author => !/^[1-9]\d*$/.test(author.id))) {
  throw new Error('Expected a local dataset of collected X posts and authors.');
}

const generation = randomUUID();
const now = new Date();
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const uninitialized = "NOT EXISTS (SELECT 1 FROM entropy_control WHERE id = 'main')";
const records = [];
function record(kind, id, value) {
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload) > 40000) throw new Error('A record is too large for this bootstrap export.');
  records.push(`INSERT INTO entropy_records (generation,kind,record_id,chunk_index,payload,created_at)
SELECT ${[generation, kind, id].map(quote).join(', ')}, 0, ${quote(payload)}, ${now.getTime()} WHERE ${uninitialized};`);
}

record('dataset-meta', 'main', dataset.meta);
for (const author of dataset.authors) record('author', author.id, author);
for (const post of dataset.posts) record('post', post.id, post);
record('state-meta', 'main', { version: 1 });
record('sync', 'main', { version: 1, enabled: false, paused: false, status: 'disabled' });
records.push(`INSERT INTO entropy_control (id,generation,revision,updated_at)
SELECT 'main', ${quote(generation)}, 0, ${quote(now.toISOString())} WHERE ${uninitialized};`);

await writeFile(output, records.join('\n') + '\n', { flag: 'wx' });
console.log(JSON.stringify({ authors: dataset.authors.length, posts: dataset.posts.length, output }));
