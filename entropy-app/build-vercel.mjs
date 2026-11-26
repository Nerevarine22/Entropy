import { copyFile, mkdir, readdir, unlink } from 'node:fs/promises';

const assets = ['experience.css', 'experience.js', 'entropy-logo.png', 'source-sans-3-latin.woff2', 'source-sans-3-OFL.txt'];
const output = new URL('./dist/', import.meta.url);

await mkdir(output, { recursive: true });
const allowed = new Set(['index.html', ...assets]);
for (const item of await readdir(output, { withFileTypes: true })) {
  if (item.isFile() && ['model.js', 'scoring.js'].includes(item.name)) {
    await unlink(new URL(item.name, output));
    continue;
  }
  if (!item.isFile() || !allowed.has(item.name)) throw new Error('Unexpected item in the public output directory: ' + item.name);
}
await Promise.all(assets.map(name => copyFile(new URL(name, import.meta.url), new URL(name, output))));
await copyFile(new URL('./experience.html', import.meta.url), new URL('index.html', output));
