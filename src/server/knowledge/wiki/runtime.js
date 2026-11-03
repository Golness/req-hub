import { randomUUID } from 'node:crypto';
import { runtimeForRequest } from '../../delegation-context.js';
import { syncReadPage } from '../../sync-budget.js';
import { estimateSubagentInputTokens } from '../../token-utils.js';
import { bounded, digest, fail, PAGE_TYPES } from './store.js';
import { findWikiPage } from './page-reference.js';
export const WIKI_TOOLS = ['req_hub_wiki_read', 'req_hub_wiki_submit'];
const CLASSIFICATIONS = ['requirement', 'design', 'cr', 'other'];

/** Serve frozen Wiki evidence and validate task-scoped structured output. */
export class WikiRuntime {
  constructor(documents, settings, budget, signal, kind) {
    Object.assign(this, { documents, settings, budget, signal, kind });
    this.id = randomUUID();
    this.coverage = new Map();
    this.contextCost = 0;
    this.exposedCost = 0;
  }
  charge(value) {
    this.signal.throwIfAborted();
    this.exposedCost += estimateSubagentInputTokens(JSON.stringify(value));
    if (this.contextCost + this.exposedCost + 16000 >= this.budget.limit) {
      fail('WIKI_BUDGET_EXCEEDED', 413);
    }
    return value;
  }
  read({ documentId, offset = 0 }) {
    this.signal.throwIfAborted();
    const doc = this.documents.find((item) => item.id === documentId);
    if (doc?.optional) {
      if (typeof doc.body !== 'string') {
        Object.assign(doc, doc.load());
      }
      bounded(this.documents, this.settings.maxInputBytes);
      if (
        this.documents.filter((item) => item.kind === 'wiki' && typeof item.body === 'string')
          .length > this.settings.maxAffectedPages
      ) {
        fail('WIKI_BUDGET_EXCEEDED', 413);
      }
      doc.snapshotId ||= this.freezeSnapshot(doc);
    }
    if (
      !doc ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > (this.coverage.get(doc.id) || 0) ||
      offset > doc.body.length ||
      (offset < doc.body.length && /[\uDC00-\uDFFF]/.test(doc.body[offset]))
    ) {
      fail('WIKI_REFERENCE_INVALID', 422);
    }
    const page = syncReadPage(
      doc.id,
      doc.body,
      offset,
      8000,
      digest(doc.body),
      undefined,
      (value) => ({
        ...value,
        documentId: doc.id,
        version: doc.version,
        kind: doc.kind,
        ...(doc.kind === 'wiki' ? { pageId: doc.pageId } : {}),
        citable: !['rules', 'index'].includes(doc.kind),
        lineCount: doc.body.split('\n').length,
        startLine: doc.body.slice(0, offset).split('\n').length,
      }),
    );
    this.charge(page);
    this.coverage.set(doc.id, Math.max(page.nextOffset, this.coverage.get(doc.id) || 0));
    this.onEvent?.('evidence_read', {
      documentId: doc.id,
      version: doc.version,
      offset,
      nextOffset: page.nextOffset,
      eof: page.eof,
    });
    return page;
  }
  evidence(refs, path = 'evidence') {
    if (!Array.isArray(refs) || !refs.length || refs.length > 200) {
      fail('WIKI_REFERENCE_INVALID', 422, { path, reason: 'nonempty_evidence_required' });
    }
    return refs.map((ref, index) => {
      const doc = this.documents.find(
        (item) =>
          item.id === ref?.documentId &&
          item.version === ref?.version &&
          item.kind !== 'rules' &&
          item.kind !== 'index',
      );
      if (
        !doc ||
        typeof doc.body !== 'string' ||
        this.coverage.get(doc.id) !== doc.body.length ||
        !Number.isSafeInteger(ref.startLine) ||
        !Number.isSafeInteger(ref.endLine) ||
        ref.startLine < 1 ||
        ref.endLine < ref.startLine ||
        ref.endLine > doc.body.split('\n').length
      ) {
        fail('WIKI_REFERENCE_INVALID', 422, {
          path: `${path}[${index}]`,
          reason: 'cite_fully_read_source_or_wiki_with_exact_version_and_valid_lines',
          documentId: typeof ref?.documentId === 'string' ? ref.documentId.slice(0, 100) : null,
          expectedVersion: this.documents.find((item) => item.id === ref?.documentId)?.version,
          lineCount: typeof doc?.body === 'string' ? doc.body.split('\n').length : null,
        });
      }
      return {
        documentId: doc.id,
        version: doc.version,
        startLine: ref.startLine,
        endLine: ref.endLine,
        hash: digest(doc.body),
        snapshotId: doc.snapshotId,
      };
    });
  }
  submit({ result }) {
    this.signal.throwIfAborted();
    bounded(result, this.settings.maxResultBytes);
    const next = this.documents
      .filter(
        (doc) =>
          (!doc.optional || this.coverage.has(doc.id)) &&
          this.coverage.get(doc.id) !== doc.body?.length,
      )
      .map((doc) => ({ documentId: doc.id, offset: this.coverage.get(doc.id) || 0 }));
    if (next.length) {
      fail('WIKI_EVIDENCE_INCOMPLETE', 422, { next });
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      fail('WIKI_RESULT_INVALID', 422);
    }
    const string = (value, max = 100000) => {
      if (typeof value !== 'string' || !value.trim() || value.length > max) {
        fail('WIKI_RESULT_INVALID', 422);
      }
      return value;
    };
    const list = (value, max) => {
      if (!Array.isArray(value) || value.length > max) {
        fail('WIKI_RESULT_INVALID', 422);
      }
      return value;
    };
    const output = {};
    const pageTarget = (key, path) => {
      const doc = findWikiPage(this.documents, key);
      if (!doc || typeof doc.body !== 'string' || this.coverage.get(doc.id) !== doc.body.length) {
        fail('WIKI_TARGET_NOT_READ', 422, {
          path,
          reason: 'update_only_fully_read_wiki_pages_use_entityKey_for_new_pages',
          allowedPageIds: this.documents
            .filter(
              (item) =>
                item.kind === 'wiki' &&
                typeof item.body === 'string' &&
                this.coverage.get(item.id) === item.body.length,
            )
            .map((item) => item.pageId),
        });
      }
      return doc.pageId;
    };
    if (this.kind === 'query') {
      ((output.answer = string(result.answer)), (output.evidence = this.evidence(result.evidence)));
    } else if (this.kind === 'rules') {
      ((output.rules = string(result.rules)), (output.evidence = this.evidence(result.evidence)));
    } else {
      output.pages = list(result.pages || [], this.settings.maxAffectedPages).map(
        (page, index) => ({
          title: string(page.title, 500),
          pageType: PAGE_TYPES.includes(page.pageType)
            ? page.pageType
            : fail('WIKI_RESULT_INVALID', 422),
          body: string(page.body),
          ...(page.pageId
            ? { pageId: pageTarget(string(page.pageId, 100), `pages[${index}].pageId`) }
            : { entityKey: string(page.entityKey, 500) }),
          evidence: this.evidence(page.evidence, `pages[${index}].evidence`),
        }),
      );
      output.summaries = list(result.summaries || [], this.settings.maxSourceDocuments).map(
        (summary, index) => {
          const doc = this.documents.find(
            (doc) => doc.kind === 'source' && doc.id === summary.documentId,
          );
          if (!doc) {
            fail('WIKI_REFERENCE_INVALID', 422, {
              path: `summaries[${index}].documentId`,
              reason: 'summarize_source_documents_only_rules_and_index_are_control_documents',
              allowedDocumentIds: this.documents
                .filter((item) => item.kind === 'source')
                .map((item) => item.id),
            });
          }
          if (!CLASSIFICATIONS.includes(summary.classification || 'other')) {
            fail('WIKI_RESULT_INVALID', 422, {
              path: `summaries[${index}].classification`,
              reason: 'unsupported_source_classification',
              allowedValues: CLASSIFICATIONS,
            });
          }
          if (
            Array.isArray(summary.evidence) &&
            summary.evidence.some((ref) => ref?.documentId !== doc.id)
          ) {
            fail('WIKI_REFERENCE_INVALID', 422, {
              path: `summaries[${index}].evidence`,
              reason: 'summary_evidence_must_reference_its_source_document',
              documentId: doc.id,
            });
          }
          return {
            documentId: doc.id,
            sourceVersion: doc.version,
            summary: string(summary.summary, 12000),
            entities: list(summary.entities || [], 100),
            concepts: list(summary.concepts || [], 100),
            decisions: list(summary.decisions || [], 100),
            classification: string(summary.classification || 'other', 100),
            evidence: this.evidence(summary.evidence, `summaries[${index}].evidence`),
          };
        },
      );
      const relationTarget = (key, path) => {
        const value = string(key, 500);
        if (findWikiPage(this.documents, value)) {
          return pageTarget(value, path);
        }
        if (output.pages.some((page) => page.entityKey === value || page.pageId === value)) {
          return value;
        }
        fail('WIKI_REFERENCE_INVALID', 422, {
          path,
          reason: 'use_generated_entityKey_or_fully_read_wiki_pageId',
          allowedKeys: output.pages.map((page) => page.entityKey || page.pageId),
        });
      };
      output.refs = list(result.refs || [], 1000).map((ref, index) => ({
        refType: ['related', 'depends_on', 'contradicts', 'supersedes'].includes(ref.refType)
          ? ref.refType
          : fail('WIKI_RESULT_INVALID', 422, {
              path: `refs[${index}].refType`,
              reason: 'unsupported_relation_type',
              allowedValues: ['related', 'depends_on', 'contradicts', 'supersedes'],
            }),
        fromKey: relationTarget(ref.fromKey, `refs[${index}].fromKey`),
        toKey: relationTarget(ref.toKey, `refs[${index}].toKey`),
        evidence: this.evidence(ref.evidence, `refs[${index}].evidence`),
      }));
      if (this.kind === 'lint') {
        output.findings = list(result.findings || [], 200).map((item) => ({
          kind: [
            'stale',
            'contradiction',
            'orphan',
            'missing_concept',
            'coverage',
            'research_gap',
          ].includes(item.kind)
            ? item.kind
            : fail('WIKI_RESULT_INVALID', 422),
          reason: string(item.reason, 4000),
          evidence: this.evidence(item.evidence),
        }));
      }
      if (['ingest', 'regenerate'].includes(this.kind) && !output.pages.length) {
        fail('WIKI_RESULT_INVALID', 422);
      }
    }
    this.result = bounded(output, this.settings.maxResultBytes);
    this.submissionFailure = null;
    this.onEvent?.('result_submitted', {
      pages: output.pages?.length || 0,
      summaries: output.summaries?.length || 0,
      refs: output.refs?.length || 0,
    });
    return { submitted: true };
  }
}

