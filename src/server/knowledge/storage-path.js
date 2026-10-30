import { homedir } from 'node:os';
import { join } from 'node:path';

// Same DSH_HOME convention as the reference plugin, with ReqHub's own database.
/**
 * Locate the global knowledge database.
 * @returns The default absolute database path.
 */
export function defaultKnowledgeDatabasePath() {
  return join(
    process.env.DSH_HOME || join(homedir(), '.dsh'),
    'req-hub',
    'knowledge',
    'knowledge.sqlite',
  );
}
