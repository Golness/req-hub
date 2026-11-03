import { digest, fail } from './store.js';
import { createLogger } from '../../logger.js';
import { configFilePath } from '../../config.js';

const log = createLogger('wiki');

/**
 * Validate and select the daily configuration before saving or arming a clock.
 * @param settings - Effective Wiki settings.
 * @returns Enabled flag, time and IANA zone, with stable errors for invalid fields.
 */
export function dailySettings(settings) {
  if (typeof settings.dailyUpdateEnabled !== 'boolean') {
    fail('WIKI_INVALID_INPUT');
  }
  if (
    typeof settings.dailyUpdateTime !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.dailyUpdateTime)
  ) {
    fail('WIKI_SCHEDULE_TIME_INVALID');
  }
  try {
    if (typeof settings.dailyUpdateTimeZone !== 'string' || !settings.dailyUpdateTimeZone) {
      throw new Error('Invalid time zone');
    }
    dailyClock(new Date(0), settings.dailyUpdateTimeZone);
  } catch {
    fail('WIKI_SCHEDULE_TIME_ZONE_INVALID');
  }
  return {
    enabled: settings.dailyUpdateEnabled,
    time: settings.dailyUpdateTime,
    timeZone: settings.dailyUpdateTimeZone,
  };
}

/**
 * Read a calendar day and minute in the configured IANA time zone.
 * @param date - Absolute time to convert.
 * @param timeZone - Validated IANA time-zone name.
 * @returns A sortable local date and a minute-of-day value.
 */
export function dailyClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    day: `${values.year}-${values.month}-${values.day}`,
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}

/** Own the daily clock, persistent activation boundary and abortable per-scope dispatch. */
export class WikiDailyScheduler {
  constructor({ wiki, clock = () => new Date(), ownerKey = digest(configFilePath()) }) {
    Object.assign(this, { wiki, clock, ownerKey });
    this.pending = Promise.resolve();
    this.generation = 0;
    this.state = { state: 'not_started' };
  }
  /**
   * Start or reconfigure the clock after settings are saved.
   * @returns Completion after configuration and any currently due batch are checked.
   */
  refresh() {
    if (this.closed) {
      return Promise.resolve();
    }
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = new AbortController();
    const generation = ++this.generation;
    return this.enqueue(generation, this.controller.signal);
  }
  assertActive(generation, signal) {
    signal.throwIfAborted();
    if (this.closed || generation !== this.generation || this.wiki.closing) {
      fail('WIKI_SCHEDULE_CANCELLED', 409);
    }
  }
  enqueue(generation, signal) {
    const task = this.pending.then(async () => {
      try {
        this.assertActive(generation, signal);
        await this.check(generation, signal);
      } catch (error) {
        if (!signal.aborted && !this.closed) {
          this.state = { state: 'error', errorCode: 'WIKI_SCHEDULE_FAILED' };
          log.error('WIKI_SCHEDULE_FAILED', { code: error.code || error.message });
        }
      }
      if (!this.closed && generation === this.generation && this.state.state !== 'disabled') {
        const delay = 60000 - (this.clock().getTime() % 60000);
        this.timer = setTimeout(() => {
          this.enqueue(generation, signal);
        }, delay);
        this.timer.unref?.();
      }
    });
    this.pending = task;
    return task;
  }
  async check(generation, signal) {
    const settings = await this.wiki.settings();
    this.assertActive(generation, signal);
    const config = dailySettings(settings);
    const database = this.wiki.database();
    const time = this.clock();
    const key = digest(config);
    let control = database.db
      .prepare('SELECT * FROM knowledge_wiki_daily_control WHERE owner_key=?')
      .get(this.ownerKey);
    if (control?.config_hash !== key) {
      database.db
        .prepare(
          'INSERT INTO knowledge_wiki_daily_control(owner_key,config_hash,activated_at) VALUES (?,?,?) ON CONFLICT(owner_key) DO UPDATE SET config_hash=excluded.config_hash,activated_at=excluded.activated_at',
        )
        .run(this.ownerKey, key, time.toISOString());
      control = { config_hash: key, activated_at: time.toISOString() };
    }
    this.state = { state: config.enabled ? 'enabled' : 'disabled', ...config };
    if (!config.enabled) {
      return;
    }
    const current = dailyClock(time, config.timeZone);
    const activated = dailyClock(new Date(control.activated_at), config.timeZone);
    const [hour, minute] = config.time.split(':').map(Number);
    const due = hour * 60 + minute;
    if (
      current.minute < due ||
      (current.day === activated.day && due <= activated.minute) ||
      current.day < activated.day
    ) {
      return;
    }
    for (const origin of this.wiki.knowledge.database().scopes()) {
      this.assertActive(generation, signal);
      if (
        database.db
          .prepare(
            'SELECT 1 FROM knowledge_wiki_daily_runs WHERE owner_key=? AND scope_id=? AND run_day=?',
          )
          .get(this.ownerKey, origin.id, current.day)
      ) {
        continue;
      }
      try {
        const scope = await this.wiki.resolveScope(origin.id);
        this.assertActive(generation, signal);
        await this.wiki.knowledge.refreshSources(scope);
        this.assertActive(generation, signal);
        await this.wiki.update(scope, undefined, {
          ownerKey: this.ownerKey,
          day: current.day,
          time: config.time,
          timeZone: config.timeZone,
          assertActive: () => this.assertActive(generation, signal),
        });
      } catch (error) {
        this.assertActive(generation, signal);
        database.transaction(() => {
          if (
            database.recordDailyRun(
              origin.id,
              {
                ownerKey: this.ownerKey,
                day: current.day,
                time: config.time,
                timeZone: config.timeZone,
              },
              0,
            )
          ) {
            database.event(
              origin.id,
              'schedule_failed',
              {
                day: current.day,
                code: error.message,
              },
              'error',
            );
          }
        });
      }
    }
  }
  /** Stop admission immediately; an already committed update batch retains its task ownership. */
  beginClose() {
    this.closed = true;
    clearTimeout(this.timer);
    this.controller?.abort();
  }
  /**
   * Stop the clock and await any dispatch still resolving scope or source access.
   * @returns Completion after all scheduler work has stopped.
   */
  async close() {
    this.beginClose();
    await this.pending;
  }
}
