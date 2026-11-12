import { isAbsolute, basename } from 'node:path';

const DEFAULTS = { executable: 'lark-cli', profile: '', identity: 'user', timeoutMs: 30000 };

/**
 * Validate connection settings without accepting shell commands or credential fields.
 * @param input - Plugin-owned connection settings.
 * @returns Normalized settings; invalid input fails before starting a process.
 */
export function validateLarkSettings(input = {}) {
  const value = { ...DEFAULTS, ...input };
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !Object.hasOwn(DEFAULTS, key)) ||
    typeof value.executable !== 'string' ||
    value.executable.length > 1024 ||
    (value.executable !== 'lark-cli' &&
      (!isAbsolute(value.executable) ||
        !/^lark-cli(?:\.exe)?$/i.test(basename(value.executable)))) ||
    /[\r\n\x00]/.test(value.executable) ||
    typeof value.profile !== 'string' ||
    !/^[A-Za-z0-9_-]{0,64}$/.test(value.profile) ||
    !['user', 'bot'].includes(value.identity) ||
    !Number.isInteger(value.timeoutMs) ||
    value.timeoutMs < 1000 ||
    value.timeoutMs > 120000
  ) {
    throw Object.assign(new Error('LARK_CONFIG_INVALID'), { status: 400 });
  }
  return value;
}
