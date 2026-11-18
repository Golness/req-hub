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
        const workspace = registry.list().find((item) => item.id === input.workspaceId);
        await assertWorkspaceCaller(caller, workspace);
      }
      caller.signal?.throwIfAborted();
      const report = await reports.view(input.day, input.workspaceId);
      if (action === 'retry') {
        const group = report.groups.find((item) => item.id === input.id);
        if (!group || !['failed', 'stale'].includes(group.brief?.status)) {
          throw Object.assign(new Error('DAILY_INPUT_INVALID'), { status: 400 });
        }
        reports.enqueue(report.day, group.id);
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
      const briefCounts = { completed: 0, failed: 0, running: 0, pending: 0, stale: 0 };
      for (const group of report.groups) {
        const status = group.brief?.status || 'pending';
        briefCounts[status] = (briefCounts[status] || 0) + 1;
      }
      return {
        status: 200,
        value: {
          ...report,
          groups,
          briefCounts,
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
