import { hash } from './source-reader.js';
import { conversationError } from '../conversations/store.js';
import { renderSessionTurn } from '../session-utils.js';

export const IMPORT_VERSION = 'conversation-turns-v1';
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

/** Native turn IDs survive appends/reordering; older exports use guarded ordinals. */
export function describeTurns(snapshot) {
  const seen = new Set();
  return snapshot.turns.map((turn, position) => {
    const key = turn.sourceTurnId ? `id:${turn.sourceTurnId}` : `number:${turn.turnNumber ?? position + 1}`;
    if (seen.has(key)) throw conversationError('KNOWLEDGE_TURN_IDENTITY_CONFLICT');
    seen.add(key);
    return { key, position, number: turn.turnNumber ?? position + 1, turn,
      anchor: hash(turn.messages.find(message => message.role === 'user')?.text || ''),
      hash: hash(JSON.stringify({ messages: turn.messages, status: turn.status, syncable: turn.syncable })) };
  });
}

export function matchingTurn(prior, item) {
  const exact = prior.find(turn => turn.key === item.key);
  if (exact) return exact;
  const candidates = prior.filter(turn => turn.number === item.number && turn.anchor === item.anchor && turn.key.startsWith('id:') !== item.key.startsWith('id:'));
  if (candidates.length > 1 || (!candidates.length && item.key.startsWith('number:') && prior.some(turn => turn.number === item.number && turn.key.startsWith('id:')))) throw conversationError('KNOWLEDGE_TURN_IDENTITY_CONFLICT');
  return candidates[0];
}

/** One target entry per conversation. Only selected turns may replace prior content. */
export function importConversationBatch(store, selections) {
  const result = store.transaction(() => {
    const summaries = []; let outputBytes = 0;
    for (const selection of selections) {
      const old = store.db.prepare('SELECT * FROM conversation_imports WHERE scope_id=? AND conversation_id=?').get(store.scopeId, selection.id);
      const saved = old ? JSON.parse(old.payload) : { turns: [], title: selection.title };
      const merged = new Map(saved.turns.map(turn => [turn.key, turn]));
      const counts = { added: 0, updated: 0, skipped: 0 };
      for (const selectedTurn of selection.turns) {
        let item = selectedTurn;
        const previous = matchingTurn([...merged.values()], item);
        // A library snapshot created before native IDs were exposed can be
        // matched only when its ordinal and user input both still agree.
        if (previous && previous.key !== item.key) {
          if (item.key.startsWith('id:')) merged.delete(previous.key);
          else item = { ...item, key: previous.key };
        }
        if (previous && selection.origin.source === 'codex' && item.key.startsWith('number:') && previous.anchor !== item.anchor) throw conversationError('KNOWLEDGE_TURN_IDENTITY_CONFLICT');
        if (previous?.hash === item.hash && previous.key === item.key) { counts.skipped++; continue; }
        counts[previous ? 'updated' : 'added']++;
        merged.set(item.key, { ...item, snapshotVersion: selection.version, importedAt: new Date().toISOString() });
      }
      if (old && !counts.added && !counts.updated) {
        summaries.push({ ...counts, conversationId: selection.id, documentId: old.document_id }); continue;
      }
      const turns = [...merged.values()].sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
      let text = `# ${saved.title}\n\n> 会话原始记录。中间回复和未完成轮次不代表已确认结论。\n\n`;
      const locations = [], provenanceTurns = [];
      for (const item of turns) {
        const startLine = text.split('\n').length;
        text += renderSessionTurn(item.turn) + '\n';
        const endLine = text.split('\n').length - 1;
        locations.push({ turnNumber: item.number, startLine, endLine });
        provenanceTurns.push({ key: item.key, number: item.number, status: item.turn.status, syncable: item.turn.syncable, snapshotVersion: item.snapshotVersion, contentHash: item.hash, startLine, endLine });
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw conversationError('KNOWLEDGE_IMPORT_TOO_LARGE', 413);
      const conversation = { ...selection.origin, id: selection.id, title: saved.title, turns: provenanceTurns };
      outputBytes += Buffer.byteLength(text, 'utf8') + Buffer.byteLength(JSON.stringify(conversation), 'utf8');
      if (outputBytes > MAX_IMPORT_BYTES) throw conversationError('KNOWLEDGE_IMPORT_TOO_LARGE', 413);
      const published = store.publishDocumentRow({ relativePath: `conversation://${selection.id}`, title: saved.title, text,
        contentHash: hash(JSON.stringify([text, conversation])), coordinate: 'conversation', conversation, locations }, IMPORT_VERSION);
      store.db.prepare('INSERT INTO conversation_imports VALUES(?,?,?,?) ON CONFLICT(scope_id,conversation_id) DO UPDATE SET payload=excluded.payload').run(store.scopeId, selection.id, published.documentId, JSON.stringify({ title: saved.title, turns }));
      summaries.push({ ...counts, conversationId: selection.id, documentId: published.documentId });
    }
    return { entries: summaries, added: summaries.reduce((sum, entry) => sum + entry.added, 0), updated: summaries.reduce((sum, entry) => sum + entry.updated, 0), skipped: summaries.reduce((sum, entry) => sum + entry.skipped, 0) };
  });
  // Projection is repairable. A retry after a filesystem failure is idempotent,
  // and repairs even an unchanged entry without adding another knowledge version.
  for (const entry of result.entries) store.projectDocument(store.db.prepare('SELECT * FROM documents WHERE id=?').get(entry.documentId));
  return result;
}
