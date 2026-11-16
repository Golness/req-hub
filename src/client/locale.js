'use strict';
// Product copy is owned by this namespace; the host supplies the default locale selection.
const zh = require('./locales/zh.js');
const en = require('./locales/en.js');
const { currentUiLanguage } = require('./ui-language.js');
const NAMESPACE = 'reqHub';
const dictionaries = { zh, en };
let translate;

/**
 * Substitute named placeholders in a resolved template.
 * @param text - Dictionary or host template.
 * @param params - Optional interpolation values.
 * @returns Text with known placeholders replaced; unknown ones are retained.
 */
function interpolate(text, params) {
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    params && Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/**
 * @param {keyof typeof zh} key @param {Record<string, unknown>} [params]
 * @returns Localized text with parameter interpolation.
 */
function t(key, params) {
  const forced = currentUiLanguage();
  let text;
  if (forced !== 'follow') {
    // A saved preference must bypass the host translation, otherwise a host
    // language different from the saved preference would win the lookup.
    // Fall back to the owned Chinese copy for keys a dictionary has not caught up with.
    text = dictionaries[forced][key] ?? zh[key];
  } else {
    const resolved = translate?.(key, params);
    if (resolved !== undefined && resolved !== key) {
      return interpolate(String(resolved), params);
    }
    // Retain the Chinese dictionary when the host has no plugin translation
    // for its active locale.
    text = zh[key];
  }
  if (text === undefined) {
    throw new Error(`Unknown ReqHub locale key: ${key}`);
  }
  return interpolate(text, params);
}

/**
 * Report which plugin dictionary the current selection resolves to.
 * The host chooses the language in follow mode; a probe on a stable key tells
 * whether it supplied a non-Chinese translation.
 * @returns Either 'zh' or 'en'.
 */
function activeLocale() {
  const forced = currentUiLanguage();
  if (forced !== 'follow') {
    return forced;
  }
  const probe = translate?.('common.save');
  return probe && probe !== 'common.save' && probe !== zh['common.save'] ? 'en' : 'zh';
}

/**
 * Report whether the plugin dictionary owns a key, without throwing.
 * @param key - Candidate locale key.
 * @returns True when a translation exists.
 */
function hasLocaleKey(key) {
  return Object.hasOwn(zh, key);
}

/**
 * Register the plugin dictionaries for the lifetime of its owning effect.
 * @param ctx - The injected Client context with locale support.
 * @returns A disposer that clears the binding and unregisters the dictionaries.
 */
function installLocale(ctx) {
  const dispose = ctx.locale.register(NAMESPACE, dictionaries);
  translate = ctx.locale.bind(NAMESPACE);
  return () => {
    translate = undefined;
    dispose();
  };
}
module.exports = { t, hasLocaleKey, installLocale, activeLocale, NAMESPACE };
