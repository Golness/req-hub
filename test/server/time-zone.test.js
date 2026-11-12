import { expect, it } from 'vitest';
import clock from '../../src/shared/time.cjs';
import { syncSchedule } from '../../src/server/sync-daily-scheduler.js';
import { dailySettings } from '../../src/server/knowledge-v2/sync-settings.js';

it('formats instants at the configured calendar boundary without changing the timestamp', () => {
  const instant = '2026-11-06T03:41:54.757Z';
  expect(clock.formatTimestamp(instant, 'Asia/Shanghai')).toBe('2026-11-06 11:41:54');
  expect(clock.formatTimestamp(instant, 'America/New_York')).toBe('2026-11-05 22:41:54');
  expect(clock.formatTimestamp(instant, 'UTC')).toBe('2026-11-06 03:41:54');
  expect(clock.formatTimestamp('2026-11-05T16:00:00Z', 'Asia/Shanghai', 'date')).toBe('2026-11-06');
  expect(clock.formatTimestamp('invalid', 'UTC')).toBe('');
  expect(clock.formatTimestamp(null, 'UTC')).toBe('');
});

it('uses the IANA daylight-saving rules for the selected zone', () => {
  expect(clock.formatTimestamp('2026-11-01T05:30:00Z', 'America/New_York')).toBe(
    '2026-11-01 01:30:00',
  );
  expect(clock.formatTimestamp('2026-11-01T06:30:00Z', 'America/New_York')).toBe(
    '2026-11-01 01:30:00',
  );
});

it('uses only the general clock for both schedulers and ignores conflicting independent zones', () => {
  const config = {
    general: { timeZone: 'America/New_York' },
    sync: { dailyUpdateTimeZone: 'UTC' },
    knowledgeV2: {
      autoManage: false,
      autoManageDelayMs: 30000,
      dailyUpdateEnabled: true,
      dailyImportConversations: false,
      dailyUpdateTime: '02:00',
    },
  };
  expect(syncSchedule(config).timeZone).toBe('America/New_York');
  expect(dailySettings(config.knowledgeV2, clock.configTimeZone(config)).timeZone).toBe(
    'America/New_York',
  );
  delete config.general;
  expect(syncSchedule(config).timeZone).toBe('Asia/Shanghai');
  expect(dailySettings(config.knowledgeV2).timeZone).toBe('Asia/Shanghai');
  expect(() => clock.configTimeZone({ general: { timeZone: 'invalid' } })).toThrow();
});
