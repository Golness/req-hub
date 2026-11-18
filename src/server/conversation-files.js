import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configFilePath, loadConfig } from './config.js';
import { safeDocumentPath } from './safe-path.js';
import { readReplicaFile } from './document-file.js';
import { atomicWrite, withDocumentLock } from './sync-document-validator.js';
import { renderSessionDocument } from './session-utils.js';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
/** Own local conversation exports; remote publication and reporting are separate consumers. */
export class ConversationFiles {
  /** @param options - Registry and profile-owned storage/configuration. */
  constructor({ registry, directory = dirname(configFilePath()), configLoader = loadConfig }) {
    Object.assign(this, { registry, configLoader });
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'conversation-files.sqlite'));
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,hash TEXT NOT NULL)');
      const legacyPath = join(directory, 'document-replicas.sqlite');
      if (existsSync(legacyPath)) {
        let legacy;
        try {
          legacy = new DatabaseSync(legacyPath, { readOnly: true });
          if (
            legacy
              .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='exports'")
              .get()
          ) {
            for (const row of legacy.prepare('SELECT id,hash FROM exports').all()) {
              this.db.prepare('INSERT OR IGNORE INTO exports VALUES(?,?)').run(row.id, row.hash);
            }
          }
        } catch {
          // A retired outbox cannot gate local exports; unproven existing files remain protected.
        } finally {
          legacy?.close();
        }
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.controller = new AbortController();
    this.pending = Promise.resolve();
  }
  run(action) {
    const next = this.pending.then(() => {
      this.controller.signal.throwIfAborted();
      return action();
    });
    this.pending = next.catch(() => {
      // The caller receives the export failure; later local exports must remain available.
    });
    return next;
  }
  async scope(workspaceId, config) {
    const workspace = this.registry.list().find((item) => item.id === workspaceId);
    if (!workspace) {
      throw failure('DOCUMENT_WORKSPACE_MISSING', 404);
    }
    const workspaceRoot = await realpath(workspace.path);
    const target = await safeDocumentPath(workspaceRoot, config.docsDir || 'docs', {
      allowMissing: true,
    });
    const root = await realpath(target).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return target;
    });
    return { workspace, root, id: hash(JSON.stringify([workspace.id, root])) };
  }

  /**
   * Export a newly synchronized authorized snapshot as a formal docs artifact.
   * @param input - Destination, provider identity, stable conversation identity and snapshot.
   * @returns Saved relative path; concurrent user edits reject without replacement.
   */
  exportConversation({ workspaceId, source, id, snapshot, signal }) {
    return this.run(async () => {
      const owned = signal
        ? AbortSignal.any([signal, this.controller.signal])
        : this.controller.signal;
      const config = await this.configLoader();
      const scope = await this.scope(workspaceId, config);
      const identity = hash(JSON.stringify([scope.id, source, id]));
      const path = join('sessions', `${identity}.md`);
      const text = `---\nsource: ${JSON.stringify(source)}\nconversation: ${JSON.stringify(id)}\nversion: ${JSON.stringify(snapshot.version)}\n---\n\n${renderSessionDocument(snapshot.sessionId || id, snapshot.turns)}`;
      const target = await safeDocumentPath(scope.root, path, { allowMissing: true });
      await withDocumentLock(target, async () => {
        owned.throwIfAborted();
        const expected = this.db.prepare('SELECT hash FROM exports WHERE id=?').get(identity)?.hash;
        let current;
        try {
          current = hash(
            (await readReplicaFile(scope.root, path, Number.MAX_SAFE_INTEGER, owned)).bytes,
          );
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
        const next = hash(text);
        if (current && current !== expected && current !== next) {
          throw failure('DOCUMENT_EXPORT_CONFLICT', 409);
        }
        await mkdir(dirname(target), { recursive: true });
        await safeDocumentPath(scope.root, path, { allowMissing: true });
        if (current !== next) {
          if (!current) {
            try {
              owned.throwIfAborted();
              await writeFile(target, text, { flag: 'wx' });
            } catch (error) {
              if (error.code === 'EEXIST') {
                throw failure('DOCUMENT_EXPORT_CONFLICT', 409);
              }
              throw error;
            }
          } else {
            const latest = await readReplicaFile(scope.root, path, Number.MAX_SAFE_INTEGER, owned);
            if (hash(latest.bytes) !== current) {
              throw failure('DOCUMENT_EXPORT_CONFLICT', 409);
            }
            await atomicWrite(target, text, owned, () => owned.throwIfAborted());
          }
        }
        owned.throwIfAborted();
        this.db.prepare('INSERT OR REPLACE INTO exports VALUES(?,?)').run(identity, next);
      });
      return { path };
    });
  }

  beginClose() {
    this.controller.abort();
  }
  close() {
    this.beginClose();
    this.closing ||= this.pending.then(() => this.db.close());
    return this.closing;
  }
}
