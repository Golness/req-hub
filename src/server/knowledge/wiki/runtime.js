import { randomUUID } from 'node:crypto';
import { runtimeForRequest } from '../../delegation-context.js';
import { syncReadPage } from '../../sync-budget.js';
import { estimateSubagentInputTokens } from '../../token-utils.js';
import { bounded, digest, fail, PAGE_TYPES } from './store.js';
export const WIKI_TOOLS = ['req_hub_wiki_read', 'req_hub_wiki_submit'];

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
      (value) => ({ ...value, documentId: doc.id, version: doc.version }),
    );
    this.charge(page);
    this.coverage.set(doc.id, Math.max(page.nextOffset, this.coverage.get(doc.id) || 0));
    return page;
  }
  evidence(refs) {
    if (!Array.isArray(refs) || !refs.length || refs.length > 200) {
      fail('WIKI_REFERENCE_INVALID', 422);
    }
    return refs.map((ref) => {
      const doc = this.documents.find(
        (item) =>
          item.id === ref.documentId &&
          item.version === ref.version &&
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
        fail('WIKI_REFERENCE_INVALID', 422);
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
    if (this.kind === 'query') {
      ((output.answer = string(result.answer)), (output.evidence = this.evidence(result.evidence)));
    } else if (this.kind === 'rules') {
      ((output.rules = string(result.rules)), (output.evidence = this.evidence(result.evidence)));
    } else {
      output.pages = list(result.pages || [], this.settings.maxAffectedPages).map((page) => ({
        title: string(page.title, 500),
        pageType: PAGE_TYPES.includes(page.pageType)
          ? page.pageType
          : fail('WIKI_RESULT_INVALID', 422),
        body: string(page.body),
        ...(page.pageId
          ? { pageId: string(page.pageId, 100) }
          : { entityKey: string(page.entityKey, 500) }),
        evidence: this.evidence(page.evidence),
      }));
      output.summaries = list(result.summaries || [], this.settings.maxSourceDocuments).map(
        (summary) => {
          const doc = this.documents.find(
            (doc) => doc.kind === 'source' && doc.id === summary.documentId,
          );
          if (!doc) {
            fail('WIKI_REFERENCE_INVALID', 422);
          }
          if (
            !['requirement', 'design', 'cr', 'other'].includes(summary.classification || 'other') ||
            summary.evidence?.some((ref) => ref.documentId !== doc.id)
          ) {
            fail('WIKI_RESULT_INVALID', 422);
          }
          return {
            documentId: doc.id,
            sourceVersion: doc.version,
            summary: string(summary.summary, 12000),
            entities: list(summary.entities || [], 100),
            concepts: list(summary.concepts || [], 100),
            decisions: list(summary.decisions || [], 100),
            classification: string(summary.classification || 'other', 100),
            evidence: this.evidence(summary.evidence),
          };
        },
      );
      output.refs = list(result.refs || [], 1000).map((ref) => ({
        fromKey: string(ref.fromKey, 500),
        toKey: string(ref.toKey, 500),
        refType: ['related', 'depends_on', 'contradicts', 'supersedes'].includes(ref.refType)
          ? ref.refType
          : fail('WIKI_RESULT_INVALID', 422),
        evidence: this.evidence(ref.evidence),
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
          ? 'Submit one Wiki result with exact evidence references. Read every assigned document first.'
          : 'Read a frozen Wiki document. Follow nextOffset until eof.',
        parameters: {
          type: 'object',
          properties: index
            ? { result: { type: 'object' } }
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
            runtime.invalidWrites = (runtime.invalidWrites || 0) + 1;
            if (runtime.invalidWrites >= 3) {
              runtime.outputFailure = error;
            }
            throw error;
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
        yield* next();
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
