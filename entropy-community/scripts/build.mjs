import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const definitions = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
];
const assets = {};
for (const [path, file, type] of definitions) {
  assets[path] = { body: await readFile(resolve(root, 'public', file), 'utf8'), type };
}
// Changed assets receive a new browser cache key on every deployment.
for (const path of ['/app.js', '/styles.css']) {
  const digest = createHash('sha256').update(assets[path].body).digest('hex').slice(0, 16);
  assets['/'].body = assets['/'].body.replaceAll(`"${path}"`, `"${path}?v=${digest}"`);
}
const marker = 'const ASSETS = /*__ASSETS__*/ {};';
const worker = await readFile(resolve(root, 'worker/index.js'), 'utf8');
if (worker.split(marker).length !== 2) throw new Error('Expected one asset embedding marker');
const output = worker.replace(marker, () => `const ASSETS = ${JSON.stringify(assets)};`);
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(resolve(root, 'dist/server'), { recursive: true });
await mkdir(resolve(root, 'dist/.openai'), { recursive: true });
await writeFile(resolve(root, 'dist/server/index.js'), output);
await copyFile(resolve(root, '.openai/hosting.json'), resolve(root, 'dist/.openai/hosting.json'));
console.log('Built public viewer with embedded assets');
