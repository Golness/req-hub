import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';

const components = resolve(import.meta.dirname, '../../src/client/components');

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** Report layout overrides that would split the shared settings alignment. */
function violations(source, owner) {
  const errors = [];
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sharedVariable = /--rh-settings-(?:max-width|label-width|field-gap)\s*:\s*([^;]+)/g;
    for (const match of body.matchAll(sharedVariable)) {
      if (owner !== 'SettingsPanel.module.css' && match[1].trim() !== '100%') {
        errors.push(`${owner}: ${selector.trim()}: configure shared layout in SettingsPanel`);
      }
    }
    const layoutSurface =
      /\.(?:panel|page|group|connection|configurationField|field|modelSettings|actions|bar)\b/;
    if (layoutSurface.test(selector) && /max-width\s*:\s*\d+(?:px|rem|em)\b/.test(body)) {
      errors.push(`${owner}: ${selector.trim()}: use the shared content boundary`);
    }
  }
  return errors;
}

it('rejects fixed section caps and feature overrides of shared settings dimensions', () => {
  expect(
    violations('.connection { max-width: 720px; }', 'ExampleSettings.module.css'),
  ).toHaveLength(1);
  expect(
    violations('.page { --rh-settings-label-width: 144px; }', 'ExampleSettings.module.css'),
  ).toHaveLength(1);
  expect(violations('.numberInput { max-width: 120px; }', 'ExampleSettings.module.css')).toEqual(
    [],
  );
});

it('keeps every settings stylesheet on the shared content boundary', () => {
  const errors = files(components)
    .filter((path) => /Settings.*\.module\.css$/.test(path))
    .flatMap((path) => violations(readFileSync(path, 'utf8'), relative(components, path)));
  expect(
    errors,
    'Follow docs/ui-guidelines.md; extend the shared layout instead of overriding it.',
  ).toEqual([]);
});
