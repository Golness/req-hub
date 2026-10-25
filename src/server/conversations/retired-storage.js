import { lstat, realpath, rm, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { safeDocumentPath } from '../safe-path.js';
import { atomicWrite } from '../sync-document-validator.js';

/** Explicit retirement, never an import or format compatibility layer. */
export async function removeRetiredCodexStore(globalHome) {
  const base = resolve(globalHome, 'req-hub'), target = resolve(base, 'codex');
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error('RETIRED_STORE_SYMLINK');
    const actualBase = await realpath(base), actual = await realpath(target);
    const normalize = path => process.platform === 'win32' ? path.toLowerCase() : path;
    if (normalize(actual) !== normalize(join(actualBase, 'codex'))) throw new Error('RETIRED_STORE_PATH');
    await rm(target, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Remove only the retired conversation input, retain published docs and code artifacts. */
export async function removeRetiredTaskConversations(requirementPath, task) {
  if (task.conversationStorageVersion === 1 || !task.sessionIds?.length) return false;
  if (!/^v2\/[\w.-]+\/[\w-]+$/.test(task.snapshotDir || '')) throw new Error('RETIRED_SESSION_PATH');
  const input = await safeDocumentPath(requirementPath, `sync-logs/${task.snapshotDir}/input`, { allowMissing: true });
  const directory = await safeDocumentPath(requirementPath, `sync-logs/${task.snapshotDir}/input/sessions`, { allowMissing: true });
  // safeDocumentPath resolves ancestor links and rejects targets outside the requirement.
  await rm(directory, { recursive: true, force: true });
  const manifest = join(input, 'manifest.json');
  try {
    await safeDocumentPath(requirementPath, `sync-logs/${task.snapshotDir}/input/manifest.json`);
    const data = JSON.parse(await readFile(manifest, 'utf8'));
    data.artifacts = (data.artifacts || []).filter(item => !item.file?.startsWith('sessions/'));
    await atomicWrite(manifest, Buffer.from(JSON.stringify(data, null, 2)));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  task.sessionIds = []; task.sessionSnapshots = []; task.sessionEvidenceRemoved = true;
  const retained = name => !String(name).replaceAll('\\', '/').includes('/input/sessions/');
  task.generatedFiles = (task.generatedFiles || []).filter(file => retained(file.fileName));
  for (const step of task.steps || []) { step.files = (step.files || []).filter(retained); }
  return true;
}

export async function clearRetiredWorkspaceConversations(workspaceRoot, docsDir) {
  const docs = await safeDocumentPath(workspaceRoot, docsDir || 'docs', { allowMissing: true });
  const visit = async directory => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (entries.some(entry => entry.name === 'sync-logs' && entry.isDirectory())) {
      const stateFile = await safeDocumentPath(directory, 'sync-logs/v2/.sync-state.json', { allowMissing: true });
      try {
        const state = JSON.parse(await readFile(stateFile, 'utf8')); let changed = false;
        for (const task of [...state.history || [], ...state.activeSync ? [state.activeSync] : []]) changed = await removeRetiredTaskConversations(directory, task) || changed;
        if (changed) await atomicWrite(stateFile, Buffer.from(JSON.stringify(state, null, 2)));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ['sync-logs', '.git', 'node_modules'].includes(entry.name)) continue;
      await visit(await safeDocumentPath(docs, join(directory === docs ? '' : directory.slice(docs.length + 1), entry.name)));
    }
  };
  await visit(docs);
}
