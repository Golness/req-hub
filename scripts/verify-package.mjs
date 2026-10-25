import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const owned = join(root, '.req-hub');
await mkdir(owned, { recursive: true });
const fixture = await mkdtemp(join(owned, 'package-verification-'));
function contained(path) { const rel = relative(owned, resolve(path)); assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'temporary path escaped workspace'); return path; }
try {
  assert(process.env.npm_execpath, 'Run using npm run verify:package');
  const [packed] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', fixture, '--cache', join(owned, 'npm-review-cache')], { cwd: root, encoding: 'utf8' }));
  const files = new Set(packed.files.map(file => file.path));
  for (const file of ['cordis.patch.yml', 'src/server/index.js', 'src/server/vendor/schema.js', 'src/shared/sync-task.cjs', 'lib/client.js', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'DSH-UI-NOTICE.md']) assert(files.has(file), 'missing packaged resource: ' + file);
  execFileSync('tar', ['-xf', contained(join(fixture, packed.filename)), '-C', fixture]);
  const target = contained(join(fixture, 'node_modules/@local/req-hub'));
  await mkdir(dirname(target), { recursive: true });
  await rename(contained(join(fixture, 'package')), target);
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'req-hub-package-verification', private: true }));
  const installedRequire = createRequire(join(fixture, 'package.json'));
  const serverEntry = installedRequire.resolve('@local/req-hub');
  assert(serverEntry.startsWith(target), 'resolved source checkout instead of installed artifact');
  const plugin = await import(pathToFileURL(serverEntry).href);
  assert.equal(typeof plugin.apply, 'function');
  assert(plugin.Config[Symbol.for('schemastery')], 'Config must support native Host schema inspection');
  assert(plugin.Config['~standard'].validate({ docsDir: '../escape' }).issues);
  const source = await readFile(join(target, 'lib/client.js'), 'utf8');
  assert(!/(?:require|import)\s*\(\s*['"]@deepseek-ai\/dsh-client-/.test(source), 'forbidden Harness Client runtime import');
  let client;
  runInNewContext(source, { window: { __ModuleLoader__: { load(row) { client = row; } } } });
  assert.equal(client.id, '@local/req-hub');
  assert.equal(typeof client.factory(installedRequire).apply, 'function');
  for (const lang of ['en', 'zh']) assert(JSON.parse(await readFile(join(target, 'locale', lang + '.json'), 'utf8')).meta.title);
  const result = { status: 'passed', files: files.size, serverArtifactImport: true, clientFactory: true, nativeConfig: true, bundlePatch: true, forbiddenClientImports: false };
  await writeFile(join(owned, 'package-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await rm(contained(fixture), { recursive: true, force: true }); }
