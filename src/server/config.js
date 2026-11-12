import Schema from './vendor/schema.js';
import { validateLarkSettings } from './lark-settings.js';
import time from '../shared/time.cjs';
import general from '../shared/general.cjs';
import { DEFAULT_SYNC_SETTINGS } from './knowledge-v2/sync-settings.js';
/** Profile-owned validated configuration; installation sources are read-only. */
import { readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, resolve, dirname, isAbsolute, win32 } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const LEGACY_FILE = resolve(import.meta.dirname, '../../config.json');
const DEFAULTS = {
  docsDir: 'docs',
  workspaceId: null,
  developerName: null,
  requirementId: null,
  general: { timeZone: 'Asia/Shanghai', ...general.GENERAL_DEFAULTS },
  knowledgeV2: { ...DEFAULT_SYNC_SETTINGS },
};
let declared = {};
let storageOverride;
/**
 * Locate the profile-owned configuration file.
 * @returns The absolute configuration path.
 */
export function configFilePath() {
  if (storageOverride) {
    return storageOverride;
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profile =
    process.env.DSH_PROFILE_DIR ||
    (process.env.DSH_PROFILE ? join(home, 'profiles', process.env.DSH_PROFILE) : home);
  return join(profile, 'req-hub', 'config.json');
}
function validate(value) {
  const issues = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { issues: [{ message: 'configuration must be an object' }] };
  }
  try {
    time.configTimeZone(value);
  } catch {
    issues.push({ message: 'TIME_ZONE_INVALID', path: ['general', 'timeZone'] });
  }
  if (value.lark !== undefined) {
    try {
      validateLarkSettings(value.lark);
    } catch {
      issues.push({ message: 'LARK_CONFIG_INVALID', path: ['lark'] });
    }
  }
  const string = (object, key, nullable = false) => {
    if (
      object[key] !== undefined &&
      !(nullable && object[key] === null) &&
      typeof object[key] !== 'string'
    ) {
      issues.push({ message: key + ' must be a string', path: [key] });
    }
  };
  for (const key of ['workspaceId', 'developerName', 'requirementId']) {
    string(value, key, true);
  }
  string(value, 'docsDir');
  string(value, 'defaultUsername');
  if (
    typeof value.docsDir === 'string' &&
    (!value.docsDir.trim() ||
      isAbsolute(value.docsDir) ||
      win32.isAbsolute(value.docsDir) ||
      value.docsDir.split(/[\\/]/).includes('..'))
  ) {
    issues.push({ message: 'docsDir must stay inside the workspace', path: ['docsDir'] });
  }
  for (const key of [
    'ai',
    'sync',
    'conversations',
    'enhancements',
    'knowledgeV2',
    'lark',
    'larkTargets',
  ]) {
    if (
      value[key] !== undefined &&
      (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))
    ) {
      issues.push({ message: key + ' must be an object', path: [key] });
    }
  }
  if (value.ai && typeof value.ai === 'object') {
    string(value.ai, 'selectedModel', true);
    if (value.ai.enabled !== undefined && typeof value.ai.enabled !== 'boolean') {
      issues.push({ message: 'ai.enabled must be boolean', path: ['ai', 'enabled'] });
    }
    for (const prompts of [value.ai.prompts, value.ai.syncV2?.prompts]) {
      if (
        prompts !== undefined &&
        (!prompts ||
          typeof prompts !== 'object' ||
          Array.isArray(prompts) ||
          Object.values(prompts).some((v) => typeof v !== 'string'))
      ) {
        issues.push({ message: 'prompt overrides must map keys to strings', path: ['ai'] });
      }
    }
    if (
      value.ai.delegation !== undefined &&
      (!value.ai.delegation ||
        typeof value.ai.delegation !== 'object' ||
        Array.isArray(value.ai.delegation))
    ) {
      issues.push({ message: 'ai.delegation must be an object', path: ['ai', 'delegation'] });
    }
  }
  return issues.length ? { issues } : { value: structuredClone(value) };
}
// Native graph metadata supports Cordis validation and host schema inspection.
const nullableString = () => Schema.union([String, Schema.const(null)]);
export const Config = Schema.object({
  general: Schema.object({
    timeZone: Schema.string().default('Asia/Shanghai'),
    taskTimeoutMs: Schema.natural().min(30000).max(3600000).default(1200000),
    knowledgeMaxInputBytes: Schema.natural().min(1000).max(20000000).default(2000000),
    knowledgeMaxResultBytes: Schema.natural().min(1000).max(1000000).default(250000),
  }).default(undefined),
  docsDir: Schema.string()
    .min(1)
    .pattern(/^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^:]+$/),
  workspaceId: nullableString(),
  developerName: nullableString(),
  requirementId: nullableString(),
  defaultUsername: Schema.string()
    .max(64)
    .pattern(/^(?!\.)(?!.*\.\.)[^\s\\/~^:?*\[\]\x00-\x20\x7f]*$/)
    .default(undefined),
  lark: Schema.object({
    executable: Schema.string().min(1).max(1024).default('lark-cli'),
    profile: Schema.string()
      .max(64)
      .pattern(/^[A-Za-z0-9_-]*$/)
      .default(''),
    identity: Schema.union(['user', 'bot']).default('user'),
    timeoutMs: Schema.natural().min(1000).max(120000).default(30000),
  }).default(undefined),
  larkTargets: Schema.dict(
    Schema.object({
      workspaceRoot: Schema.string().min(1),
      useDefault: Schema.boolean().default(undefined),
      kind: Schema.union(['folder', 'wiki']),
      token: Schema.string().min(1).max(256),
      url: Schema.string().min(1).max(2048),
      title: Schema.string().min(1).max(1024),
      spaceId: Schema.string(),
      objToken: Schema.string(),
      objType: Schema.string(),
      appId: Schema.string().min(1),
      accountId: Schema.string().min(1),
      profile: Schema.string().max(64),
      identity: Schema.union(['user', 'bot']),
      checkedAt: Schema.string().min(1),
    }),
  ).default(undefined),
  ai: Schema.object({
    enabled: Schema.boolean(),
    selectedModel: nullableString(),
    prompts: Schema.dict(String).default(undefined),
    skillBindings: Schema.dict(nullableString()).default(undefined),
    syncV2: Schema.object({
      prompts: Schema.dict(String).default(undefined),
      skillBindings: Schema.dict(nullableString()).default(undefined),
      contractVersion: Schema.const(2).default(undefined),
    }).default(undefined),
    delegation: Schema.object({
      maxConcurrency: Schema.natural().min(1).max(16).default(3),
      provider: Schema.string(),
      agentOptions: Schema.dict(Schema.any()).default(undefined),
      liveness: Schema.dict(Schema.any()).default(undefined),
    }).default(undefined),
  }).default(undefined),
  knowledgeV2: Schema.object({
    autoManage: Schema.boolean().default(DEFAULT_SYNC_SETTINGS.autoManage),
    autoManageDelayMs: Schema.natural()
      .max(3600000)
      .default(DEFAULT_SYNC_SETTINGS.autoManageDelayMs),
    dailyUpdateEnabled: Schema.boolean().default(DEFAULT_SYNC_SETTINGS.dailyUpdateEnabled),
    dailyImportConversations: Schema.boolean().default(
      DEFAULT_SYNC_SETTINGS.dailyImportConversations,
    ),
    dailyUpdateTime: Schema.string()
      .pattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .default(DEFAULT_SYNC_SETTINGS.dailyUpdateTime),
  }).default(undefined),
  enhancements: Schema.object({
    enabled: Schema.boolean().default(false),
    maxInvalidOutputWrites: Schema.natural().min(1).max(10).default(3),
    maxConcurrentJobs: Schema.natural().min(1).max(8).default(2),
    maxDocuments: Schema.natural().min(1).max(200).default(30),
    maxNodes: Schema.natural().min(1).max(1000).default(200),
    maxEdges: Schema.natural().min(1).max(10000).default(1000),
    maxDepth: Schema.natural().min(1).max(10).default(5),
    retainedJobs: Schema.natural().min(1).max(500).default(50),
    retainedRevisions: Schema.natural().min(1).max(10).default(3),
    gitnexusServer: Schema.string()
      .pattern(/^[A-Za-z0-9_-]{1,32}$/)
      .default('gitnexus'),
    indexTimeoutMs: Schema.natural().min(1000).max(21_600_000).default(1_800_000),
    indexWorkers: Schema.natural().min(1).max(8).default(2),
    indexWorkerReadyTimeoutMs: Schema.natural().min(1000).max(300000).default(60000),
    maxCodeQueries: Schema.natural().min(1).max(100).default(20),
  }).default(undefined),
  conversations: Schema.object({
    retainedVersions: Schema.natural().min(1).default(3),
    versionRetentionDays: Schema.natural().min(1).default(7),
    missingRetentionDays: Schema.natural().default(30),
    jobRetentionDays: Schema.natural().min(1).default(7),
    retainedJobs: Schema.natural().min(1).default(100),
    graceHours: Schema.natural().default(1),
  }).default(undefined),
  sync: Schema.object({
    dailyUpdateEnabled: Schema.boolean().default(false),
    dailyUpdateTime: Schema.string()
      .pattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .default('03:00'),
    dailyOffsetDays: Schema.natural().max(365).default(1),
    baseBranch: Schema.string(),
    maxAnalysisReadPages: Schema.natural().min(8).max(1024).default(undefined),
    maxCompletionReminders: Schema.natural().max(5).default(3),
    maxInvalidOutputWrites: Schema.natural().min(1).max(20).default(6),
    retentionDays: Schema.natural().default(0),
    retainedAttempts: Schema.natural().default(0),
    capacityBytes: Schema.natural().default(0),
  }).default(undefined),
});
function checked(value) {
  value = general.withoutIndependentSettings(value);
  // Legacy wiki automation is fully superseded by Knowledge V2; drop the
  // section instead of migrating its values or keeping it as an unknown key.
  if (value?.wiki !== undefined) {
    delete value.wiki;
  }
  for (const section of ['knowledgeV2', 'sync']) {
    if (value?.[section] && typeof value[section] === 'object') {
      delete value[section].dailyUpdateTimeZone;
    }
  }
  const initial = validate(value);
  if (initial.issues) {
    throw Object.assign(
      new Error('INVALID_CONFIG: ' + initial.issues.map((issue) => issue.message).join('; ')),
      { status: 400 },
    );
  }
  const native = Config['~standard'].validate(value);
  const result = native.issues ? native : validate(native.value);
  if (result.issues) {
    throw Object.assign(
      new Error('INVALID_CONFIG: ' + result.issues.map((issue) => issue.message).join('; ')),
      { status: 400 },
    );
  }
  return result.value;
}
/**
 * Validate deployment overrides and select configuration storage.
 * @param [config] - Validated plugin configuration.
 * @param [options] - Optional configuration-file override.
 * @returns A disposer that restores the previous overrides and storage path.
 */
