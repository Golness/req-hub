'use strict';

const GENERAL_DEFAULTS = Object.freeze({
  taskTimeoutMs: 20 * 60 * 1000,
  knowledgeMaxInputBytes: 2000000,
  knowledgeMaxResultBytes: 250000,
});

/**
 * Resolve shared execution policy without consulting former feature overrides.
 * @param config - Validated profile settings.
 * @returns General defaults with explicit profile values applied.
 */
function generalSettings(config) {
  return { ...GENERAL_DEFAULTS, ...config?.general };
}

/**
 * Supply shared knowledge-processing budgets to document enhancements.
 * @param config - Validated profile settings.
 * @returns Limits using the runtime protocol's existing field names.
 */
function knowledgeLimits(config) {
  const settings = generalSettings(config);
  return {
    timeoutMs: settings.taskTimeoutMs,
    maxInputBytes: settings.knowledgeMaxInputBytes,
    maxResultBytes: settings.knowledgeMaxResultBytes,
  };
}

/**
 * Remove obsolete feature overrides without migrating their values or mutating the input.
 * @param config - Submitted or persisted profile settings.
 * @returns A detached configuration with a single source for shared policies.
 */
function withoutIndependentSettings(config) {
  const next = structuredClone(config);
  for (const section of ['knowledgeV2', 'enhancements']) {
    for (const key of ['timeoutMs', 'maxInputBytes', 'maxResultBytes']) {
      if (next?.[section] && typeof next[section] === 'object') {
        delete next[section][key];
      }
    }
  }
  if (next?.ai?.delegation && typeof next.ai.delegation === 'object') {
    delete next.ai.delegation.timeout;
  }
  return next;
}

module.exports = { GENERAL_DEFAULTS, generalSettings, knowledgeLimits, withoutIndependentSettings };
