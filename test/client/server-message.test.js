// @vitest-environment jsdom
import { it, expect, afterEach, describe } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { setUiLanguage } = require('../../src/client/ui-language.js');
const {
  localizeMessage,
  localizeMessages,
  localizeCode,
  messageCode,
  clientError,
} = require('../../src/client/utils/serverMessage.js');
const zh = require('../../src/client/locales/zh.js');
const en = require('../../src/client/locales/en.js');

afterEach(() => setUiLanguage('follow'));

describe('stable message protocol', () => {
  it('resolves bare codes through the active dictionary', () => {
    expect(localizeMessage('SESSION_SERVICE_UNAVAILABLE')).toBe(
      zh['server.SESSION_SERVICE_UNAVAILABLE'],
    );
    setUiLanguage('en');
    expect(localizeMessage('SESSION_SERVICE_UNAVAILABLE')).toBe(
      en['server.SESSION_SERVICE_UNAVAILABLE'],
    );
  });

  it('interpolates descriptor parameters', () => {
    setUiLanguage('en');
    expect(
      localizeMessage({ code: 'LOG_GET_SESSION_LIST_FAILED', params: { v0: 'boom' } }),
    ).toContain('boom');
  });

  it('resolves codes nested in descriptor parameters', () => {
    setUiLanguage('en');
    const text = localizeMessage({
      code: 'SYNC_PHASED_SYNC_FINISHED',
      params: { v0: 'DOC_REQUIREMENT', v1: 'STATUS_SYNC_SUCCEEDED' },
    });
    expect(text).not.toContain('DOC_REQUIREMENT');
    expect(text).not.toContain('STATUS_SYNC_SUCCEEDED');
    expect(text).toContain('Requirement document');
    expect(text).toContain('Sync succeeded');
  });

  it('joins arrays of messages', () => {
    setUiLanguage('en');
    const text = localizeMessages(['SYNC_NO_COMMITS', 'SYNC_NEW_DOCUMENT']);
    expect(text).toContain('No commit records');
    expect(text).toContain('; ');
  });

  it('drops dangling placeholders when a descriptor collapsed to a bare code', () => {
    setUiLanguage('en');
    expect(localizeCode('SYNC_COMMIT_COUNT')).not.toContain('{v0}');
  });

  it('keeps unknown codes, plain prose and user content untouched', () => {
    setUiLanguage('en');
    expect(localizeMessage('SOME_FUTURE_CODE')).toBe('SOME_FUTURE_CODE');
    expect(localizeMessage('用户自定义的需求文档标题')).toBe('用户自定义的需求文档标题');
    expect(localizeMessage('Already English')).toBe('Already English');
    expect(localizeMessage(undefined)).toBe('');
    expect(localizeMessage(null)).toBe('');
  });

  it('resolves pre-existing error-code namespaces through the same entry point', () => {
    setUiLanguage('en');
    expect(localizeMessage('KB_NOTHING_TO_COMPILE')).toBe(en['kb.error.KB_NOTHING_TO_COMPILE']);
    expect(localizeMessage('LARK_PUSH_NO_DOCUMENTS')).toBe(
      en['reports.reason.LARK_PUSH_NO_DOCUMENTS'],
    );
  });

  it('appends a structured detail without translating it', () => {
    setUiLanguage('en');
    expect(localizeMessage({ code: 'LOG_GET_SESSION_LIST_FAILED', detail: 'ENOENT' })).toContain(
      'ENOENT',
    );
  });

  it('keeps every server code translated in both dictionaries', () => {
    const keys = Object.keys(zh).filter((key) => key.startsWith('server.'));
    expect(keys.length).toBeGreaterThan(300);
    for (const key of keys) {
      expect(en[key], key).toBeTruthy();
      expect(en[key], key).not.toBe(zh[key]);
    }
  });

  it('keeps descriptors and Errors usable when a value must stay a stable code', () => {
    expect(messageCode('SYNC_PHASED_SYNC_FINISHED')).toBe('SYNC_PHASED_SYNC_FINISHED');
    expect(messageCode({ code: 'DOC_FILE_TYPE_NOT_EDITABLE', params: { v0: '.bin' } })).toBe(
      'DOC_FILE_TYPE_NOT_EDITABLE',
    );
    expect(messageCode(null)).toBe('');

    const fromDescriptor = clientError(
      { code: 'DOC_BRANCH_ALREADY_EXISTS', params: { v0: 'feature/x' } },
      'FALLBACK',
    );
    expect(fromDescriptor.message).toBe('DOC_BRANCH_ALREADY_EXISTS');
    expect(fromDescriptor.code).toBe('DOC_BRANCH_ALREADY_EXISTS');
    expect(fromDescriptor.params).toEqual({ v0: 'feature/x' });

    setUiLanguage('en');
    expect(localizeMessage(fromDescriptor)).toContain('feature/x');
    expect(localizeMessage(clientError('SESSION_SERVICE_UNAVAILABLE'))).toBe(
      en['server.SESSION_SERVICE_UNAVAILABLE'],
    );
    expect(clientError(null, 'FALLBACK').message).toBe('FALLBACK');
  });

  it('renders a parameterized HTTP error descriptor in both languages', () => {
    const error = clientError({
      code: 'ERR_PROMPT_KEY_NOT_FOUND',
      params: { v0: 'my-prompt' },
    });
    setUiLanguage('zh');
    expect(localizeMessage(error)).toContain('my-prompt');
    expect(localizeMessage(error)).toContain('未找到');
    setUiLanguage('en');
    expect(localizeMessage(error)).toContain('my-prompt');
    expect(localizeMessage(error)).not.toContain('{v0}');
  });

  it('localizes toast messages at the single notification entry point', async () => {
    setUiLanguage('en');
    const {
      showToast,
      ToastContainer,
    } = require('../../src/client/components/shared/ToastContainer.js');
    const React = require('react');
    const { act } = React;
    const { createRoot } = require('react-dom/client');
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(ToastContainer)));
    await act(async () => showToast({ tone: 'error', text: 'SESSION_SERVICE_UNAVAILABLE' }));
    expect(container.textContent).toContain('Session service unavailable');
    await act(async () => root.unmount());
    container.remove();
  });
});