export function configureStorage(config = {}, { filePath } = {}) {
  const previous = { declared, storageOverride };
  declared = checked(config);
  storageOverride = filePath;
  return () => {
    declared = previous.declared;
    storageOverride = previous.storageOverride;
  };
}
/**
 * Load validated settings, applying declared deployment overrides last. Invalid JSON or schema values reject.
 * @returns Validated effective configuration.
 */
export async function loadConfig() {
  const target = configFilePath();
  if (existsSync(target)) {
    return { ...DEFAULTS, ...checked(JSON.parse(await readFile(target, 'utf8'))), ...declared };
  }
  // Migrate once without changing the old installation. A bad legacy file is an error.
  if (existsSync(LEGACY_FILE)) {
    const migrated = checked(JSON.parse(await readFile(LEGACY_FILE, 'utf8')));
    await saveConfig(migrated);
    return { ...DEFAULTS, ...migrated, ...declared };
  }
  return { ...DEFAULTS, ...declared };
}
/**
 * Validate and atomically replace the profile-owned settings file.
 * @param config - Validated plugin configuration.
 * @returns Completion after the replacement is saved.
 */
export async function saveConfig(config) {
  const value = checked(config);
  const target = configFilePath();
  await mkdir(dirname(target), { recursive: true });
  const temporary = target + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, target);
}

