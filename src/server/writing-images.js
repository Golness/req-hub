import { parseDocument } from 'htmlparser2';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { safeDocumentPath } from './safe-path.js';
import { normalizeSourcePath, knowledgeError } from './knowledge/source-reader.js';
import { withDocumentLock } from './sync-document-validator.js';

export const WRITING_IMAGE_INPUT_LIMIT = 16_000_000;
const filenamePattern = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;
const mime = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const fail = code => { throw knowledgeError(code, 400); };
const hash = value => createHash('sha256').update(value).digest('hex');
function imagesIn(content) {
  const tree = fromMarkdown(content), nodes = [], references = new Set(), definitions = [];
  const walk = node => {
    if (node.type === 'image') nodes.push(node);
    if (node.type === 'imageReference') references.add(node.identifier);
    if (node.type === 'definition') definitions.push(node);
    if (node.type === 'html') {
      const html = parseDocument(node.value, { withStartIndices: true, withEndIndices: true });
      const visit = element => {
        if (element.name === 'img' && element.attribs?.src) nodes.push({ url: element.attribs.src, position: { start: { offset: node.position.start.offset + element.startIndex }, end: { offset: node.position.start.offset + element.endIndex + 1 } } });
        element.children?.forEach(visit);
      };
      visit(html);
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  return nodes.concat(definitions.filter(node => references.has(node.identifier))).filter(node => /^data:image\//i.test(node.url));
}
export const hasWritingImages = content => imagesIn(content).length > 0;
function decode(url) {
  const match = /^data:image\/(png|jpe?g|gif|webp);base64,([a-z0-9+/]+={0,2})$/i.exec(url);
  if (!match || match[2].length > 10_666_668) fail('WRITING_IMAGE_INVALID');
  const bytes = Buffer.from(match[2], 'base64'), extension = /^jpe?g$/i.test(match[1]) ? 'jpg' : match[1].toLowerCase();
  if (!bytes.length || bytes.length > 8_000_000 || bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) fail('WRITING_IMAGE_INVALID');
  const valid = extension === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : extension === 'jpg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : extension === 'gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
        : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) fail('WRITING_IMAGE_INVALID');
  return { bytes, filename: `${hash(bytes)}.${extension}` };
}
async function directoryFor(registry, config, input) {
  const workspace = registry.list().find(item => item.id === input.workspaceId);
  if (!workspace || typeof input.requirementPath !== 'string') fail('WRITING_SAVE_TARGET_REQUIRED');
  const path = normalizeSourcePath(`${input.requirementPath}/requirement.md`);
  if (path.split('/').length !== 3) fail('WRITING_SAVE_TARGET_REQUIRED');
  const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
  if (docsRoot !== resolve(workspace.path)) await safeDocumentPath(workspace.path, config.docsDir || 'docs');
  const directory = await safeDocumentPath(docsRoot, path.slice(0, -'/requirement.md'.length));
  if (!(await stat(directory)).isDirectory()) fail('WRITING_SAVE_TARGET_REQUIRED');
  return directory;
}
export async function externalizeWritingImages(registry, config, input, assertActive = () => {}) {
  if (!input || typeof input !== 'object') fail('WRITING_IMAGE_INVALID');
  if (!registry.list().some(workspace => workspace.id === input.workspaceId)) throw knowledgeError('WRITING_SCOPE_DENIED', 403);
  if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > WRITING_IMAGE_INPUT_LIMIT) fail('WRITING_IMAGE_TOO_LARGE');
  const nodes = imagesIn(input.content);
  if (!nodes.length) return { content: input.content, images: [] };
  if (nodes.length > 32) fail('WRITING_IMAGE_TOO_LARGE');
  const images = nodes.map(node => ({ node, ...decode(node.url) }));
  const directory = await directoryFor(registry, config, input);
  const folder = await safeDocumentPath(directory, 'assets/images', { allowMissing: true });
  assertActive(); await mkdir(folder, { recursive: true });
  await safeDocumentPath(directory, 'assets/images');
  for (const { filename, bytes } of new Map(images.map(image => [image.filename, image])).values()) {
    const path = await safeDocumentPath(directory, `assets/images/${filename}`, { allowMissing: true });
    await withDocumentLock(path, async () => {
      assertActive(); await safeDocumentPath(directory, `assets/images/${filename}`, { allowMissing: true });
      try { await writeFile(path, bytes, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const info = await stat(path); if (!info.isFile() || info.size !== bytes.length || hash(await readFile(path)) !== hash(bytes)) fail('WRITING_IMAGE_CONFLICT');
      }
    });
  }
  let content = input.content;
  for (const image of images.sort((a, b) => b.node.position.start.offset - a.node.position.start.offset)) {
    const { start, end } = image.node.position;
    const source = content.slice(start.offset, end.offset);
    if (!source.includes(image.node.url)) fail('WRITING_IMAGE_INVALID');
    content = content.slice(0, start.offset) + source.replace(image.node.url, `assets/images/${image.filename}`) + content.slice(end.offset);
  }
  assertActive();
  return { content, images: [...new Set(images.map(image => `assets/images/${image.filename}`))] };
}
export async function readWritingImage(registry, config, input) {
  if (!filenamePattern.test(input.filename || '')) fail('WRITING_IMAGE_INVALID');
  const directory = await directoryFor(registry, config, input);
  const path = await safeDocumentPath(directory, `assets/images/${input.filename}`);
  const info = await stat(path); if (!info.isFile() || info.size > 8_000_000) fail('WRITING_IMAGE_INVALID');
  const bytes = await readFile(path);
  if (hash(bytes) !== input.filename.split('.')[0]) fail('WRITING_IMAGE_CONFLICT');
  return { bytes, contentType: mime[input.filename.split('.')[1]] };
}
