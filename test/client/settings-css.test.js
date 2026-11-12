import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { transform } from 'lightningcss';

const components = resolve(import.meta.dirname, '../../src/client/components');

function compile(relativePath) {
  const filename = resolve(components, relativePath);
  return transform({
    filename,
    code: readFileSync(filename),
    cssModules: { pattern: '[hash]_[local]' },
  }).code.toString();
}

it.each(['EnhancementSettings.module.css'])(
  'resolves container queries against the compiled shared form in %s',
  (filename) => {
    const shared = compile('shared/SettingsForm.module.css');
    const feature = compile(filename);
    const declarations = [...shared.matchAll(/container(?:-name)?:\s*([^;{}]+)/g)].flatMap(
      (match) => match[1].split('/')[0].trim().split(/\s+/),
    );
    const queries = [...(shared + feature).matchAll(/@container\s+([\w-]+)\s*\(/g)].map(
      (match) => match[1],
    );

    expect(shared).toMatch(/container:\s*[\w-]+\s*\/\s*inline-size/);
    expect(queries.filter((name) => !declarations.includes(name))).toEqual([]);
  },
);
