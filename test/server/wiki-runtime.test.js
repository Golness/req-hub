import { expect, it, vi } from 'vitest';
import { WikiRuntime, installWikiTools } from '../../src/server/knowledge/wiki/runtime.js';
import { PROMPT_REGISTRY } from '../../src/server/prompts.js';

function fixture() {
  const runtime = new WikiRuntime(
    [
      { id: 'rules', kind: 'rules', version: 1, body: 'Maintenance rules' },
      { id: 'index', kind: 'index', version: 1, body: 'Source index' },
      { id: 'source', kind: 'source', version: 2, body: 'Source\nSupported fact' },
    ],
    { maxResultBytes: 250000, maxAffectedPages: 30, maxSourceDocuments: 30 },
    { limit: 200000 },
    new AbortController().signal,
    'ingest',
  );
  const definitions = [];
  const listeners = new Map();
  const ctx = {
    tools: {
      register: (definition) => {
        definitions.push(definition);
        return () => {};
      },
      guard: () => () => {},
    },
    on: (name, listener) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
  };
  const installation = installWikiTools(ctx);
  installation.add(runtime);
  runtime.bindSession('owned');
  runtime.onEvent = vi.fn();
  const submit = definitions.find((definition) => definition.name === 'req_hub_wiki_submit');
  const execute = (result) => submit.execute({ result }, { agent: { session: { id: 'owned' } } });
  const evidence = [{ documentId: 'source', version: 2, startLine: 1, endLine: 2 }];
  const summary = {
    documentId: 'source',
    summary: 'Supported fact',
    evidence,
  };
  const result = {
    pages: [{ title: 'Topic', entityKey: 'topic', pageType: 'source', body: 'Fact', evidence }],
    summaries: [summary],
    refs: [],
  };
  for (const doc of runtime.documents) {
    runtime.read({ documentId: doc.id });
  }
  return { runtime, installation, execute, result, summary, evidence, listeners };
}

it('diagnoses control-document summaries and accepts a corrected submission', async () => {
  const { runtime, installation, execute, result, summary } = fixture();
  try {
    // The production incident retried the same rules/index summaries three times.
    result.summaries.push({ ...summary, documentId: 'rules' }, { ...summary, documentId: 'index' });
    expect(() => execute(result)).toThrow('summaries[1].documentId');
    expect(runtime.result).toBeUndefined();
    expect(runtime.onEvent).toHaveBeenCalledWith(
      'submission_rejected',
      expect.objectContaining({
        code: 'WIKI_REFERENCE_INVALID',
        details: {
          path: 'summaries[1].documentId',
          reason: 'summarize_source_documents_only_rules_and_index_are_control_documents',
          allowedDocumentIds: ['source'],
        },
      }),
      'warn',
    );
    result.summaries = [summary];
    expect(execute(result)).toEqual({ submitted: true });
    expect(runtime.result.summaries).toHaveLength(1);
  } finally {
    await installation.dispose();
  }
});

it('normalizes fully read Wiki evidence IDs in updates and relation endpoints', async () => {
  const { runtime, installation, execute, result, evidence } = fixture();
  try {
    runtime.documents.push({
      id: 'wiki:existing',
      pageId: 'existing',
      kind: 'wiki',
      version: 1,
      body: 'Existing page',
    });
    expect(runtime.read({ documentId: 'wiki:existing' })).toMatchObject({ pageId: 'existing' });
    result.pages.push({
      title: 'Updated',
      pageType: 'concept',
      pageId: 'wiki:existing',
      body: 'Updated page',
      evidence,
    });
    result.refs = [{ fromKey: 'topic', toKey: 'wiki:existing', refType: 'related', evidence }];
    expect(execute(result)).toEqual({ submitted: true });
    expect(runtime.result.pages[1].pageId).toBe('existing');
    expect(runtime.result.refs[0].toKey).toBe('existing');
  } finally {
    await installation.dispose();
  }
});

it('rejects source IDs used as page IDs early and accepts a corrected new-page submission', async () => {
  const { runtime, installation, execute, result, evidence } = fixture();
  try {
    result.pages[0] = { ...result.pages[0], pageId: 'source' };
    expect(() => execute(result)).toThrow('pages[0].pageId');
    expect(runtime.result).toBeUndefined();
    expect(runtime.submissionFailure).toMatchObject({ message: 'WIKI_TARGET_NOT_READ' });
    delete result.pages[0].pageId;
    result.refs = [{ fromKey: 'topic', toKey: 'source', refType: 'depends_on', evidence }];
    expect(() => execute(result)).toThrow('refs[0].toKey');
    result.pages.push({ ...result.pages[0], title: 'Source page', entityKey: 'source-page' });
    result.refs[0].toKey = 'source-page';
    expect(execute(result)).toEqual({ submitted: true });
    expect(runtime.result.refs[0].toKey).toBe('source-page');
  } finally {
    await installation.dispose();
  }
});

