import { hasWritingImages } from './writing-images.js';
import { stat, writeFile } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { safeDocumentPath } from './safe-path.js';
import { withDocumentLock, readDocumentVersion, atomicWrite } from './sync-document-validator.js';

const fail = (code, status = 400, details = {}) => { throw Object.assign(new Error(code), { status, details }); };
const version = bytes => createHash('sha256').update(bytes).digest('hex');
export async function saveWriting(registry, config, input, assertActive) {
  const workspace = registry.list().find(item => item.id === input.workspaceId);
  if (!workspace || !['requirement', 'design'].includes(input.docType) || typeof input.content !== 'string' || !input.content.trim() || Buffer.byteLength(input.content) > 1_000_000) fail('WRITING_SAVE_INVALID');
  if (typeof input.requirementPath !== 'string' || typeof input.requirementId !== 'string' || !input.requirementId || basename(input.requirementPath.replaceAll('\\', '/')) !== input.requirementId) fail('WRITING_SAVE_TARGET_REQUIRED');
  if (input.requirementPath.replaceAll('\\', '/').split('/').length !== 2 || !/^\d{4}-\d{2}-\d{2}-.+/.test(input.requirementId)) fail('WRITING_SAVE_TARGET_REQUIRED');
  if (hasWritingImages(input.content)) fail('WRITING_INLINE_IMAGES');
  const docsDir = config.docsDir || 'docs', docsRoot = resolve(workspace.path, docsDir);
  if (docsRoot !== resolve(workspace.path)) await safeDocumentPath(workspace.path, docsDir);
  const directory = await safeDocumentPath(docsRoot, input.requirementPath);
  if (!(await stat(directory)).isDirectory()) fail('WRITING_SAVE_TARGET_REQUIRED');
  const filename = input.docType === 'requirement' ? 'requirement.md' : 'design.md';
  const target = await safeDocumentPath(directory, filename, { allowMissing: true });
  return withDocumentLock(target, async () => {
    assertActive();
    await safeDocumentPath(docsRoot, join(input.requirementPath, filename), { allowMissing: true });
    const metadata = await stat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (metadata && (!metadata.isFile() || metadata.size > 1_000_000)) fail('WRITING_SAVE_INVALID');
    const current = await readDocumentVersion(target);
    const currentVersion = current.exists ? version(current.bytes) : null;
    if (current.exists && input.expectedVersion === undefined) fail('WRITING_FILE_EXISTS', 409, { version: currentVersion, filename });
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) fail('WRITING_SAVE_CONFLICT', 409, { version: currentVersion, filename });
    assertActive();
    if (current.exists) await atomicWrite(target, input.content, undefined, assertActive);
    else {
      try { await writeFile(target, input.content, { flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') fail('WRITING_SAVE_CONFLICT', 409); throw error; }
    }
    return { success: true, filename, path: join(input.requirementPath, filename), version: version(Buffer.from(input.content)) };
  });
}
