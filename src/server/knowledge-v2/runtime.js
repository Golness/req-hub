import { ownedAgentListener } from '../owned-agent-listener.js';
import { randomUUID } from 'node:crypto';
import { runtimeForRequest } from '../delegation-context.js';
import { syncReadPage } from '../sync-budget.js';
import { estimateSubagentInputTokens, MAX_SYNC_INPUT_TOKENS } from '../token-utils.js';
import { digest, fail, LIMITS } from './contracts.js';

export const KB_TASK_TOOLS = ['req_hub_kb_task_read', 'req_hub_kb_task_submit'];

const array = (value) => Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;

/** Frozen evidence and one structured submission; only tool receipts complete a task. */
export class KbTaskRuntime {
  /**
   * @param options - {kind, documents, budget}; documents carry required flags.
   */
  constructor({ kind, documents, budget = { limit: MAX_SYNC_INPUT_TOKENS }, validateResult }) {
    this.id = randomUUID();
    this.kind = kind;
    this.validateResult = validateResult;
    this.budget = budget;
    this.documents = documents.map((doc) => ({ ...doc, hash: digest(doc.body) }));
    this.coverage = new Map();
    this.contextCost = 0;
    this.exposedCost = 0;
    this.activity = { stage: 'preparing', read: 0, outputCharacters: 0 };
  }
  updateActivity(update) {
    this.activity = { ...this.activity, ...update };
    this.onActivity?.(this.activity);
  }
  charge(value) {
    const cost = estimateSubagentInputTokens(JSON.stringify(value));
    if (
      this.contextCost + this.exposedCost + cost + LIMITS.outputReserveTokens >=
      this.budget.limit
    ) {
      fail('KB_BUDGET_EXCEEDED', 413);
    }
    this.exposedCost += cost;
    return value;
  }
  read({ id, offset = 0 }) {
    const doc = this.documents.find((item) => item.id === id);
    if (!doc) {
      fail('KB_READ_INVALID', 400, {
        availableIds: this.documents.map((item) => item.id),
        instruction: 'Read an exact frozen document ID; do not invent IDs.',
      });
    }
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > (this.coverage.get(id) || 0) ||
      offset > doc.body.length
    ) {
      fail('KB_READ_INVALID', 400, { reason: 'offset' });
    }
    const result = this.charge(
      syncReadPage(id, doc.body, offset, 8000, doc.hash, undefined, (page) => ({
        ...page,
        id,
        kind: doc.kind,
        title: doc.title,
        version: doc.version,
        hash: doc.hash,
        lineCount: doc.body.split('\n').length,
        required: !!doc.required,
      })),
    );
    this.coverage.set(id, Math.max(result.nextOffset, this.coverage.get(id) || 0));
    this.updateActivity({
      stage: 'reading',
      read: [...this.coverage].filter(
        ([key, length]) => this.documents.find((item) => item.id === key)?.body.length === length,
      ).length,
      lastActivityAt: Date.now(),
    });
    return result;
  }
  completionState() {
    const unread = this.documents
      .filter((doc) => doc.required && this.coverage.get(doc.id) !== doc.body.length)
      .map((doc) => ({ id: doc.id, offset: this.coverage.get(doc.id) || 0 }));
    return { unreadRequired: unread, submitted: !!this.result };
  }
  submit(result) {
    if (this.failure) {
      throw this.failure;
    }
    const state = this.completionState();
    if (state.unreadRequired.length) {
      fail('KB_EVIDENCE_NOT_FULLY_READ', 400, state);
    }
    validateSubmission(this.kind, result);
    this.validateResult?.(result, this);
    this.updateActivity({ stage: 'submitted' });
    this.result = result;
    return { success: true };
  }
}

