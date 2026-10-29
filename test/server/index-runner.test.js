import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { indexWorkspace, installedGitNexus, cliInvocation } from '../../src/server/knowledge/enhancements/index-runner.js';

let root, entry;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rh-index-'));
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  entry = join(root, 'cli.mjs');
  await writeFile(join(root, 'AGENTS.md'), 'User instructions');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const run = (signal = new AbortController().signal, progress = () => {}) => indexWorkspace(root, signal, progress, { locate: async () => ({ command: process.execPath, prefix: [entry] }) });
it('streams real CLI output, retains bounded logs and uses pure index arguments', async () => {
  await writeFile(entry, `import {writeFileSync} from 'node:fs';
    if (process.argv.includes('--help')) { console.log('--index-only --workers'); }
    else { writeFileSync('args.json',JSON.stringify(process.argv.slice(2))); writeFileSync('timeout',process.env.GITNEXUS_WORKER_READY_TIMEOUT_MS); for(let i=0;i<80;i++) console.log('line '+i); console.log('  75% | Parsing'); }
  `);
  const progress = vi.fn(); await run(undefined, progress);
  expect(JSON.parse(await readFile(join(root, 'args.json'), 'utf8'))).toEqual(['analyze', '--index-only', '--workers', '2', '--verbose']);
  const state = progress.mock.calls.at(-1)[0]; expect(state.percent).toBe(75); expect(state.logs).toHaveLength(50);
  expect(await readFile(join(root, 'timeout'), 'utf8')).toBe('60000');
  expect(state.logs.at(-1)).toBe('75% | Parsing');
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('User instructions');
});
it('resolves the command from PATH and quotes Windows shims without interpolating user arguments', async () => {
  const name = process.platform === 'win32' ? 'gitnexus.cmd' : 'gitnexus';
  await writeFile(join(root, name), '', { mode: 0o755 });
  const old = process.env.PATH; process.env.PATH = root;
  try { expect((await installedGitNexus()).command).toBe(join(root, name)); }
  finally { process.env.PATH = old; }
  const oldSystemRoot = process.env.SystemRoot; process.env.SystemRoot = oldSystemRoot || 'C:\\Windows';
  try {
    const call = cliInvocation({ command: 'C:\\Program Files\\npm\\gitnexus.cmd' }, ['analyze', '--index-only'], 'win32');
    expect(call.args.at(-1)).toBe('""C:\\Program Files\\npm\\gitnexus.cmd" analyze --index-only"');
    expect(() => cliInvocation({ command: 'C:\\bad%PATH%\\gitnexus.cmd' }, ['analyze'], 'win32')).toThrow('ENHANCEMENT_INDEX_COMMAND_INVALID');
    expect(() => cliInvocation({ command: 'C:\\npm\\gitnexus.cmd' }, ['analyze', 'a & echo bad'], 'win32')).toThrow('ENHANCEMENT_INDEX_COMMAND_INVALID');
  } finally { if (oldSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = oldSystemRoot; }
});
it('fails on old CLI before launching analysis and reports nonzero exits', async () => {
  await writeFile(entry, `console.log('old version');`);
  await expect(run()).rejects.toThrow('ENHANCEMENT_INDEX_CLI_UNSUPPORTED');
  await writeFile(entry, `if(process.argv.includes('--help')) console.log('--index-only --workers'); else { console.error('index database locked'); process.exitCode=2; }`);
  const progress = vi.fn(); await expect(run(undefined, progress)).rejects.toThrow('ENHANCEMENT_INDEX_FAILED');
  expect(progress.mock.calls.at(-1)[0].logs).toContain('index database locked');
});
it('rejects nested workspaces and a redirected index directory', async () => {
  const nested = join(root, 'nested'); await mkdir(nested);
  await expect(indexWorkspace(nested, new AbortController().signal, () => {})).rejects.toThrow('ENHANCEMENT_INDEX_ROOT_INVALID');
  await symlink(nested, join(root, '.gitnexus'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(run()).rejects.toThrow('ENHANCEMENT_INDEX_ROOT_INVALID');
});
it('cancels the process tree and waits for it to exit', async () => {
  await writeFile(entry, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    if(process.argv.includes('--help')) console.log('--index-only --workers');
    else { const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync('pid',String(child.pid)); setInterval(()=>console.log('working'),100); }
  `);
  const controller = new AbortController(), pending = run(controller.signal);
  const settled = pending.catch(error => error);
  let pid;
  await vi.waitFor(async () => { pid = Number(await readFile(join(root, 'pid'), 'utf8')); expect(pid).toBeGreaterThan(0); }, { timeout: 5000 });
  controller.abort(); expect((await settled).name).toBe('AbortError');
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
}, 15000);
it('reports missing installations instead of downloading packages', async () => {
  const old = process.env.PATH; process.env.PATH = '';
  try { await expect(installedGitNexus()).rejects.toThrow('ENHANCEMENT_INDEX_CLI_MISSING'); }
  finally { process.env.PATH = old; }
});
