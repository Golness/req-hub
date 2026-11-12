import clock from '../shared/time.cjs';

/**
 * Read a calendar day and minute in the configured IANA time zone.
 * @param timeZone - IANA time zone used by the schedule.
 * @param now - Instant to project.
 * @returns Comparable YYYY-MM-DD date and HH:mm time.
 */
export function dailyClock(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: `${parts.hour}:${parts.minute}`,
  };
}

export { clock };