/**
 * Register Wiki tools restricted to Host-owned frozen evidence.
 * @param ctx - The injected Host context.
 * @returns A disposer for registered tools and request listeners.
 */
export function installWikiTools(ctx) {
  const runtimes = new Map();
  const sessions = new Map();
  const disposers = [];
  for (const [index, name] of WIKI_TOOLS.entries()) {
    disposers.push(
      ctx.tools.register({
        name,
        description: index
          ? 'Submit one Wiki result after reading every assigned document. Summaries accept source documents only; never summarize or cite rules/index. Evidence uses exact documentId, numeric version and inclusive 1-based startLine/endLine. refs[].refType must be related, depends_on, contradicts or supersedes; use refs: [] if none apply. Correct path/reason in rejected submissions.'
          : 'Read a frozen Wiki document. Follow nextOffset until eof.',
        parameters: {
          type: 'object',
          properties: index
            ? {
                result: {
                  type: 'object',
                  properties: {
                    summaries: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          classification: { type: 'string', enum: CLASSIFICATIONS },
                        },
                      },
                    },
                  },
                },
              }
            : { documentId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
          required: index ? ['result'] : ['documentId'],
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
            fail('WIKI_SCOPE_DENIED', 403);
          }
          if (!index) {
            return runtime.read(args);
          }
          try {
            return runtime.submit(args);
          } catch (error) {
            runtime.submissionFailure = error;
            runtime.onEvent?.(
              'submission_rejected',
              {
                code: error.message,
                details: error.details,
                remainingReads: error.details?.next?.length || 0,
              },
              'warn',
            );
            runtime.invalidWrites = (runtime.invalidWrites || 0) + 1;
            if (runtime.invalidWrites >= 3) {
              runtime.outputFailure = error;
            }
            // Host tool errors serialize the message only; keep the domain error for job state.
            const diagnostic = JSON.stringify(error.details || {});
            throw Object.assign(new Error(`${error.message}: ${diagnostic}`), {
              code: error.message,
              status: error.status,
              details: error.details,
            });
          }
        },
      }),
    );
  }
  disposers.push(
    ctx.tools.guard((exec) =>
      sessions.has(exec.agent?.session?.id) && ![...WIKI_TOOLS, 'run_code'].includes(exec.name)
        ? 'WIKI_SCOPE_DENIED'
        : undefined,
    ),
  );
  disposers.push(
    ctx.on(
      'agent/turn-stopping',
      ({ agent, signal }) => {
        const runtime = sessions.get(agent?.session?.id);
        if (
          !runtime ||
          runtime.closed ||
          runtime.result ||
          runtime.outputFailure ||
          signal?.aborted ||
          runtime.signal.aborted ||
          typeof agent.steer !== 'function' ||
          (runtime.completionReminders || 0) >= 3
        ) {
          return;
        }
        const next = runtime.documents
          .filter(
            (doc) =>
              (!doc.optional || runtime.coverage.has(doc.id)) &&
              runtime.coverage.get(doc.id) !== doc.body?.length,
          )
          .map((doc) => ({ documentId: doc.id, offset: runtime.coverage.get(doc.id) || 0 }));
        const failure = runtime.submissionFailure;
        const diagnostic = {
          attempt: (runtime.completionReminders || 0) + 1,
          next,
          submissionError: failure ? { code: failure.message, details: failure.details } : null,
        };
        runtime.onEvent?.('completion_reminder', diagnostic, 'warn');
        runtime.completionReminders = diagnostic.attempt;
        const text =
          'This Wiki task has no successful req_hub_wiki_submit receipt. ' +
          'Continue this task in the same turn. Do not ask the user to restate the task. ' +
          'Read only the remaining documents from next, following nextOffset until eof. ' +
          'Correct the indicated submission field and resubmit the complete result. ' +
          'Use actual tool calls. Ordinary replies cannot submit a result. ' +
          'Use English for intermediate text and the delivery language for final Wiki content.\n' +
          JSON.stringify(diagnostic);
        agent.steer(
          Object.freeze({
            id: randomUUID(),
            role: 'user',
            source: Object.freeze({
              kind: 'req-hub-wiki',
              form: 'notice',
              summary: 'Incomplete Wiki submission',
            }),
            content: Object.freeze([Object.freeze({ type: 'text', text })]),
          }),
        );
      },
      { global: true },
    ),
  );
  disposers.push(
    ctx.on(
      'llm/stream',
      async function* (request, next) {
        const runtime =
          sessions.get(request.sessionId) || runtimeForRequest(ctx, runtimes, request);
        if (runtime) {
          if (runtime.closed) {
            fail('WIKI_SCOPE_DENIED', 403);
          }
          if (runtime.outputFailure) {
            throw runtime.outputFailure;
          }
          runtime.signal.throwIfAborted();
          runtime.contextCost = estimateSubagentInputTokens(
            JSON.stringify({
              messages: request.messages,
              system: request.system,
              tools: request.tools,
              toolHistory: request.toolHistory,
            }),
          );
          runtime.exposedCost = 0;
          runtime.charge({});
        }
        if (!runtime) {
          yield* next();
          return;
        }
        runtime.onEvent?.('model_requested', { contextTokens: runtime.contextCost });
        try {
          yield* next();
          runtime.onEvent?.('model_finished');
        } catch (error) {
          runtime.failure = error;
          runtime.onEvent?.('model_failed', { code: error.code || 'WIKI_MODEL_FAILED' }, 'error');
          throw error;
        }
      },
      { global: true, prepend: true },
    ),
  );
  return {
    add(runtime) {
      runtime.bindSession = (id) => sessions.set(id, runtime);
      runtimes.set(runtime.id, runtime);
    },
    close(runtime) {
      runtime.closed = true;
      runtimes.delete(runtime.id);
      if (runtime.sessionId) {
        sessions.set(runtime.sessionId, { closed: true });
      }
    },
    async dispose() {
      for (const dispose of disposers.reverse()) {
        await dispose();
      }
      runtimes.clear();
      sessions.clear();
    },
  };
}
