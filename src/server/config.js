import Schema from './vendor/schema.js';
/** Profile-owned validated configuration; installation sources are read-only. */
import { readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, resolve, dirname, isAbsolute, win32 } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const LEGACY_FILE = resolve(import.meta.dirname, '../../config.json');
const DEFAULTS = { docsDir: 'docs', workspaceId: null, developerName: null, requirementId: null };
let declared = {};
let storageOverride;
export function configFilePath() {
  if (storageOverride) return storageOverride;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE_DIR || (process.env.DSH_PROFILE ? join(home, 'profiles', process.env.DSH_PROFILE) : home);
  return join(profile, 'req-hub', 'config.json');
}
function validate(value) {
  const issues = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'configuration must be an object' }] };
  const string = (object, key, nullable = false) => {
    if (object[key] !== undefined && !(nullable && object[key] === null) && typeof object[key] !== 'string') issues.push({ message: key + ' must be a string', path: [key] });
  };
  for (const key of ['workspaceId', 'developerName', 'requirementId']) string(value, key, true);
  string(value, 'docsDir');
  if (typeof value.docsDir === 'string' && (!value.docsDir.trim() || isAbsolute(value.docsDir) || win32.isAbsolute(value.docsDir) || value.docsDir.split(/[\\/]/).includes('..'))) issues.push({ message: 'docsDir must stay inside the workspace', path: ['docsDir'] });
  for (const key of ['ai', 'sync', 'conversations']) if (value[key] !== undefined && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) issues.push({ message: key + ' must be an object', path: [key] });
  if (value.ai && typeof value.ai === 'object') {
    string(value.ai, 'selectedModel', true);
    if (value.ai.enabled !== undefined && typeof value.ai.enabled !== 'boolean') issues.push({ message: 'ai.enabled must be boolean', path: ['ai', 'enabled'] });
    for (const prompts of [value.ai.prompts, value.ai.syncV2?.prompts]) if (prompts !== undefined && (!prompts || typeof prompts !== 'object' || Array.isArray(prompts) || Object.values(prompts).some(v => typeof v !== 'string'))) issues.push({ message: 'prompt overrides must map keys to strings', path: ['ai'] });
    if (value.ai.delegation !== undefined && (!value.ai.delegation || typeof value.ai.delegation !== 'object' || Array.isArray(value.ai.delegation))) issues.push({ message: 'ai.delegation must be an object', path: ['ai', 'delegation'] });
  }
  return issues.length ? { issues } : { value: structuredClone(value) };
}
// Native graph metadata supports Cordis validation and host schema inspection.
const nullableString = () => Schema.union([String, Schema.const(null)]);
export const Config = Schema.object({
  docsDir: Schema.string().min(1).pattern(/^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^:]+$/),
  workspaceId: nullableString(), developerName: nullableString(), requirementId: nullableString(),
  ai: Schema.object({
    enabled: Schema.boolean(), selectedModel: nullableString(), prompts: Schema.dict(String).default(undefined),
    syncV2: Schema.object({ prompts: Schema.dict(String).default(undefined) }).default(undefined),
    delegation: Schema.object({ provider: Schema.string(), timeout: Schema.natural().min(1), agentOptions: Schema.dict(Schema.any()).default(undefined), liveness: Schema.dict(Schema.any()).default(undefined) }).default(undefined),
  }).default(undefined),
  conversations: Schema.object({ retainedVersions: Schema.natural().min(1).default(3), versionRetentionDays: Schema.natural().min(1).default(7), missingRetentionDays: Schema.natural().default(30), jobRetentionDays: Schema.natural().min(1).default(7), retainedJobs: Schema.natural().min(1).default(100), graceHours: Schema.natural().default(1) }).default(undefined),
  sync: Schema.object({ baseBranch: Schema.string(), maxAnalysisReadPages: Schema.natural().min(8).max(128).default(24), maxCompletionReminders: Schema.natural().max(5).default(3), retentionDays: Schema.natural().default(0), retainedAttempts: Schema.natural().default(0), capacityBytes: Schema.natural().default(0) }).default(undefined),
});
function checked(value) {
  const initial = validate(value);
  if (initial.issues) throw Object.assign(new Error('INVALID_CONFIG: ' + initial.issues.map(issue => issue.message).join('; ')), { status: 400 });
  const native = Config['~standard'].validate(value);
  const result = native.issues ? native : validate(native.value);
  if (result.issues) throw Object.assign(new Error('INVALID_CONFIG: ' + result.issues.map(issue => issue.message).join('; ')), { status: 400 });
  return result.value;
}
export function configureStorage(config = {}, { filePath } = {}) {
  const previous = { declared, storageOverride };
  declared = checked(config); storageOverride = filePath;
  return () => { declared = previous.declared; storageOverride = previous.storageOverride; };
}
export async function loadConfig() {
  const target = configFilePath();
  if (existsSync(target)) return { ...DEFAULTS, ...checked(JSON.parse(await readFile(target, 'utf8'))), ...declared };
  // Migrate once without changing the old installation. A bad legacy file is an error.
  if (existsSync(LEGACY_FILE)) {
    const migrated = checked(JSON.parse(await readFile(LEGACY_FILE, 'utf8')));
    await saveConfig(migrated);
    return { ...DEFAULTS, ...migrated, ...declared };
  }
  return { ...DEFAULTS, ...declared };
}
export async function saveConfig(config) {
  const value = checked(config), target = configFilePath();
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
  if (workspaces.length === 0) return config;

  // Auto-select first workspace if not set
  if (!config.workspaceId || !workspaces.find(w => w.id === config.workspaceId)) {
    config.workspaceId = workspaces[0].id;
  }

  // Auto-select first developer if not set
  const workspace = workspaces.find(w => w.id === config.workspaceId);
  if (workspace) {
    const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
    try {
      const entries = await readdir(docsRoot, { withFileTypes: true });
      const devDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
      if (devDirs.length > 0 && !config.developerName) {
        config.developerName = devDirs[0].name;
      }

      // Auto-select first requirement if not set
      if (config.developerName) {
        const devPath = join(docsRoot, config.developerName);
        const reqEntries = await readdir(devPath, { withFileTypes: true });
        const reqDirs = reqEntries.filter(e => e.isDirectory() && /^(\d{4}-\d{2}-\d{2})-(.+)$/.test(e.name));
        if (reqDirs.length > 0 && !config.requirementId) {
          config.requirementId = reqDirs[0].name;
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return config;
}
