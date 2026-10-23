/**
 * Configuration management module.
 * Handles loading, saving, and auto-defaulting of plugin configuration.
 * @module config
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

/** @type {string} Path to the config.json file */
const CONFIG_FILE = join(import.meta.dirname, '../../config.json');

/**
 * @typedef {Object} PluginConfig
 * @property {string} docsDir - Relative path to requirement documents directory
 * @property {string|null} workspaceId - Active workspace ID
 * @property {string|null} developerName - Current developer name
 * @property {string|null} requirementId - Active requirement ID
 * @property {Object} [ai] - AI-related configuration
 */

/**
 * Load configuration from config.json file.
 * Returns default config if file does not exist or is invalid.
 * @returns {Promise<PluginConfig>} Configuration object
 */
export async function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const text = await readFile(CONFIG_FILE, 'utf8');
      return JSON.parse(text);
    }
  } catch {
    // Fall through to default
  }
  return { docsDir: 'docs', workspaceId: null, developerName: null, requirementId: null };
}

/**
 * Save configuration to config.json file.
 * @param {PluginConfig} config - Configuration object to save
 * @returns {Promise<void>}
 */
export async function saveConfig(config) {
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
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
