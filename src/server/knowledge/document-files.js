/** Markdown projections beside the shared database, following dsh-knowledge's documents layout. */
import { mkdirSync, realpathSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, knowledgeError } from './source-reader.js';

export function writeKnowledgeDocument(root, document) {
  mkdirSync(root, { recursive: true });
  if (realpathSync(root) !== resolve(root)) throw knowledgeError('知识库文档目录不能通过符号链接重定向', 409);
  const stem = document.title.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').replace(/\s+/gu, '-').slice(0, 64) || 'document';
  const path = join(root, `${stem}--${hash(document.id).slice(0, 24)}.md`);
  const metadata = { id: document.id, workspaceId: document.workspaceId, workspaceTitle: document.workspaceTitle, sourcePath: document.path, version: document.version, ...(document.conversation ? { conversation: document.conversation } : {}) };
  const content = `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${document.body}`;
  try { if (readFileSync(path, 'utf8') === content) return path; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return path;
}
