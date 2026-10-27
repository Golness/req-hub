import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexSource } from './source.js';
import { ConversationStore } from '../conversations/store.js';
import { ConversationService } from '../conversations/service.js';

/** Read-only source adapter. All persistence belongs to the conversation library. */
export class CodexSessionService {
  constructor({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), databasePath, library, owner } = {}) {
    this.source = new CodexSource(codexHome);
    this.library = library || new ConversationService({ store: new ConversationStore(databasePath), owner });
    this.ownsLibrary = !library;
    this.adapter = { source: 'codex', instance: resolve(codexHome), inventory: () => this.source.inventory(), snapshot: session => this.source.snapshot(session) };
  }
  database() { return this.library.store.database(); }
  workspaces() { return this.source.inventory().then(({ workspaces, sessions, warnings }) => ({
    workspaces: workspaces.map(workspace => ({ ...workspace, sessionPaths: [...new Set(sessions.filter(session => session.workspaceId === workspace.id).map(session => session.cwd).filter(Boolean))] })), warnings,
  })); }
  async list(workspaceId) { this.workspaceId = workspaceId; return this.library.list(workspaceId, this.adapter); }
  refresh(workspaceId, projectId, progress) { this.workspaceId = workspaceId; return this.library.refresh(workspaceId, projectId, this.adapter, progress); }
  snapshot(id, workspaceId = this.workspaceId) { return this.library.snapshot(workspaceId, id, this.adapter); }
  snapshots(ids, workspaceId = this.workspaceId) { return this.library.snapshots(workspaceId, ids, this.adapter); }
  async close() { if (this.ownsLibrary) { await this.library.close(); await this.library.store.close(); } }
}