/**
 * Auto-set default configuration values based on workspace structure.
 * Automatically selects first workspace, developer, and requirement if not set.
 * @param {PluginConfig} config - Current configuration
 * @param {Object} registry - Workspace registry service
 * @returns {Promise<PluginConfig>} Updated configuration with defaults
 */
export async function autoDefaultConfig(config, registry) {
  const workspaces = registry.list();
  if (workspaces.length === 0) {
    return config;
  }

  // Auto-select first workspace if not set
  if (!config.workspaceId || !workspaces.find((w) => w.id === config.workspaceId)) {
    config.workspaceId = workspaces[0].id;
  }

  // Auto-select first developer if not set
  const workspace = workspaces.find((w) => w.id === config.workspaceId);
  if (workspace) {
    const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
    try {
      const entries = await readdir(docsRoot, { withFileTypes: true });
      const devDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
      if (devDirs.length > 0 && !config.developerName) {
        config.developerName = devDirs[0].name;
      }

      // Auto-select first requirement if not set
      if (config.developerName) {
        const devPath = join(docsRoot, config.developerName);
        const reqEntries = await readdir(devPath, { withFileTypes: true });
        const reqDirs = reqEntries.filter(
          (e) => e.isDirectory() && /^(\d{4}-\d{2}-\d{2})-(.+)$/.test(e.name),
        );
        if (reqDirs.length > 0 && !config.requirementId) {
          config.requirementId = reqDirs[0].name;
        }
      }
    } catch (error) {
      // Automatic selection is optional; retain the configured values when discovery fails.
    }
  }

  return config;
}