function validateSubmission(kind, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('KB_MODEL_OUTPUT_INVALID', 400, { reason: 'result object required' });
  }
  if (kind === 'analyze') {
    if (
      !text(result.summary, 16000) ||
      !result.summary.trim() ||
      !array(result.facts) ||
      !array(result.entities) ||
      !array(result.concepts) ||
      !array(result.existingPageIds) ||
      !array(result.conflicts) ||
      !array(result.proposedPages) ||
      result.proposedPages.length > LIMITS.changedPages
    ) {
      fail('KB_MODEL_OUTPUT_INVALID', 400, { kind });
    }
    return;
  }
  if (kind === 'generate') {
    if (
      !array(result.upserts) ||
      result.upserts.length > LIMITS.changedPages ||
      !text(result.overview ?? '', 8000) ||
      !array(result.findings ?? [])
    ) {
      fail('KB_MODEL_OUTPUT_INVALID', 400, { kind });
    }
    for (const page of result.upserts) {
      if (
        !page ||
        !text(page.pageId, 160) ||
        !text(page.type, 20) ||
        !text(page.title, 500) ||
        !page.title.trim() ||
        !text(page.body, LIMITS.pageBytes) ||
        !page.body.trim() ||
        !array(page.sources) ||
        (page.baseHash !== undefined && !text(page.baseHash, 128))
      ) {
        fail('KB_MODEL_OUTPUT_INVALID', 400, { kind, pageId: page?.pageId });
      }
      for (const ref of page.sources) {
        if (
          !ref ||
          !text(ref.id, 160) ||
          !text(ref.revision, 64) ||
          !Number.isSafeInteger(ref.startLine) ||
          !Number.isSafeInteger(ref.endLine)
        ) {
          fail('KB_MODEL_OUTPUT_INVALID', 400, {
            kind,
            pageId: page.pageId,
            reason: 'sources entries need {id, revision, startLine, endLine}',
          });
        }
      }
    }
    return;
  }
  if (kind === 'query') {
    if (!text(result.answer, 120000) || !result.answer.trim() || !array(result.citations)) {
      fail('KB_MODEL_OUTPUT_INVALID', 400, { kind });
    }
    return;
  }
  if (kind === 'lint') {
    if (!array(result.findings) || result.findings.length > 200) {
      fail('KB_MODEL_OUTPUT_INVALID', 400, { kind });
    }
    return;
  }
  fail('KB_TASK_KIND_INVALID', 400, { kind });
}

/**
 * Register the controlled read/submit tools with ownership and budget guards.
 * @param ctx - The injected Host context.
 * @returns The installation handle with add/close/dispose.
 */
