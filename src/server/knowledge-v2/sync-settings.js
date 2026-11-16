import { digest, fail } from './contracts.js';
import { clock } from '../daily-clock.js';

export const DEFAULT_SYNC_SETTINGS = Object.freeze({
  autoManage: false,
  autoManageDelayMs: 30000,
  dailyUpdateEnabled: false,
  dailyImportConversations: false,
  dailyUpdateTime: '02:00',
  larkPushEnabled: false,
});

const KEYS = Object.keys(DEFAULT_SYNC_SETTINGS);

/**
 * Read only the automation settings supported by Knowledge V2.
 * @param config - Effective plugin configuration.
 * @returns Validated automation values with defaults applied.
 */
export function syncSettings(config) {
  const values = {};
  for (const key of KEYS) {
    values[key] = Object.hasOwn(config.knowledgeV2 || {}, key)
      ? config.knowledgeV2[key]
      : DEFAULT_SYNC_SETTINGS[key];
  }
  return validateSyncSettings(values);
}

/**
 * Validate and project the daily schedule before saving or arming it.
 * @param settings - Effective Knowledge V2 automation settings.
 * @param timeZone - Shared configured IANA time zone.
 * @returns Daily schedule settings.
 */
export function dailySettings(settings, timeZone = clock.DEFAULT_TIME_ZONE) {
  if (typeof settings.dailyUpdateEnabled !== 'boolean') {
    fail('KB_SETTINGS_INVALID');
  }
  if (typeof settings.dailyImportConversations !== 'boolean') {
    fail('KB_SETTINGS_INVALID');
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.dailyUpdateTime)) {
    fail('KB_SCHEDULE_TIME_INVALID');
  }
  try {
    clock.validateTimeZone(timeZone);
  } catch {
    fail('KB_SCHEDULE_TIME_ZONE_INVALID');
  }
  return {
    enabled: settings.dailyUpdateEnabled,
    importConversations: settings.dailyImportConversations,
    time: settings.dailyUpdateTime,
    timeZone,
  };
}

/**
 * Validate a complete settings update; legacy Wiki-only fields are not accepted.
 * @param values - Candidate settings values.
 * @returns A new settings object containing only supported fields.
 */
export function validateSyncSettings(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    fail('KB_SETTINGS_INVALID');
  }
  if (Object.keys(values).some((key) => !KEYS.includes(key))) {
    fail('KB_SETTINGS_INVALID', 400, { reason: 'unsupported setting' });
  }
  const next = { ...DEFAULT_SYNC_SETTINGS, ...values };
  for (const key of [
    'autoManage',
    'dailyUpdateEnabled',
    'dailyImportConversations',
    'larkPushEnabled',
  ]) {
    if (typeof next[key] !== 'boolean') {
      fail('KB_SETTINGS_INVALID', 400, { field: key });
    }
  }
  if (
    !Number.isSafeInteger(next.autoManageDelayMs) ||
    next.autoManageDelayMs < 0 ||
    next.autoManageDelayMs > 3600000
  ) {
    fail('KB_SETTINGS_INVALID', 400, { field: 'autoManageDelayMs' });
  }
  dailySettings(next);
  return next;
}

/**
 * Produce the optimistic-concurrency version shown to the settings client.
 * @param values - Effective automation values.
 * @param timeZone - Shared configured time zone.
 * @returns Stable settings version.
 */
export function syncSettingsVersion(values, timeZone) {
  return digest({ values, timeZone });
}
