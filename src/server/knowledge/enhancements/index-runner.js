import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, lstat, access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, delimiter, relative, isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fail } from './contracts.js';

const exec = promisify(execFile);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
/** Resolve the installed command from PATH, preserving its own runtime selection. */
export async function installedGitNexus() {
  const paths = (process.env.PATH || '').split(delimiter).filter(isAbsolute);
  for (const path of paths) {
    for (const name of process.platform === 'win32' ? ['gitnexus.exe', 'gitnexus.cmd', 'gitnexus.bat'] : ['gitnexus']) {
      try {
        const command = join(path, name);
        if (!(await lstat(command)).isFile() && !(await lstat(command)).isSymbolicLink()) continue;
        await access(command, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return { command };
      } catch { /* Try the next PATH command, never an unrelated Node runtime. */ }
    }
  }
  fail('ENHANCEMENT_INDEX_CLI_MISSING', 503);
}

export function cliInvocation(cli, args, platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cli.command)) {
    // cmd.exe is needed for npm's Windows shim. Only a validated executable
    // path and fixed protocol arguments enter the command line; no user content.
    if (!process.env.SystemRoot || /[%!&|<>^"\r\n]/.test(cli.command) || args.some(value => !/^[A-Za-z0-9_-]+$/.test(value))) fail('ENHANCEMENT_INDEX_COMMAND_INVALID', 400);
    return { command: join(process.env.SystemRoot, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', `""${cli.command}" ${args.join(' ')}"`], windowsVerbatimArguments: true };
  }
  return { command: cli.command, args: [...(cli.prefix || []), ...args] };
}

export async function indexWorkspace(root, signal, progress, { locate = installedGitNexus, workers = 2, readyTimeoutMs = 60000 } = {}) {
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 8 || !Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1000 || readyTimeoutMs > 300000) fail('ENHANCEMENT_INVALID_INPUT');
  signal.throwIfAborted(); progress({ stage: 'index_preparing', logs: [] });
  const actual = await realpath(root);
  const top = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: actual, signal, windowsHide: true, timeout: 10000 }).catch(error => {
    signal.throwIfAborted(); fail('ENHANCEMENT_INDEX_ROOT_INVALID', 403);
  });
  if (key(await realpath(top.stdout.trim())) !== key(actual)) fail('ENHANCEMENT_INDEX_ROOT_INVALID', 403);
  const cache = await lstat(join(actual, '.gitnexus')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (cache && (!cache.isDirectory() || cache.isSymbolicLink())) fail('ENHANCEMENT_INDEX_ROOT_INVALID', 403);
  const queue = cache ? [join(actual, '.gitnexus')] : []; let checked = 0;
  while (queue.length) {
    signal.throwIfAborted();
    for (const item of await readdir(queue.pop(), { withFileTypes: true })) {
      if (++checked > 100000) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
      if (item.isSymbolicLink()) fail('ENHANCEMENT_INDEX_ROOT_INVALID', 403);
      if (item.isDirectory()) queue.push(join(item.parentPath, item.name));
    }
  }
  const cli = await locate();
  const env = { ...process.env, GITNEXUS_WORKER_READY_TIMEOUT_MS: String(readyTimeoutMs) };
  // Older versions may not support pure index mode. Fail before writing anything.
  const helpCall = cliInvocation(cli, ['analyze', '--help']);
  const help = await exec(helpCall.command, helpCall.args, { cwd: actual, signal, env, windowsVerbatimArguments: helpCall.windowsVerbatimArguments, windowsHide: true, timeout: 15000, maxBuffer: 100000 });
  if (!help.stdout.includes('--index-only') || !help.stdout.includes('--workers')) fail('ENHANCEMENT_INDEX_CLI_UNSUPPORTED', 503);
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const call = cliInvocation(cli, ['analyze', '--index-only', '--workers', String(workers), '--verbose']);
    const child = spawn(call.command, call.args, {
      cwd: actual, env, windowsVerbatimArguments: call.windowsVerbatimArguments, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [], decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')], pending = ['', ''];
    let percent, timer, stopTask, spawnError;
    const publish = () => { timer = null; if (!signal.aborted) progress({ stage: 'index_running', ...(percent === undefined ? {} : { percent }), logs: [...logs] }); };
    const line = text => {
      const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
      if (!clean) return;
      const value = /(?:^|\s)(\d{1,3})%\s*\|/.exec(clean);
      if (value && +value[1] <= 100) percent = +value[1];
      logs.push(clean.slice(0, 600)); if (logs.length > 50) logs.shift();
      if (!timer) timer = setTimeout(publish, 200);
    };
    const receive = (index, text) => {
      pending[index] += text;
      const lines = pending[index].split(/[\r\n]+/); pending[index] = lines.pop();
      for (const value of lines) line(value);
      while (pending[index].length > 2000) { line(pending[index].slice(0, 2000)); pending[index] = pending[index].slice(2000); }
    };
    const stop = () => {
      if (stopTask || !child.pid) return;
      stopTask = process.platform === 'win32'
        ? exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }).catch(() => { child.kill(); })
        : Promise.resolve().then(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } });
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on('data', chunk => receive(0, decoders[0].write(chunk)));
    child.stderr.on('data', chunk => receive(1, decoders[1].write(chunk)));
    child.once('error', error => { spawnError = error; });
    child.once('close', async code => {
      signal.removeEventListener('abort', stop); clearTimeout(timer);
      try {
        for (let i = 0; i < 2; i++) { receive(i, decoders[i].end()); line(pending[i]); }
        clearTimeout(timer); await stopTask;
        signal.throwIfAborted(); publish();
        if (spawnError || code !== 0) fail('ENHANCEMENT_INDEX_FAILED', 502, { exitCode: code });
        resolve();
      } catch (error) { reject(error); }
    });
    publish();
  });
  signal.throwIfAborted();
}
