'use strict';

const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/**
 * Validate an explicit IANA zone without using the operating system's clock.
 * @param timeZone - Explicit IANA identifier.
 * @returns The identifier; invalid values throw.
 */
function validateTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 100) {
    throw new Error('TIME_ZONE_INVALID');
  }
  new Intl.DateTimeFormat('en', { timeZone }).format(0);
  return timeZone;
}

/**
 * Read the sole profile clock; independent scheduler settings are ignored.
 * @param config - Effective profile settings.
 * @returns The general IANA identifier, or the documented default when absent.
 */
function configTimeZone(config) {
  return validateTimeZone(config?.general?.timeZone ?? DEFAULT_TIME_ZONE);
}

/**
 * Format an absolute instant for display without changing its stored representation.
 * @param value - Date, epoch milliseconds or an ISO timestamp.
 * @param timeZone - Validated profile time zone.
 * @param mode - Date, time or complete timestamp.
 * @returns Stable calendar text, or an empty string for missing or invalid timestamps.
 */
function formatTimestamp(value, timeZone = DEFAULT_TIME_ZONE, mode = 'datetime') {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  if (mode === 'date') {
    return day;
  }
  return mode === 'time' ? time : `${day} ${time}`;
}

module.exports = { DEFAULT_TIME_ZONE, validateTimeZone, configTimeZone, formatTimestamp };
