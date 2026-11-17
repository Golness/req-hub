'use strict';
const clientApi = require('./api/index.js');
const React = require('react');
const { DEFAULT_UI_LANGUAGE, normalizeUiLanguage } = require('../shared/general.cjs');

let language = DEFAULT_UI_LANGUAGE;
let revision = 0;
const listeners = new Set();
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Publish only saved profile settings; mounted UI surfaces update immediately.
 * @param value - Saved preference, or undefined for the documented default.
 * @returns Nothing; unsupported values fall back to following the host.
 */
function setUiLanguage(value) {
  revision++;
  const next = normalizeUiLanguage(value);
  if (language !== next) {
    language = next;
    for (const listener of listeners) {
      listener();
    }
  }
}

/** @returns The effective preference without subscribing; used by the locale runtime. */
function currentUiLanguage() {
  return language;
}

/**
 * Subscribe the owning component to saved language changes.
 * @returns The saved preference; React owns the subscription cleanup.
 */
function useUiLanguage() {
  return React.useSyncExternalStore(subscribe, () => language);
}

/**
 * Load the profile preference with effect-owned cancellation and reset it on unload.
 * @returns An async disposer that cancels and waits for the initial read to settle.
 */
function installUiLanguage() {
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
        setUiLanguage(config.general?.uiLanguage);
      }
    })
    .catch(() => {
      // Leave the documented default active; the settings page owns retry and error display.
    });
  return async () => {
    controller.abort();
    setUiLanguage(DEFAULT_UI_LANGUAGE);
    await pending;
  };
}

module.exports = {
  useUiLanguage,
  setUiLanguage,
  currentUiLanguage,
  installUiLanguage,
};
