import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const React = require('react');
const { ICON_COMPONENTS, createIconComponents } = require('../../src/client/icons.js');
const { getDocIcon } = require('../../src/client/utils/getDocIcon.js');
const sourceRoot = resolve(import.meta.dirname, '../../src');
function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:js|mjs|css|json)$/.test(path) ? [{ path, text: readFileSync(path, 'utf8') }] : [];
  });
}

it('contains no application-authored emoji, including text-symbol fallbacks', () => {
  const violations = sources(sourceRoot).flatMap(({ path, text }) => text.split('\n').flatMap((line, index) =>
    /[\p{Extended_Pictographic}\uFE0F\u200D]/u.test(line) ? [`${path}:${index + 1}`] : []));
  expect(violations).toEqual([]);
});
it('provides every referenced local icon and prohibits duplicate glyph definitions', () => {
  const components = createIconComponents(React.createElement);
  const references = sources(join(sourceRoot, 'client')).flatMap(({ text }) => [...text.matchAll(/\bIcon[A-Z]\w*/g)].map(match => match[0]));
  for (const name of new Set(references)) {
    if (Object.values(ICON_COMPONENTS).includes(name) || name === 'IconLoadingOutlineRegular') continue; // Native host Menu control.
    expect(components[name], name).toBeTypeOf('function');
  }
  const paths = Object.values(ICON_COMPONENTS).map(path => path.replace(/\s+/g, ' ').trim());
  expect(new Set(paths).size).toBe(paths.length);
});
it('assigns a unique semantic glyph to each main navigation destination', () => {
  const source = readFileSync(join(sourceRoot, 'client/components/DocsViewerBody.js'), 'utf8');
  const navigation = [...source.matchAll(/id: '(\w+)', icon: h\(Icon(\w+)/g)];
  expect(navigation.map(match => match[1])).toEqual(['create', 'sync', 'view', 'knowledge', 'search', 'writing', 'log', 'settings']);
  const names = navigation.map(match => match[2][0].toLowerCase() + match[2].slice(1));
  expect(new Set(names).size).toBe(navigation.length);
  for (const name of names) expect(ICON_COMPONENTS[name], name).toBeTruthy();
});
it('distinguishes document types while treating PRD and tech as semantic aliases', () => {
  const name = type => { const icon = getDocIcon(type); return icon.type(icon.props).props['data-icon']; };
  const types = ['requirement', 'design', 'cr', 'api', 'test', 'other', 'folder'];
  expect(new Set(types.map(name)).size).toBe(types.length);
  expect(name('prd')).toBe(name('requirement')); expect(name('tech')).toBe(name('design'));
  expect(name('missing')).toBe('file');
});
it('keeps static icons decorative and centralizes application-authored SVG', () => {
  for (const Icon of Object.values(createIconComponents(React.createElement))) {
    const element = Icon({});
    expect(element.props).toMatchObject({ 'aria-hidden': true });
    expect(element.type).toBe('span');
    expect(element.props.children.type).toBeTypeOf('function');
  }
  const inline = sources(join(sourceRoot, 'client')).filter(({ path, text }) => !path.endsWith('icons.js') && /h\('svg'|<svg[\s>]/.test(text));
  expect(inline.map(item => item.path)).toEqual([]);
});
