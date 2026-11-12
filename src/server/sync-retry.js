import { hashBytes } from './sync-artifacts.js';

/**
 * Read an immutable retry artifact through its authorized attempt and content hashes.
 * @param storage - Host-owned sync storage.
 * @param task - Authorized prior attempt, or undefined for a fresh execution.
 * @param id - Host-generated evidence identity.
 * @returns Parsed checkpoint, or null when this node never completed.
 */
export function readRetryArtifact(storage, task, id) {
  if (!storage || !task) {
    return null;
  }
  try {
    return JSON.parse(storage.readEvidence(task, id));
  } catch (error) {
    if (error.code === 'ARTIFACT_DENIED') {
      return null;
    }
    throw error;
  }
}

/**
 * Hash the complete node inputs while ignoring attempt-local tracking identities.
 * @param value - Frozen node inputs, manifests and effective prompt contract.
 * @returns SHA-256 fingerprint used to reject stale checkpoints.
 */
export function retryFingerprint(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) {
      return item.map(normalize);
    }
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item).map(([key, value]) => {
          if (key === 'task' && value && typeof value === 'object' && !Array.isArray(value)) {
            const { taskId, attempt, ...stable } = value;
            return [key, normalize(stable)];
          }
          return [key, normalize(value)];
        }),
      );
    }
    return item;
  };
  return hashBytes(Buffer.from(JSON.stringify(normalize(value))));
}