it('does not authorize an unread optional Wiki page merely because its ID is in the catalog', async () => {
  const { runtime, installation, execute, result, evidence } = fixture();
  try {
    runtime.documents.push({
      id: 'wiki:unread',
      pageId: 'unread',
      kind: 'wiki',
      version: 1,
      optional: true,
      body: 'Unread page',
    });
    result.refs = [{ fromKey: 'topic', toKey: 'wiki:unread', refType: 'related', evidence }];
    expect(() => execute(result)).toThrow('refs[0].toKey');
    expect(runtime.result).toBeUndefined();
    result.refs[0].toKey = 'wiki:foreign';
    expect(() => execute(result)).toThrow('refs[0].toKey');
    expect(runtime.result).toBeUndefined();
  } finally {
    await installation.dispose();
  }
});

it('reports allowed relation types and retains a stable terminal domain error', async () => {
  const { runtime, installation, execute, result, evidence } = fixture();
  try {
    result.refs = [{ fromKey: 'source', toKey: 'topic', refType: 'documents', evidence }];
    for (let index = 0; index < 3; index++) {
      expect(() => execute(result)).toThrow('unsupported_relation_type');
    }
    expect(runtime.outputFailure).toMatchObject({
      message: 'WIKI_RESULT_INVALID',
      details: {
        path: 'refs[0].refType',
        allowedValues: ['related', 'depends_on', 'contradicts', 'supersedes'],
      },
    });
    expect(runtime.result).toBeUndefined();
  } finally {
    await installation.dispose();
  }
});

it('exposes citable kinds and line counts while rejecting invalid evidence', async () => {
  const { runtime, installation, execute, result } = fixture();
  try {
    expect(runtime.read({ documentId: 'rules' })).toMatchObject({
      kind: 'rules',
      citable: false,
      lineCount: 1,
      startLine: 1,
    });
    expect(runtime.read({ documentId: 'source' })).toMatchObject({
      kind: 'source',
      citable: true,
      lineCount: 2,
      version: 2,
    });
    result.pages[0].evidence[0].endLine = 3;
    expect(() => execute(result)).toThrow('pages[0].evidence[0]');
    expect(runtime.onEvent.mock.calls.at(-1)[1].details).toMatchObject({ lineCount: 2 });
    result.pages[0].evidence = [null];
    expect(() => execute(result)).toThrow('WIKI_REFERENCE_INVALID');
    expect(runtime.result).toBeUndefined();
    expect(PROMPT_REGISTRY['wiki-generate'].default).toContain('Never summarize rules, index');
    expect(PROMPT_REGISTRY['wiki-generate'].default).toContain(
      'depends_on, contradicts, supersedes',
    );
  } finally {
    await installation.dispose();
  }
});

it('reports the exact invalid classification and allows correction before completion', async () => {
  const { runtime, installation, execute, result, listeners } = fixture();
  try {
    const stopping = listeners.get('agent/turn-stopping');
    const steer = vi.fn();
    const agent = { session: { id: 'owned' }, steer };
    result.summaries[0].classification = 'requirements';
    expect(() => execute(result)).toThrow('summaries[0].classification');
    expect(runtime.submissionFailure).toMatchObject({
      message: 'WIKI_RESULT_INVALID',
      details: {
        path: 'summaries[0].classification',
        allowedValues: ['requirement', 'design', 'cr', 'other'],
      },
    });
    stopping({ agent });
    expect(steer).toHaveBeenCalledOnce();
    const text = steer.mock.calls[0][0].content[0].text;
    expect(text).toContain('summaries[0].classification');
    expect(text).toContain('Do not ask the user to restate the task');
    expect(text).toContain('"next":[]');
    result.summaries[0].classification = 'requirement';
    expect(execute(result)).toEqual({ submitted: true });
    expect(runtime.submissionFailure).toBeNull();
    stopping({ agent });
    expect(steer).toHaveBeenCalledOnce();
  } finally {
    await installation.dispose();
  }
});

it('limits completion reminders and excludes unrelated, cancelled and closed sessions', async () => {
  const { runtime, installation, listeners } = fixture();
  try {
    const stopping = listeners.get('agent/turn-stopping');
    const steer = vi.fn();
    stopping({ agent: { session: { id: 'unrelated' }, steer } });
    stopping({ agent: { session: { id: 'owned' }, steer }, signal: AbortSignal.abort() });
    expect(steer).not.toHaveBeenCalled();
    const agent = { session: { id: 'owned' }, steer };
    for (let index = 0; index < 5; index++) stopping({ agent });
    expect(steer).toHaveBeenCalledTimes(3);
    runtime.completionReminders = 0;
    installation.close(runtime);
    stopping({ agent });
    expect(steer).toHaveBeenCalledTimes(3);
  } finally {
    await installation.dispose();
  }
});
