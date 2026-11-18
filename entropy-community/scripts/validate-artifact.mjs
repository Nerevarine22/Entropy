import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");

const [source, manifest] = await Promise.all([
  readFile(workerPath, "utf8"),
  readFile(manifestPath, "utf8"),
]);
JSON.parse(manifest);

// A data URL forces ESM parsing even though the generated output has no package.json.
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const workerModule = await import(moduleUrl);
assert.equal(
  typeof workerModule.default?.fetch,
  "function",
  `${pathToFileURL(workerPath)} must export default.fetch`,
);

console.log("Artifact is valid ESM and exports default.fetch");
const rootResponse = await workerModule.default.fetch(new Request('https://viewer.example/'), {});
assert.equal(rootResponse.status, 200);
const html = await rootResponse.text();
for (const path of ['/app.js', '/styles.css']) {
  const reference = html.match(new RegExp(`"(${path.replace('.', '\\.')}\\?v=[a-f0-9]{16})"`));
  assert.ok(reference, `Expected a versioned ${path} reference`);
  const response = await workerModule.default.fetch(new Request('https://viewer.example' + reference[1]), {});
  assert.equal(response.status, 200);
  assert.ok((await response.text()).length > 100);
}
console.log('Versioned browser assets are embedded and served successfully');
