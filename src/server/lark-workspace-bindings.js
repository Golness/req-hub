import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { larkTargetRevision } from './lark-target.js';
import { validateLarkSettings } from './lark-settings.js';
import { ensureLarkWorkspaceNode } from './lark-workspace-node.js';

/**
 * Version the complete registered workspace set and its destination bindings.
 * @param workspaces - Host registry entries, independent of the selected workspace.
 * @param config - Current saved configuration.
 * @returns An optimistic revision for an all-workspace save.
 */
export function larkWorkspacesRevision(workspaces, config) {
  const entries = workspaces
    .map((item) => ({
      id: item.id,
      title: item.title || item.id,
      path: item.path,
      revision: larkTargetRevision(config.larkTargets?.[item.id]),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256')
    .update(JSON.stringify({ entries, lark: validateLarkSettings(config.lark) }))
    .digest('hex');
}

/**
 * List bindings for registered workspaces without contacting Feishu or hiding stale bindings.
 * @param registry - Authoritative Host workspace registry.
 * @param config - Saved connection and publication bindings.
 * @param signal - Request-owned cancellation checked around filesystem reads.
 * @returns Workspace paths, bindings and optimistic revisions for row-level removal.
 */
export async function listLarkWorkspaceBindings(registry, config, signal) {
  const items = [];
  for (const workspace of registry.list()) {
    signal.throwIfAborted();
    const binding = config.larkTargets?.[workspace.id] || null;
    let bindingCurrent = false;
    if (binding) {
      try {
        bindingCurrent = (await realpath(workspace.path)) === binding.workspaceRoot;
      } catch {
        // Keep inaccessible or moved roots visible so the user can remove their stale bindings.
      }
    }
    signal.throwIfAborted();
    items.push({
      id: workspace.id,
      title: workspace.title || workspace.id,
      path: workspace.path,
      binding,
      bindingCurrent,
      revision: larkTargetRevision(binding),
    });
  }
  return { items, defaultRevision: larkWorkspacesRevision(registry.list(), config) };
}

/**
 * Prepare a Wiki root page for every registered workspace and commit all local bindings.
 * @param options - Registry, saved settings, selected space, expected revision and owned I/O.
 * @returns Batch counts and bindings; failure preserves local bindings and reports the stage
 * and remote progress without exposing raw CLI messages or filesystem paths.
 */
export async function bindAllLarkWorkspaces({
  registry,
  settings,
  spaceId,
  expectedRevision,
  loadConfig,
  saveConfig,
  execute,
  signal,
}) {
  // Host workspace properties may be prototype getters, so project them explicitly.
  const entries = registry.list().map((item) => ({
    id: item.id,
    title: item.title || item.id,
    path: item.path,
  }));
  if (!entries.length) {
    throw new Error('LARK_WORKSPACE_INVALID');
  }
  const names = new Set();
  for (const item of entries) {
    if (names.has(item.title)) {
      throw new Error('LARK_WORKSPACE_NAME_AMBIGUOUS');
    }
    names.add(item.title);
    if (!item.title.trim() || item.title.length > 1024) {
      throw new Error('LARK_WORKSPACE_INVALID');
    }
  }
  let completed = 0;
  let created = 0;
  let activeWorkspace = '';
  let stage = 'workspace-path';
  let remoteChangePossible = false;
  try {
    for (const item of entries) {
      signal.throwIfAborted();
      activeWorkspace = item.title;
      if (typeof item.path !== 'string' || !item.path) {
        throw new Error('LARK_WORKSPACE_INVALID');
      }
      item.root = await realpath(item.path);
    }
    activeWorkspace = '';
    stage = 'configuration';
    const validateCurrent = async () => {
      signal.throwIfAborted();
      const config = await loadConfig();
      const current = registry.list();
      if (
        larkWorkspacesRevision(current, config) !== expectedRevision ||
        JSON.stringify(validateLarkSettings(config.lark)) !== JSON.stringify(settings)
      ) {
        throw new Error('LARK_TARGET_CONFLICT');
      }
      for (const item of entries) {
        if ((await realpath(item.path)) !== item.root) {
          throw new Error('LARK_WORKSPACE_INVALID');
        }
      }
      signal.throwIfAborted();
      return config;
    };
    await validateCurrent();
    const prepared = new Map();
    for (const item of entries) {
      activeWorkspace = item.title;
      stage = 'configuration';
      await validateCurrent();
      const result = await ensureLarkWorkspaceNode(
        settings,
        spaceId,
        item.title,
        async (...args) => {
          const command = args[1];
          if (command.includes('auth')) {
            stage = 'authentication';
          } else if (command.includes('+node-list')) {
            stage = 'list-nodes';
          } else if (command.includes('+node-create')) {
            stage = 'create-node';
          } else {
            stage = 'verify-node';
          }
          return execute(...args);
        },
        signal,
        validateCurrent,
      );
      prepared.set(item.id, { ...result.target, workspaceRoot: item.root });
      if (result.created) {
        created += 1;
        remoteChangePossible = true;
      }
      completed += 1;
    }
    stage = 'configuration';
    const config = await validateCurrent();
    const targets = Object.assign(Object.create(null), config.larkTargets);
    for (const [id, binding] of prepared) {
      targets[id] = binding;
    }
    signal.throwIfAborted();
    const next = { ...config, larkTargets: targets };
    stage = 'save-bindings';
    await saveConfig(next);
    return {
      targets,
      total: entries.length,
      created,
      reused: entries.length - created,
      defaultRevision: larkWorkspacesRevision(entries, next),
    };
  } catch (error) {
    const filesystemCode = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'ENOSPC'].includes(
      error.code,
    )
      ? error.code
      : null;
    if (!/^LARK_[A-Z_]+$/.test(error.message)) {
      error.message = 'LARK_TARGET_FAILED';
    }
    error.details = {
      ...error.details,
      stage,
      ...(filesystemCode ? { filesystemCode } : {}),
      ...(remoteChangePossible ? { remoteChangePossible: true } : {}),
      batch: { total: entries.length, completed, created, failedWorkspace: activeWorkspace },
    };
    throw error;
  }
}
