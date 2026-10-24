import { open, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { BINARY_EXTENSIONS, MAX_BINARY_BYTES, parseBinary } from './binary-parser.js';

export const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.text', '.html', '.htm', '.json', ...BINARY_EXTENSIONS]);
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_BUILD_FILES = 200;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const knowledgeError = (message, status = 400) => Object.assign(new Error(message), { status });

export function normalizeSourcePath(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) throw knowledgeError('文件路径无效');
  const path = value.replaceAll('\\', '/');
  const parts = path.split('/');
  if (isAbsolute(path) || /^[a-z]:/i.test(path) || parts.some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw knowledgeError('文件路径越界');
  if (parts.length < 3 || parts[0].startsWith('.') || !/^\d{4}-\d{2}-\d{2}-.+/.test(parts[1]) || parts.slice(2, -1).some(p => p.startsWith('.'))) throw knowledgeError('文件不属于有效需求目录');
  if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) throw knowledgeError('不支持的文件类型');
  return path;
}

export function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

export async function readSource(docsRoot, input, { metadataOnly = false, signal } = {}) {
  signal?.throwIfAborted();
  const relativePath = normalizeSourcePath(input);
  const extension = extname(relativePath).toLowerCase();
  const binary = BINARY_EXTENSIONS.has(extension);
  const limit = binary ? MAX_BINARY_BYTES : MAX_FILE_BYTES;
  const oversized = () => knowledgeError(`文件超过 ${binary ? 20 : 2} MiB 限制`, 413);
  const root = await realpath(docsRoot);
  const path = await realpath(resolve(root, relativePath));
  if (!inside(root, path)) throw knowledgeError('文件路径越界');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw knowledgeError('所选项不是文件');
    if (stat.size > limit) throw oversized();
    // Bounded read also covers a file that grows after stat().
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw oversized();
    // Detect growth beyond the allocated snapshot as well as the byte limit.
    if (offset === buffer.length) throw knowledgeError('读取期间文件大小已改变，请重试', 409);
    const bytes = buffer.subarray(0, offset);
    const metadata = { relativePath, contentHash: hash(bytes), mtime: stat.mtime.toISOString() };
    if (metadataOnly) return metadata;
    if (binary) return { ...metadata, ...await parseBinary(bytes, extension, { signal }) };
    if (bytes.includes(0)) throw knowledgeError('文件包含二进制内容');
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let text = raw;
    if (/\.html?$/i.test(relativePath)) {
      text = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<\/(?:p|div|h[1-6]|li|tr|section)>/gi, '\n').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
        .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => { const v = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : ''; })
        .replace(/&(nbsp|lt|gt|amp|quot|apos);/g, (_, name) => ({ nbsp: ' ', lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[name]);
    } else if (/\.json$/i.test(relativePath)) {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    }
    return { ...metadata, coordinate: /\.(html?|json)$/i.test(relativePath) ? 'extracted' : 'source', text };
  } finally { await file.close(); }
}
