'use strict';
const clientApi = require('./api/index.js');
const React = require('react');
const { DEFAULT_TIME_ZONE, validateTimeZone, formatTimestamp } = require('../shared/time.cjs');

let zone = DEFAULT_TIME_ZONE;
let revision = 0;
const listeners = new Set();
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Publish only saved profile settings; mounted time surfaces update immediately.
 * @param value - Saved IANA zone, or undefined for the documented default.
 * @returns Nothing; invalid zone names throw before replacing the current clock.
 */
function setTimeZone(value) {
  revision++;
  const next = validateTimeZone(value ?? DEFAULT_TIME_ZONE);
  if (zone !== next) {
    zone = next;
    for (const listener of listeners) {
      listener();
    }
  }
}

/**
 * Subscribe the owning component to saved time-zone changes.
 * @returns The saved IANA zone; React owns the subscription cleanup.
 */
function useTimeZone() {
  return React.useSyncExternalStore(subscribe, () => zone);
}

/**
 * Load the profile clock with effect-owned cancellation and reset it on unload.
 * @returns An async disposer that cancels and waits for the initial read to settle.
 */
function installTimeZone() {
  const controller = new AbortController();
  const initialRevision = revision;
  const pending = clientApi
    .request(clientApi.endpoint('config'), { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) {
        return;
      }
      const config = await response.json();
      if (!controller.signal.aborted && revision === initialRevision) {
        setTimeZone(config.general?.timeZone);
      }
    })
    .catch(() => {
      // Leave the documented default active; the settings page owns retry and error display.
    });
  return async () => {
    controller.abort();
    setTimeZone(DEFAULT_TIME_ZONE);
    await pending;
  };
}

/** @param value - Absolute instant. @returns Complete timestamp in the saved zone. */
const formatDateTime = (value) => formatTimestamp(value, zone);
/** @param value - Absolute instant. @returns Calendar date in the saved zone. */
const formatDate = (value) => formatTimestamp(value, zone, 'date');
/** @param value - Absolute instant. @returns Clock time in the saved zone. */
const formatTime = (value) => formatTimestamp(value, zone, 'time');

module.exports = {
  useTimeZone,
  setTimeZone,
  installTimeZone,
  formatDateTime,
  formatDate,
  formatTime,
};
