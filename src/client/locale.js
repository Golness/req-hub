'use strict';
// Product copy is owned by this namespace; the host supplies locale selection.
const zh = require('./locales/zh.js');
const NAMESPACE = 'reqHub';
let translate;
/** @param {keyof typeof zh} key @param {Record<string, unknown>} [params] */
function t(key, params) {
  const resolved = translate?.(key, params);
  if (resolved !== undefined && resolved !== key) return resolved;
  // This plugin currently ships Chinese copy. Retain it when the host selects
  // a locale for which no plugin dictionary has been installed.
  const text = zh[key];
  if (text === undefined) throw new Error(`Unknown ReqHub locale key: ${key}`);
  return text.replace(/\{(\w+)\}/g, (match, name) => params && Object.hasOwn(params, name) ? String(params[name]) : match);
}
function installLocale(ctx) {
  const dispose = ctx.locale.register(NAMESPACE, { zh });
  translate = ctx.locale.bind(NAMESPACE);
  return () => { translate = undefined; dispose(); };
}
module.exports = { t, installLocale, NAMESPACE };
