import { fromMarkdown } from 'mdast-util-from-markdown';
import { createTwoFilesPatch, parsePatch, applyPatch, reversePatch, diffChars } from 'diff';
import { readFile, writeFile, rename, lstat, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashBytes, decodeDocument } from './sync-artifacts.js';

const locks = new Map();
export async function withDocumentLock(path, action) {
  const key = resolve(path).toLowerCase(), previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(done => { release = done; }); locks.set(key, current);
  await previous;
  try { return await action(); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
}
export async function readDocumentVersion(path) {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('DOCUMENT_SYMLINK');
    return { exists: true, bytes: await readFile(path) };
  } catch (error) { if (error.code === 'ENOENT') return { exists: false, bytes: Buffer.alloc(0) }; throw error; }
}
export async function atomicWrite(path, bytes, signal, assertActive) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try { signal?.throwIfAborted(); assertActive?.(); await writeFile(temp, bytes, { flag: 'wx' }); signal?.throwIfAborted(); assertActive?.(); await rename(temp, path); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
/** Parser positions index original UTF-16 text; no Markdown reserialization. */
export function indexDocument(bytes) {
  const text = decodeDocument(bytes), originalHash = hashBytes(bytes);
  const nodes = fromMarkdown(text).children;
  if (!nodes.length) return [{ id: originalHash.slice(0, 16) + ':empty', start: 0, end: text.length, type: 'empty' }];
  return nodes.map((node, i) => ({ id: originalHash.slice(0, 16) + ':' + i,
    type: node.type, start: i ? node.position.start.offset : 0,
    end: i + 1 < nodes.length ? nodes[i + 1].position.start.offset : text.length }));
}

export function validateChanges(value, blocks, evidenceIds) {
  const fail = (code, path, actual, expected, hint) => {
    const details = { path, actual: actual ?? null, expected, hint };
    throw Object.assign(new Error(code + ': ' + JSON.stringify(details)), { code, details });
  };
  if (!value || !Array.isArray(value.changes) || !Array.isArray(value.pending)) fail('ANALYSIS_SCHEMA', 'content', typeof value, '{changes:[],pending:[]}', 'Both fields must be arrays.');
  const ids = new Set();
  for (const [index, change] of value.changes.entries()) {
    const path = `changes[${index}]`;
    if (!change || typeof change.id !== 'string' || !change.id.trim() || ids.has(change.id)) fail('CHANGE_ID', path + '.id', change?.id, 'unique non-empty string', 'Preserve the analysis and fix this field only.');
    ids.add(change.id);
    if (!['add', 'modify', 'delete'].includes(change.action)) fail('CHANGE_ACTION', path + '.action', change.action, ['add','modify','delete'], 'Use one of the exact action values.');
    if (!blocks.some(b => b.id === change.blockId)) fail('CHANGE_BLOCK_ID', path + '.blockId', change.blockId, blocks.slice(0,8).map(b => b.id), `Copy the exact ID; do not retype its hash. These are the first ${Math.min(8,blocks.length)} of ${blocks.length} authorized IDs; document.blocks contains the full list. Evidence references are not the failing field.`);
    for (const field of ['reason','proposal']) if (typeof change[field] !== 'string' || !change[field].trim()) fail('CHANGE_TEXT', path + '.' + field, change[field], 'non-empty string', 'Keep the actual evidence-based analysis; do not replace it with placeholders.');
    if (!Array.isArray(change.evidenceRefs) || !change.evidenceRefs.length) fail('CHANGE_EVIDENCE_OR_SCOPE', path + '.evidenceRefs', change.evidenceRefs, 'non-empty array of authorized evidence IDs', 'Use exact IDs from the task manifest.');
    const invalidRefs = change.evidenceRefs.filter(id => !evidenceIds.includes(id));
    if (invalidRefs.length) fail('CHANGE_EVIDENCE_OR_SCOPE', path + '.evidenceRefs', invalidRefs, evidenceIds.slice(0,8), `Only evidenceRefs is failing. These are the first ${Math.min(8,evidenceIds.length)} of ${evidenceIds.length} authorized evidence IDs; use the full task manifest. Preserve .part-N suffixes. document.blocks is a document index, not change evidence.`);
  }
  for (const [index, pending] of value.pending.entries()) {
    for (const field of ['id','reason']) if (!pending || typeof pending[field] !== 'string' || !pending[field].trim()) fail('PENDING_SCHEMA', `pending[${index}].${field}`, pending?.[field], 'non-empty string', 'Pending entries must be objects with id and reason; preserve genuine uncertainty, never use test placeholders.');
  }
  return value;
}

export function parseAnalysisChanges(raw, blocks, evidenceIds) {
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error('ANALYSIS_JSON_INVALID: content must be one valid JSON object without Markdown fences or tool-call markup. ' + error.message); }
  return validateChanges(value, blocks, evidenceIds);
}

