import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const assets = ['experience.css', 'experience.js', 'entropy-logo.png', 'model.js', 'scoring.js'];
const output = new URL('./dist/', import.meta.url);
const localScripts = '<script src="seed.js"></script><script src="experience.js"></script>';
const html = await readFile(new URL('./experience.html', import.meta.url), 'utf8');
if (!html.includes(localScripts)) throw new Error('Expected the local preview scripts in experience.html.');

await mkdir(output, { recursive: true });
const allowed = new Set(['index.html', ...assets]);
for (const item of await readdir(output, { withFileTypes: true })) {
  if (!item.isFile() || !allowed.has(item.name)) throw new Error('Unexpected item in the public output directory: ' + item.name);
}
await Promise.all(assets.map(name => copyFile(new URL(name, import.meta.url), new URL(name, output))));
await writeFile(new URL('index.html', output), html.replace(localScripts, '<script src="experience.js" data-source="/api/leaderboard"></script>'));