export function installKbTaskTools(ctx) {
  if (!ctx?.tools?.register || !ctx.tools.guard || !ctx.on) {
    fail('KB_TOOLS_UNAVAILABLE', 503);
  }
  const runtimes = new Map();
  const sessions = new Map();
  const disposers = [];
  const scopedListeners = new Map();
  const properties = [
    { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
    { result: { type: 'object', additionalProperties: true } },
  ];
  for (const [i, name] of KB_TASK_TOOLS.entries()) {
    disposers.push(
      ctx.tools.register({
        name,
        description: [
          'Read one frozen task document. Follow nextOffset until eof. Copy hash for baseHash.',
          'Submit the complete structured result for this task kind. Only a receipt completes the task.',
        ][i],
        parameters: {
          type: 'object',
          properties: properties[i],
          required: Object.keys(properties[i]).filter((key) => key !== 'offset'),
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute(args, exec) {
          exec.signal?.throwIfAborted();
          const runtime = sessions.get(exec.agent?.session?.id);
          if (!runtime || runtime.closed) {
            fail('KB_TOOL_DENIED', 403);
          }
          if (runtime.failure) {
            throw runtime.failure;
          }
          try {
            const value = runtime[i === 0 ? 'read' : 'submit'](i === 0 ? args : args.result);
            if (i === 1) {
              runtime.repairFailures = 0;
            }
            return value;
          } catch (error) {
            runtime.repairFailures = (runtime.repairFailures || 0) + 1;
            if (runtime.repairFailures >= 3) {
              runtime.failure = Object.assign(new Error('KB_TOOL_FAILED'), {
                code: 'KB_TOOL_FAILED',
                details: { cause: error.code || error.message, causeDetails: error.details || {} },
              });
              runtime.onFatal?.(runtime.failure);
              throw runtime.failure;
            }
            throw Object.assign(
              new Error(
                error.message +
                  ' ' +
                  JSON.stringify({
                    code: error.code || error.message,
                    details: error.details || {},
                    attempt: runtime.repairFailures,
                    limit: 3,
                    instruction:
                      'Correct from the exact frozen IDs and schema. Do not bypass evidence.',
                  }),
              ),
              { code: error.code, details: error.details },
            );
          }
        },
      }),
    );
  }
  disposers.push(
    ctx.tools.guard((exec) =>
      sessions.has(exec.agent?.session?.id) && !KB_TASK_TOOLS.includes(exec.name)
        ? 'Knowledge tasks may only read frozen evidence and submit a structured result'
        : undefined,
    ),
  );
  const beforeTurnStops = ({ agent, signal }) => {
    const runtime = sessions.get(agent.session.id);
    if (
      !runtime ||
      runtime.closed ||
      runtime.failure ||
      runtime.result ||
      signal?.aborted ||
      runtime.signal?.aborted ||
      typeof agent.steer !== 'function'
    ) {
      return;
    }
    if ((runtime.completionReminders || 0) >= 3) {
      runtime.failure = Object.assign(new Error('KB_RESULT_INCOMPLETE'), {
        code: 'KB_RESULT_INCOMPLETE',
      });
      runtime.onFatal?.(runtime.failure);
      return;
    }
    runtime.completionReminders = (runtime.completionReminders || 0) + 1;
    const state = runtime.completionState();
    agent.steer(
      Object.freeze({
        id: randomUUID(),
        role: 'user',
        source: Object.freeze({
          kind: 'req-hub-knowledge',
          form: 'notice',
          summary: 'Knowledge result not submitted',
        }),
        content: Object.freeze([
          Object.freeze({
            type: 'text',
            text:
              'ReqHub has NOT received a successful req_hub_kb_task_submit receipt. Continue in the SAME turn with the actual callable tools. ' +
              'Writing tool-call text in a normal answer does not execute tools. ' +
              JSON.stringify(state) +
              '. Read unreadRequired documents with req_hub_kb_task_read until eof, then submit the complete structured result. Do not claim completion without a receipt.',
          }),
        ]),
      }),
    );
  };
  disposers.push(
    ctx.on(
      'llm/stream',
      async function* (request, next) {
        const runtime =
          sessions.get(request.sessionId) || runtimeForRequest(ctx, runtimes, request);
        if (runtime) {
          if (runtime.failure) {
            throw runtime.failure;
          }
          if (
            runtime.closed ||
            !request.sessionId ||
            (runtime.sessionId && runtime.sessionId !== request.sessionId)
          ) {
            fail('KB_SESSION_DENIED', 403);
          }
          runtime.sessionId = request.sessionId;
          sessions.set(request.sessionId, runtime);
          runtime.contextCost = estimateSubagentInputTokens(
            JSON.stringify({
              messages: request.messages,
              system: request.system,
              tools: request.tools,
              toolHistory: request.toolHistory,
            }),
          );
          runtime.exposedCost = 0;
          if (runtime.contextCost + LIMITS.outputReserveTokens >= runtime.budget.limit) {
            fail('KB_BUDGET_EXCEEDED', 413);
          }
        }
        for await (const chunk of next()) {
          if (runtime && !runtime.closed && chunk?.type === 'text-delta' && chunk.text?.length) {
            runtime.updateActivity({
              stage: 'generating',
              outputCharacters: runtime.activity.outputCharacters + chunk.text.length,
            });
          }
          yield chunk;
        }
      },
      { global: true, prepend: true },
    ),
  );
  return {
    add(runtime) {
      runtime.bindSession = (id) => {
        sessions.set(id, runtime);
        if (!scopedListeners.has(runtime.id)) {
          scopedListeners.set(
            runtime.id,
            ownedAgentListener(ctx, id, 'agent/turn-stopping', beforeTurnStops),
          );
        }
      };
      runtimes.set(runtime.id, runtime);
    },
    close(runtime) {
      scopedListeners.get(runtime.id)?.();
      scopedListeners.delete(runtime.id);
      runtime.closed = true;
      runtimes.delete(runtime.id);
      if (runtime.sessionId) {
        sessions.set(runtime.sessionId, { closed: true });
      }
    },
    dispose() {
      for (const runtime of runtimes.values()) {
        runtime.closed = true;
      }
      for (const dispose of scopedListeners.values()) {
        dispose();
      }
      scopedListeners.clear();
      for (const dispose of disposers.reverse()) {
        dispose();
      }
      runtimes.clear();
      sessions.clear();
    },
  };
}
