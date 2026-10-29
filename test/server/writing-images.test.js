import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalizeWritingImages, readWritingImage } from '../../src/server/writing-images.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=';
const data = `data:image/png;base64,${png}`;
const requirementPath = 'alice/2026-10-29-images';
let root, registry, directory;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rh-writing-images-'));
  directory = join(root, 'docs', requirementPath); await mkdir(directory, { recursive: true });
  registry = { list: () => [{ id: 'ws', path: root }] };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const input = content => ({ workspaceId: 'ws', requirementPath, content });
it('stores exact image bytes once and replaces both inline and reference image URLs', async () => {
  const content = `# Draft\n\n![截图](${data} "title")\n\n![same][shot]\n\n[shot]: <${data}>\n`;
  const result = await externalizeWritingImages(registry, { docsDir: 'docs' }, input(content));
  expect(result.images).toHaveLength(1); expect(result.content).not.toContain('base64');
  expect(result.content).toContain('![截图](assets/images/'); expect(result.content).toContain('"title")');
  expect(result.content).toContain('[shot]: <assets/images/');
  const bytes = await readFile(join(directory, result.images[0])); expect(bytes).toEqual(Buffer.from(png, 'base64'));
  await externalizeWritingImages(registry, { docsDir: 'docs' }, input(content));
  expect(await readdir(join(directory, 'assets/images'))).toHaveLength(1);
  const image = await readWritingImage(registry, { docsDir: 'docs' }, { ...input(''), filename: result.images[0].split('/').at(-1) });
  expect(image.contentType).toBe('image/png'); expect(image.bytes).toEqual(bytes);
});
it('leaves code examples and ordinary links unchanged and is idempotent on file links', async () => {
  const content = `\`\`\`md\n![example](${data})\n\`\`\`\n\n[ordinary](${data})\n![external](https://example.com/image.png)`;
  expect((await externalizeWritingImages(registry, {}, input(content))).content).toBe(content);
  const converted = await externalizeWritingImages(registry, {}, input(`![image](${data})`));
  expect(await externalizeWritingImages(registry, {}, input(converted.content))).toEqual({ content: converted.content, images: [] });
});
it('rejects unsafe formats and validates every image before writing any attachment', async () => {
  for (const url of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,aGVsbG8=', 'data:image/png;base64,broken']) {
    await expect(externalizeWritingImages(registry, {}, input(`![valid](${data})\n![invalid](${url})`))).rejects.toThrow('WRITING_IMAGE_INVALID');
  }
  expect(await readdir(directory)).toEqual([]);
});
it('rejects missing targets, traversal, unknown workspaces and links outside the selected requirement', async () => {
  for (const extra of [{ workspaceId: 'other' }, { requirementPath: '../outside' }, { requirementPath: null }]) {
    await expect(externalizeWritingImages(registry, {}, { ...input(`![image](${data})`), ...extra })).rejects.toThrow();
  }
  await expect(readWritingImage(registry, {}, { ...input(''), filename: '../requirement.md' })).rejects.toThrow();
  const elsewhere = join(root, 'elsewhere'); await mkdir(elsewhere);
  await symlink(elsewhere, join(directory, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(externalizeWritingImages(registry, {}, input(`![image](${data})`))).rejects.toThrow();
  expect(await readdir(elsewhere)).toEqual([]);
});
it('checks cancellation before writing generated files', async () => {
  await expect(externalizeWritingImages(registry, {}, input(`![image](${data})`), () => { throw new Error('cancelled'); })).rejects.toThrow('cancelled');
  expect(await readdir(directory)).toEqual([]);
});

it('converts HTML image attributes without touching adjacent HTML or script text', async () => {
  const content = `<div><img alt="shot" src="${data}" width="100"></div>\n<script>const sample = '${data}'</script>`;
  const converted = await externalizeWritingImages(registry, {}, input(content));
  expect(converted.content).toContain('<img alt="shot" src="assets/images/');
  expect(converted.content).toContain('width="100"'); expect(converted.content).toContain(`const sample = '${data}'`);
});
