import { loadConfig, updateConfig, autoDefaultConfig } from '../config.js';
import { configRevision } from '../config-repository.js';
import { defaultSkillBindings } from '../prompts.js';
import { configureSubagentScheduler } from '../concurrency/SubagentScheduler.js';
import { validateLarkSettings } from '../lark-settings.js';
import clock from '../../shared/time.cjs';
import general from '../../shared/general.cjs';

function reject(code, status = 403) {
  throw Object.assign(new Error(code), { code, status });
}

/**
 * Share configuration operations between authenticated UI and Agent callers.
 * @param registry - Authoritative workspaces.
 * @param ctx - Host dependencies used only by this application boundary.
 * @param options - Awaited callback applying a successfully committed revision.
 * @returns Read and update methods; authority-changing settings remain user-only.
 */
export function createConfigApplication(registry, ctx, options = {}) {
  return {
    async read(input = {}, caller = {}) {
      caller.signal?.throwIfAborted();
      const saved = await loadConfig();
      const savedRevision = configRevision(saved);
      let config = await autoDefaultConfig(saved, registry);
      const parent = caller.agent;
      const workspaceId = input.workspaceId || config.workspaceId;
      const workspace = registry.list().find((item) => item.id === workspaceId);
      const scopedSkills = parent
        ? ctx.agentPresets?.serviceFor?.(parent, 'skills') || ctx.skills
        : ctx.skills;
      config = await defaultSkillBindings(config, scopedSkills, {
        cwd: parent?.session?.header?.cwd || workspace?.path,
        scope: parent,
      });
      return { status: 200, value: { ...config, _revision: savedRevision } };
    },
    async save(input, caller = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        reject('INVALID_CONFIG', 400);
      }
      const { _revision: expectedRevision, ...patch } = input;
      let previous;
      const saved = await updateConfig(
        (existing) => {
          previous = existing;
          const delegation = patch.ai?.delegation;
          const merged = general.withoutIndependentSettings({
            ...existing,
            ...patch,
            general: { ...existing.general, ...patch.general },
            sync: { ...existing.sync, ...patch.sync },
            documents: { ...existing.documents, ...patch.documents },
            dailyReports: { ...existing.dailyReports, ...patch.dailyReports },
            knowledgeV2: { ...existing.knowledgeV2, ...patch.knowledgeV2 },
            ai: {
              ...existing.ai,
              ...patch.ai,
              ...(delegation && typeof delegation === 'object' && !Array.isArray(delegation)
                ? { delegation: { ...existing.ai?.delegation, ...delegation } }
                : {}),
              prompts: { ...existing.ai?.prompts, ...patch.ai?.prompts },
            },
          });
          if (patch.larkTargets !== undefined) {
            reject('LARK_USER_REQUIRED');
          }
          if (patch.lark !== undefined) {
            if (caller.kind === 'agent') {
              reject('LARK_USER_REQUIRED');
            }
            validateLarkSettings(patch.lark);
            reject('LARK_CHECK_REQUIRED', 400);
          }
          if (caller.kind === 'agent') {
            if (
              JSON.stringify(merged.dailyReports) !== JSON.stringify(existing.dailyReports || {}) ||
              JSON.stringify(merged.documents) !== JSON.stringify(existing.documents || {}) ||
              merged.docsDir !== existing.docsDir
            ) {
              reject('DOCUMENT_USER_REQUIRED');
            }
            if (
              merged.defaultUsername !== existing.defaultUsername ||
              ['dailyUpdateEnabled', 'dailyUpdateTime', 'dailyOffsetDays'].some(
                (key) => merged.sync?.[key] !== existing.sync?.[key],
              )
            ) {
              reject('SYNC_SCHEDULE_USER_REQUIRED');
            }
            if (clock.configTimeZone(merged) !== clock.configTimeZone(existing)) {
              reject('TIME_ZONE_USER_REQUIRED');
            }
            if (
              (merged.knowledgeV2?.dailyImportConversations ?? false) !==
              (existing.knowledgeV2?.dailyImportConversations ?? false)
            ) {
              reject('KNOWLEDGE_V2_USER_REQUIRED');
            }
          }
          for (const section of ['knowledgeV2', 'sync']) {
            if (merged[section]) {
              delete merged[section].dailyUpdateTimeZone;
            }
          }
          return merged;
        },
        { expectedRevision, signal: caller.signal },
      );
      try {
        configureSubagentScheduler(ctx.subagents, saved);
        await options.onSaved?.(saved, previous);
      } catch (cause) {
        throw Object.assign(new Error('CONFIG_APPLY_FAILED'), {
          code: 'CONFIG_APPLY_FAILED',
          status: 503,
          details: { saved: true, applied: false, revision: configRevision(saved) },
          cause,
        });
      }
      return { status: 200, value: { ...saved, _revision: configRevision(saved) } };
    },
  };
}
