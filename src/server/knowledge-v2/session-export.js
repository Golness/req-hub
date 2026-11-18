import { contentTemplates } from '../content-templates.js';
import { digest, fail, now, LIMITS } from './contracts.js';

export const SESSION_EXPORT_VERSION = 'kb-session-v1';

/**
 * Normalize a frozen turn into readable messages for the read-only preview.
 * Native turns carry labelled messages; legacy snapshots only expose
 * userInput/summary, and tool-only turns may carry no text at all.
 * @param turn - One projected conversation turn.
 * @returns [{role, kind, label, text}] with non-empty text only.
 */
export function sessionMessages(turn) {
  const normalize = (source) =>
    source
      .map((message, index) => {
        const role = message?.role === 'user' ? 'user' : 'assistant';
        const raw =
          typeof message?.text === 'string'
            ? message.text
            : typeof message?.content === 'string'
              ? message.content
              : '';
        return {
          role,
          kind:
            message?.kind ||
            (role === 'user' ? 'input' : index === source.length - 1 ? 'final' : 'intermediate'),
          label:
            message?.label ||
            (role === 'user'
              ? contentTemplates().session.labels.userInput
              : contentTemplates().session.labels.assistantReply),
          text: raw,
        };
      })
      .filter((message) => message.text.trim());
  const stored = Array.isArray(turn?.messages) ? turn.messages : [];
  const normalized = normalize(stored);
  if (normalized.length || !(turn?.userInput || turn?.summary)) {
    return normalized;
  }
  const labels = contentTemplates().session.labels;
  return normalize([
    { role: 'user', kind: 'input', label: labels.userInput, text: turn.userInput || '' },
    { role: 'assistant', kind: 'final', label: labels.assistantFinal, text: turn.summary || '' },
  ]);
}

/**
 * Native turn IDs survive appends/reordering; older exports use guarded ordinals.
 * The original message array stays in hashes so existing imports keep their state.
 * @param snapshot - A frozen conversation snapshot.
 * @returns Turn selection metadata and content hashes.
 */
export function describeTurns(snapshot) {
  const seen = new Set();
  return snapshot.turns.map((turn, position) => {
    const key = turn.sourceTurnId
      ? `id:${turn.sourceTurnId}`
      : `number:${turn.turnNumber ?? position + 1}`;
    if (seen.has(key)) {
      fail('KB_TURN_IDENTITY_CONFLICT', 409);
    }
    seen.add(key);
    const messages = Array.isArray(turn.messages) ? turn.messages : [];
    return {
      key,
      position,
      number: turn.turnNumber ?? position + 1,
      turn,
      anchor: digest(
        messages.find((message) => message.role === 'user')?.text || turn.userInput || '',
      ),
      hash: digest(JSON.stringify({ messages, status: turn.status, syncable: turn.syncable })),
    };
  });
}

/**
 * Match a selected turn to a prior import without accepting ambiguous identity.
 * @param prior - Previously imported turn records.
 * @param item - The selected turn descriptor.
 * @returns The matching turn, or undefined; ambiguity throws.
 */
export function matchingTurn(prior, item) {
  const exact = prior.find((turn) => turn.key === item.key);
  if (exact) {
    return exact;
  }
  const candidates = prior.filter(
    (turn) =>
      turn.number === item.number &&
      turn.anchor === item.anchor &&
      turn.key.startsWith('id:') !== item.key.startsWith('id:'),
  );
  if (
    candidates.length > 1 ||
    (!candidates.length &&
      item.key.startsWith('number:') &&
      prior.some((turn) => turn.number === item.number && turn.key.startsWith('id:')))
  ) {
    fail('KB_TURN_IDENTITY_CONFLICT', 409);
  }
  return candidates[0];
}

/**
 * Merge selected turns into prior imported turns with guarded identity.
 * @param prior - Prior provenance turn descriptors.
 * @param selected - Frozen selected turn descriptors.
 * @param options - {source, mode}; replace keeps only the selected turns.
 * @returns {turns, counts} with merged descriptors and change counters.
 */
export function mergeSessionTurns(prior, selected, { source, mode }) {
  const restored = (mode === 'replace' ? [] : prior).map((item) => ({
    ...item,
    turn: item.turn || {
      status: item.status,
      syncable: item.syncable,
      messages: sessionMessages(item),
    },
  }));
  const merged = new Map(restored.map((turn) => [turn.key, turn]));
  const counts = { added: 0, updated: 0, skipped: 0 };
  for (const selectedTurn of selected) {
    let item = selectedTurn;
    const previous = matchingTurn([...merged.values()], item);
    // A snapshot created before native IDs were exposed matches only when its
    // ordinal and user input anchor both still agree.
    if (previous && previous.key !== item.key) {
      if (item.key.startsWith('id:')) {
        merged.delete(previous.key);
      } else {
        item = { ...item, key: previous.key };
      }
    }
    if (
      previous &&
      source === 'codex' &&
      item.key.startsWith('number:') &&
      previous.anchor !== item.anchor
    ) {
      fail('KB_TURN_IDENTITY_CONFLICT', 409);
    }
    if (previous?.hash === item.hash && previous.key === item.key) {
      counts.skipped++;
      merged.set(item.key, { ...previous, turn: item.turn });
      continue;
    }
    counts[previous ? 'updated' : 'added']++;
    merged.set(item.key, { ...item, importedAt: now() });
  }
  const turns = [...merged.values()].sort(
    (a, b) => a.position - b.position || a.key.localeCompare(b.key),
  );
  return { turns, counts };
}

function renderTurn(item) {
  const session = contentTemplates().session;
  if (!sessionMessages(item.turn).length) {
    fail('KB_SESSION_PROVENANCE_INVALID', 409, { turnKey: item.key });
  }
  const status =
    item.turn.status === 'completed'
      ? ''
      : item.turn.status === 'running'
        ? session.pending
        : `（${item.turn.status || 'unknown'}）`;
  return (
    session.turnHeading(item.number, status) +
    (item.turn.messages?.length ? item.turn.messages : sessionMessages(item.turn))
      .map((message) => `### ${message.label}\n\n${message.text}\n`)
      .join('\n')
  );
}

/**
 * Render the merged session as a real Markdown document with turn line ranges.
 * @param input - {title, origin, snapshotVersion, turns} merged descriptors.
 * @returns {markdown, turns} where turns carry startLine/endLine provenance.
 */
export function buildSessionDocument({ title, origin, snapshotVersion, turns }) {
  const session = contentTemplates().session;
  let text =
    `# ${title}\n\n` +
    session.provenance(origin.provider, origin.sessionId, snapshotVersion) +
    session.notice;
  const records = [];
  for (const item of turns) {
    const startLine = text.split('\n').length;
    text += renderTurn(item) + '\n';
    const endLine = text.split('\n').length - 1;
    records.push({
      key: item.key,
      position: item.position,
      number: item.number,
      anchor: item.anchor,
      hash: item.hash,
      status: item.turn.status,
      syncable: item.turn.syncable,
      snapshotVersion: item.snapshotVersion || snapshotVersion,
      messages: sessionMessages(item.turn),
      startLine,
      endLine,
    });
  }
  if (Buffer.byteLength(text, 'utf8') > LIMITS.sourceBytes) {
    fail('KB_FILE_TOO_LARGE', 413, { limitBytes: LIMITS.sourceBytes });
  }
  return { markdown: text, turns: records };
}
