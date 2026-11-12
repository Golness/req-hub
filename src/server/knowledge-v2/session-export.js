import { digest, fail, now, LIMITS } from './contracts.js';

export const SESSION_EXPORT_VERSION = 'kb-session-v1';

/**
 * Native turn IDs survive appends/reordering; older exports use guarded ordinals.
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
    return {
      key,
      position,
      number: turn.turnNumber ?? position + 1,
      turn,
      anchor: digest(turn.messages.find((message) => message.role === 'user')?.text || ''),
      hash: digest(
        JSON.stringify({ messages: turn.messages, status: turn.status, syncable: turn.syncable }),
      ),
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
  const merged = new Map((mode === 'replace' ? [] : prior).map((turn) => [turn.key, turn]));
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
  const status =
    item.turn.status === 'completed'
      ? ''
      : item.turn.status === 'running'
        ? '（进行中）'
        : `（${item.turn.status || 'unknown'}）`;
  return (
    `## 第 ${item.number} 轮${status}\n\n` +
    (item.turn.messages || [])
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
  let text =
    `# ${title}\n\n` +
    `来源：${origin.provider}；会话 ID：${origin.sessionId}；快照：${snapshotVersion}\n` +
    `说明：下列内容是会话记录；未完成回复不表示已确认事实。\n\n`;
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
      messages: item.turn.messages,
      startLine,
      endLine,
    });
  }
  if (Buffer.byteLength(text, 'utf8') > LIMITS.sourceBytes) {
    fail('KB_FILE_TOO_LARGE', 413, { limitBytes: LIMITS.sourceBytes });
  }
  return { markdown: text, turns: records };
}
