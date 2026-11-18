import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it.each(['zh', 'en'])('does not silently override duplicate %s dictionary keys', (language) => {
  const file = new URL(`../../src/client/locales/${language}.js`, import.meta.url);
  const keys = [...readFileSync(file, 'utf8').matchAll(/^\s*'([^']+)':/gm)].map(
    (match) => match[1],
  );
  const seen = new Set();
  const duplicates = [];
  for (const key of keys) {
    if (seen.has(key)) {
      duplicates.push(key);
    }
    seen.add(key);
  }
  expect(duplicates).toEqual([]);
});
