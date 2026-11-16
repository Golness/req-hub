// @vitest-environment jsdom
import { it, expect, afterEach, describe, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const zh = require('../../src/client/locales/zh.js');
const en = require('../../src/client/locales/en.js');
const { t, installLocale } = require('../../src/client/locale.js');
const { setUiLanguage, currentUiLanguage } = require('../../src/client/ui-language.js');
const {
  UI_LANGUAGES,
  DEFAULT_UI_LANGUAGE,
  normalizeUiLanguage,
} = require('../../src/shared/general.cjs');

let stop;
afterEach(() => {
  stop?.();
  stop = undefined;
  setUiLanguage(DEFAULT_UI_LANGUAGE);
});

const placeholders = (text) =>
  [...String(text ?? '').matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join('|');

function bindHost(translations = {}) {
  stop = installLocale({
    locale: {
      register: () => () => {},
      bind: () => (key) => translations[key] ?? key,
    },
  });
}

describe('locale dictionaries', () => {
  it('ships the exact same key set in en and zh', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('keeps every interpolation placeholder identical across dictionaries', () => {
    const mismatched = Object.keys(zh).filter(
      (key) => placeholders(zh[key]) !== placeholders(en[key]),
    );
    expect(mismatched).toEqual([]);
  });

  it('ships non-empty English copy without CJK characters', () => {
    const invalid = Object.entries(en)
      .filter(
        ([, value]) => typeof value !== 'string' || !value.trim() || /[\u3400-\u9fff]/.test(value),
      )
      .map(([key]) => key);
    expect(invalid).toEqual([]);
  });

  it('resolves every key through t() in English mode without throwing', () => {
    setUiLanguage('en');
    expect(() => {
      for (const key of Object.keys(zh)) {
        const value = t(key);
        if (typeof value !== 'string' || !value) {
          throw new Error(`Unresolved key: ${key}`);
        }
      }
    }).not.toThrow();
  });

  it('keeps tab labels short enough for the shared tab bar', () => {
    const oversized = Object.keys(en)
      .filter((key) => /\.tab\./.test(key))
      .filter((key) => en[key].length > 40)
      .map((key) => `${key}: ${en[key]}`);
    expect(oversized).toEqual([]);
  });

  it('accepts only the three documented preferences', () => {
    expect(UI_LANGUAGES).toEqual(['follow', 'zh', 'en']);
    expect(normalizeUiLanguage('fr')).toBe(DEFAULT_UI_LANGUAGE);
    expect(normalizeUiLanguage(undefined)).toBe(DEFAULT_UI_LANGUAGE);
  });
});

describe('UI language preference', () => {
  it('follows host translations by default', () => {
    bindHost({ 'common.save': 'Host translation' });
    expect(currentUiLanguage()).toBe('follow');
    expect(t('common.save')).toBe('Host translation');
  });

  it('interpolates host translations as well as plugin dictionaries', () => {
    bindHost({ 'common.save': 'Saved {count} items' });
    expect(t('common.save', { count: 3 })).toBe('Saved 3 items');
  });

  it('forces the Chinese dictionary even when the host offers another language', () => {
    bindHost({ 'common.save': 'Host translation' });
    setUiLanguage('zh');
    expect(t('common.save')).toBe(zh['common.save']);
  });

  it('forces the English dictionary and still interpolates', () => {
    bindHost({ 'common.save': 'Host translation' });
    setUiLanguage('en');
    expect(t('common.save')).toBe(en['common.save']);
    expect(t('kb.import.summary', { total: 7, available: 4, selected: 2 })).toContain('7');
  });

  it('falls back to the Chinese copy for a key missing from a dictionary', () => {
    bindHost();
    setUiLanguage('en');
    expect(t('common.save')).toBeTruthy();
    expect(() => t('definitely.not.a.locale.key')).toThrow('Unknown ReqHub locale key');
  });

  it('notifies subscribers only when the effective preference changes', () => {
    const { useUiLanguage } = require('../../src/client/ui-language.js');
    expect(typeof useUiLanguage).toBe('function');
    setUiLanguage('en');
    expect(currentUiLanguage()).toBe('en');
    setUiLanguage('nonsense');
    expect(currentUiLanguage()).toBe(DEFAULT_UI_LANGUAGE);
  });
});
