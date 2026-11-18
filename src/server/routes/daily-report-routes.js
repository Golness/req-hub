import { json, readBody } from '../utils.js';
import { assertWorkspaceCaller } from '../application/caller.js';

/**
 * Expose daily report reads and retries through the same authenticated operation boundary.
 * @param registry - Authoritative Host workspace registry.
 * @param reports - Plugin-owned daily journal.
 * @returns Exact routes; Agent calls must prove their actual workspace ownership.
 */
export function createDailyReportRoutes(registry, reports) {
  return ['list', 'retry'].map((action) => {
    const method = action === 'list' ? 'GET' : 'POST';
    const execute = async (input, caller = {}) => {
      if (caller.kind === 'agent') {
        if (action === 'retry') {
          throw Object.assign(new Error('DAILY_USER_REQUIRED'), { status: 403 });
        }
        const workspace = registry.list().find((item) => item.id === input.workspaceId);
        await assertWorkspaceCaller(caller, workspace);
      }
      caller.signal?.throwIfAborted();
      const report = await reports.view(
        input.day,
        caller.kind === 'agent' ? input.workspaceId : undefined,
      );
      if (action === 'retry') {
        if (report.id !== input.id || !['failed', 'stale'].includes(report.brief?.status)) {
          throw Object.assign(new Error('DAILY_INPUT_INVALID'), { status: 400 });
        }
        reports.enqueue(report.day, report.id);
        return { status: 202, value: { queued: true } };
      }
      const offset = Number(input.offset || 0);
      const fileOffset = Number(input.fileOffset || 0);
      if (![offset, fileOffset].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw Object.assign(new Error('DAILY_INPUT_INVALID'), { status: 400 });
      }
      const selected = input.groupId
        ? report.groups.filter((group) => group.id === input.groupId)
        : report.groups.slice(offset, offset + 10);
      const groups = selected.map((group) => ({
        ...group,
        count: group.files.length,
        added: group.files.filter((file) => file.change === 'new').length,
        changed: group.files.filter((file) => file.change === 'modified').length,
        files: group.files.slice(fileOffset, fileOffset + 50),
        nextFileOffset: group.files.length > fileOffset + 50 ? fileOffset + 50 : null,
      }));
      return {
        status: 200,
        value: {
          ...report,
          groups,
          nextOffset: !input.groupId && report.groups.length > offset + 10 ? offset + 10 : null,
        },
      };
    };
    return {
      kind: 'exact',
      path: `/req-hub/daily-reports/${action}`,
      operation: { action: `daily-reports/${action}`, methods: [method], execute },
      async handler(req, res) {
        if (req.method !== method) {
          return json(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
        }
        try {
          const input =
            method === 'GET'
              ? Object.fromEntries(new URL(req.url, 'http://localhost').searchParams)
              : JSON.parse(await readBody(req, 16000));
          const result = await execute(input, {
            kind: req.operationExec ? 'agent' : 'user',
            agent: req.operationExec?.agent,
            signal: req.operationExec?.signal,
          });
          return json(res, result.value, result.status);
        } catch (error) {
          const code = error.code || error.message;
          return json(
            res,
            { error: /^(DAILY_|CALLER_)/.test(code) ? code : 'DAILY_FAILED' },
            error.status || 500,
          );
        }
      },
    };
  });
}
