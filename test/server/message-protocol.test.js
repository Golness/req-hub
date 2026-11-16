import { describe, it, expect } from 'vitest';
import {
  Message,
  msg,
  messageCode,
  messageDescriptor,
  messageFromDescriptor,
  describeError,
} from '../../src/server/messages.js';

describe('server message protocol', () => {
  it('emits bare stable codes for static messages and descriptors for dynamic ones', () => {
    expect(msg('STATIC_CODE')).toBe('STATIC_CODE');
    const dynamic = msg('ERR_EXECUTION_TIMEOUT', { v0: 1200000 });
    expect(dynamic).toBeInstanceOf(Message);
    expect(dynamic).toBeInstanceOf(Error);
    expect(String(dynamic)).toBe('ERR_EXECUTION_TIMEOUT');
    expect(dynamic.message).toBe('ERR_EXECUTION_TIMEOUT');
    expect(JSON.parse(JSON.stringify({ error: dynamic }))).toEqual({
      error: { code: 'ERR_EXECUTION_TIMEOUT', params: { v0: 1200000 } },
    });
  });

  it('keeps a pure stable code in string contexts such as new Error(message)', () => {
    const error = new Error(msg('ERR_EXECUTION_TIMEOUT', { v0: 300000 }));
    expect(error.message).toBe('ERR_EXECUTION_TIMEOUT');
    expect(messageCode(error)).toBe('ERR_EXECUTION_TIMEOUT');
  });

  it('normalizes nested descriptors so params survive structuredClone', () => {
    const nested = msg('SYNC_SESSION_ROUND_ID', { v0: 'session-1', v1: 3 });
    const outer = msg('SYNC_SINGLE_ITEM_OVER_BUDGET', {
      v0: 'SYNC_LABEL_SESSION_ROUND',
      v1: nested,
      v2: '50,009',
    });
    const descriptor = messageDescriptor(outer);
    expect(descriptor).toEqual({
      code: 'SYNC_SINGLE_ITEM_OVER_BUDGET',
      params: {
        v0: 'SYNC_LABEL_SESSION_ROUND',
        v1: { code: 'SYNC_SESSION_ROUND_ID', params: { v0: 'session-1', v1: 3 } },
        v2: '50,009',
      },
    });
    // A plain object survives structuredClone; an Error subclass does not.
    expect(structuredClone(descriptor)).toEqual(descriptor);
    expect(structuredClone(outer).code).toBeUndefined();
  });

  it('maps plain Error objects and arrays to transport-safe values', () => {
    expect(messageDescriptor(new Error('ERR_PDF_INVALID'))).toBe('ERR_PDF_INVALID');
    expect(messageDescriptor(['SYNC_LABEL_CODE_FILE', msg('STATUS_UNKNOWN', { v0: 'x' })])).toEqual(
      ['SYNC_LABEL_CODE_FILE', { code: 'STATUS_UNKNOWN', params: { v0: 'x' } }],
    );
    expect(messageDescriptor(null)).toBeNull();
    expect(messageDescriptor(42)).toBe(42);
  });

  it('rebuilds a throwable message with its params from a descriptor', () => {
    const rebuilt = messageFromDescriptor({
      code: 'ERR_EXECUTION_TIMEOUT',
      params: { v0: 300000 },
    });
    expect(rebuilt).toBeInstanceOf(Message);
    expect(rebuilt.message).toBe('ERR_EXECUTION_TIMEOUT');
    expect(rebuilt.params).toEqual({ v0: 300000 });
    expect(messageFromDescriptor('ERR_PDF_INVALID').message).toBe('ERR_PDF_INVALID');
  });

  it('prefers the user-visible code over a machine-level error code', () => {
    const error = Object.assign(new Error('ERR_EXECUTION_TIMEOUT'), {
      code: 'EXECUTION_TIMEOUT',
      messageCode: 'ERR_EXECUTION_TIMEOUT',
      params: { v0: 300000 },
    });
    expect(messageDescriptor(error)).toEqual({
      code: 'ERR_EXECUTION_TIMEOUT',
      params: { v0: 300000 },
    });
    expect(describeError(error)).toEqual({
      code: 'ERR_EXECUTION_TIMEOUT',
      params: { v0: 300000 },
    });
    expect(describeError(new Error('ERR_PDF_INVALID'))).toEqual({ code: 'ERR_PDF_INVALID' });
  });

  it('degrades unknown thrown values to a stable internal error', () => {
    expect(describeError({})).toEqual({ code: 'INTERNAL_ERROR' });
    expect(messageDescriptor(undefined)).toBeUndefined();
  });
});