/** Translate parser positions through prior native edits; never performs a replacement. */
export function assertEditInBlock(originalBytes, currentBytes, editedBytes, blockId, blocks) {
  const original = decodeDocument(originalBytes), current = decodeDocument(currentBytes), edited = decodeDocument(editedBytes);
  const block = blocks.find(item => item.id === blockId);
  if (!block) throw new Error('EDIT_BLOCK_UNKNOWN');
  const parts = diffChars(original, current);
  const translate = boundary => {
    let oldOffset = 0, newOffset = 0;
    for (const part of parts) {
      if (part.added) { newOffset += part.value.length; continue; }
      if (boundary <= oldOffset + part.value.length) return newOffset + (part.removed ? 0 : boundary - oldOffset);
      oldOffset += part.value.length;
      if (!part.removed) newOffset += part.value.length;
    }
    return current.length;
  };
  const start = translate(block.start), end = translate(block.end);
  let offset = 0;
  for (const part of diffChars(current, edited)) {
    if ((part.added || part.removed) && (offset < start || offset + (part.removed ? part.value.length : 0) > end)) throw new Error('EDIT_BLOCK_MISMATCH');
    if (!part.added) offset += part.value.length;
  }
}

/** Strict replay and byte identity are independent of model-authored hunk counts. */
export function validateCandidate(originalBytes, candidateBytes, fileName, authorizedChanges, blocks) {
  if (!['requirement.md', 'design.md'].includes(fileName)) throw new Error('PATCH_SCOPE_INVALID');
  const before = decodeDocument(originalBytes), after = decodeDocument(candidateBytes);
  if (before === after) return { patch: '', originalHash: hashBytes(originalBytes), candidateHash: hashBytes(candidateBytes), noChange: true };
  if (!before && !/^\uFEFF?#\s+\S/.test(after)) throw new Error('DOCUMENT_TITLE_REQUIRED');
  if (before && !after) throw new Error('DOCUMENT_DELETE_FORBIDDEN');
  // Existing documents must retain encoding markers and the original trailing-newline convention.
  if (before && (before.startsWith('\uFEFF') !== after.startsWith('\uFEFF') || /\r?\n$/.test(before) !== /\r?\n$/.test(after))) throw new Error('DOCUMENT_FORMAT_CHANGED');
  const windows = authorizedChanges.map(c => blocks.find(b => b.id === c.blockId)).filter(Boolean);
  let offset = 0;
  for (const part of diffChars(before, after)) {
    if (part.added || part.removed) {
      const end = part.removed ? offset + part.value.length : offset;
      if (!windows.some(w => offset >= w.start && end <= w.end)) throw new Error('EDIT_OUT_OF_SCOPE');
    }
    if (!part.added) offset += part.value.length;
  }
  if (before.split(/\r?\n/).filter(line => line.trim()).length > 1) {
    const removed = diffChars(before, after).filter(p => p.removed).reduce((n, p) => n + p.value.length, 0);
    if (removed >= before.length * 0.9) throw new Error('WHOLE_DOCUMENT_REWRITE');
  }
  const patch = createTwoFilesPatch('a/' + fileName, 'b/' + fileName, before, after, '', '', { context: 3, ignoreWhitespace: false, stripTrailingCr: false });
  const parsed = parsePatch(patch);
  if (parsed.length !== 1 || parsed[0].oldFileName !== 'a/' + fileName || parsed[0].newFileName !== 'b/' + fileName) throw new Error('PATCH_SCOPE_INVALID');
  const options = { fuzzFactor: 0, autoConvertLineEndings: false };
  const replay = applyPatch(before, parsed[0], options), undo = applyPatch(after, reversePatch(parsed[0]), options);
  if (replay === false || undo === false || !Buffer.from(replay).equals(candidateBytes) || !Buffer.from(undo).equals(originalBytes)) throw new Error('PATCH_ROUNDTRIP_FAILED');
  fromMarkdown(after);
  return { patch, originalHash: hashBytes(originalBytes), candidateHash: hashBytes(candidateBytes), noChange: false };
}

/** Journal makes interrupted publishing recoverable without overwriting a new user edit. */
export async function publishDocument({ docPath, syncDir, fileName, original, candidateBytes, validation, signal, assertActive }) {
  if (!['requirement.md', 'design.md'].includes(fileName) || hashBytes(original.bytes) !== validation.originalHash || hashBytes(candidateBytes) !== validation.candidateHash) throw new Error('PUBLISH_VALIDATION_MISMATCH');
  return withDocumentLock(docPath, async () => {
    signal?.throwIfAborted();
    const current = await readDocumentVersion(docPath);
    if (current.exists !== original.exists || !current.bytes.equals(original.bytes)) throw new Error('同步期间主文档已被修改，请基于最新文档重试');
    const snapshot = join(syncDir, fileName), journal = { schemaVersion: 2, stage: 'prepared', fileName,
      docPath: resolve(docPath), originalExists: original.exists, originalHash: validation.originalHash, candidateHash: validation.candidateHash };
    await atomicWrite(snapshot, candidateBytes, signal, assertActive);
    await atomicWrite(join(syncDir, 'publish-journal.json'), JSON.stringify(journal, null, 2), signal, assertActive);
    signal?.throwIfAborted();
    // Recheck under the shared lock immediately before replacing the live document.
    const latest = await readDocumentVersion(docPath);
    if (latest.exists !== original.exists || !latest.bytes.equals(original.bytes)) throw new Error('PUBLISH_CONFLICT');
    await atomicWrite(docPath, candidateBytes, signal, assertActive);
    if (!(await readFile(docPath)).equals(candidateBytes)) throw new Error('PUBLISH_CONFLICT');
    await atomicWrite(join(syncDir, 'publish-journal.json'), JSON.stringify({ ...journal, stage: 'document_written' }, null, 2), signal, assertActive);
    return journal;
  });
}
