import { createWorkspaceTaskAgent } from './workspace-task-agent.js';
import { resolveSyncBudget } from './sync-budget.js';
import { runModelStep } from './knowledge-v2/compiler.js';

/**
 * Build bounded, lossless model batches; binary files contribute explicit metadata only.
 * @param evidence - File chunks read from source files for this generation only.
 * @param maxCharacters - Batch character target; reduction batches must fit two bounded summaries.
 * @returns Batches whose text never splits a Unicode code point.
 */
export function briefBatches(evidence, maxCharacters = 20000) {
  const batches = [];
  let batch = [];
  let size = 0;
  for (const file of evidence) {
    const metadata = JSON.stringify({
      workspaceId: file.workspaceId,
      workspace: file.workspaceTitle,
      requirement: file.group,
      path: file.path,
      version: file.readVersion || file.version,
      recordedVersion: file.version,
      fileState: file.fileState,
      readError: file.readError,
      change: file.change,
      sources: file.sources,
      contentAvailable: file.contentAvailable,
    });
    const characters = Array.from(file.body ?? 'Content unavailable. Describe metadata only.');
    for (let offset = 0; offset < Math.max(characters.length, 1); offset += 16000) {
      const body = metadata + '\n' + characters.slice(offset, offset + 16000).join('');
      if (size + body.length > maxCharacters && batch.length) {
        batches.push(batch);
        batch = [];
        size = 0;
      }
      batch.push({
        id: file.id + ':' + offset,
        kind: 'source',
        title: file.path,
        version: file.readVersion || file.version,
        body,
        required: true,
      });
      size += body.length;
    }
  }
  if (batch.length) {
    batches.push(batch);
  }
  return batches;
}

/**
 * Consolidate all workspace evidence into one daily brief with workspace and requirement sections.
 * @param ctx - Injected Host services.
 * @param installation - Plugin-owned frozen-evidence tools; never registered twice.
 * @returns A cancellable generator that releases its background Agent in finally.
 */
export function createDailyBriefGenerator(ctx, installation) {
  return async ({ group, evidence, readEvidence, scope, config, day, signal }) => {
    if (config.ai?.enabled === false) {
      throw Object.assign(new Error('DAILY_MODEL_DISABLED'), { code: 'DAILY_MODEL_DISABLED' });
    }
    const owner = await createWorkspaceTaskAgent(ctx, scope.workspace, signal);
    try {
      const budget = await resolveSyncBudget({
        ctx,
        llm: ctx.llm,
        parentAgent: owner.agent,
        signal,
      });
      let calls = 0;
      const summarize = async (documents) => {
        signal.throwIfAborted();
        if (
          ++calls > (config.dailyReports?.maxModelCalls ?? 32) ||
          Buffer.byteLength(JSON.stringify(documents)) >
            (config.dailyReports?.maxBriefInputBytes ?? 1_000_000)
        ) {
          throw Object.assign(new Error('DAILY_MODEL_BUDGET_EXCEEDED'), {
            code: 'DAILY_MODEL_BUDGET_EXCEEDED',
          });
        }
        const result = await runModelStep({
          ctx,
          llm: ctx.llm,
          config: { ...config, knowledgeV2: { ...config.knowledgeV2, modelRetryCount: 0 } },
          owner,
          store: { scope: { workspaceRoot: scope.workspace.path } },
          signal,
          installation,
          kind: 'query',
          promptKey: 'daily-brief',
          documents,
          budget,
          instruction: JSON.stringify({
            day,
            scope: 'all-workspaces',
            sections: group.groups?.map((section) => ({
              workspaceId: section.workspaceId,
              workspace: section.workspaceTitle,
              requirement: section.group,
            })),
            deliveryLanguage: config.general?.contentLanguage || 'zh',
          }),
          description: 'ReqHub daily brief',
          validateResult: (result) => {
            if (Buffer.byteLength(result.answer) > 12000) {
              throw Object.assign(new Error('DAILY_BRIEF_INVALID'), {
                code: 'DAILY_BRIEF_INVALID',
              });
            }
          },
        });
        return result.answer;
      };
      const summaries = [];
      let pending = [];
      let size = 0;
      for await (const file of readEvidence ? readEvidence() : evidence) {
        for (const document of briefBatches([file]).flat()) {
          if (size + document.body.length > 20000 && pending.length) {
            summaries.push(await summarize(pending));
            pending = [];
            size = 0;
          }
          pending.push(document);
          size += document.body.length;
        }
      }
      if (pending.length) {
        summaries.push(await summarize(pending));
      }
      let current = summaries;
      while (current.length > 1) {
        const next = [];
        const batches = briefBatches(
          current.map((body, index) => ({
            id: 'summary:' + index,
            path: 'summary:' + index,
            version: String(calls),
            body,
            contentAvailable: true,
            sources: ['daily-summary'],
          })),
          32000,
        );
        for (const documents of batches) {
          next.push(await summarize(documents));
        }
        current = next;
      }
      if (!current.length) {
        throw Object.assign(new Error('DAILY_BRIEF_INVALID'), { code: 'DAILY_BRIEF_INVALID' });
      }
      return current[0];
    } finally {
      await owner.dispose();
    }
  };
}
