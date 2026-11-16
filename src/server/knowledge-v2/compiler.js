import { contentTemplates } from '../content-templates.js';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspaceTaskAgent } from '../workspace-task-agent.js';
import { executeTask, prepareTaskPrompt } from '../task-executor.js';
import { resolveSyncBudget, estimateArtifactReadTokens } from '../sync-budget.js';
import { estimatePreparedPromptTokens } from '../token-utils.js';
import {
  digest,
  fail,
  now,
  validPageId,
  pageType,
  extractWikilinks,
  LIMITS,
  COMPILER_VERSION,
} from './contracts.js';
import { getSource, readReleaseManifest } from './source-repository.js';
import { KbTaskRuntime, KB_TASK_TOOLS } from './runtime.js';
import {
  prepareStaging,
  writeStagingPage,
  readStagingPages,
  buildIndex,
  finalizeStaging,
  publishRelease,
} from './publisher.js';
import { structuralLint } from './lint.js';
import { selectRelatedPages } from './search.js';

/**
 * Run one controlled model step; completion requires a successful tool receipt.
 * @param options - {ctx, llm, config, owner, store, signal, installation, kind,
 *   promptKey, documents, instruction, budget, description}.
 * @returns The validated structured submission.
 */
export async function runModelStep(options) {
  const {
    ctx,
    llm,
    config,
    owner,
    store,
    signal,
    installation,
    kind,
    promptKey,
    documents,
    instruction,
    budget,
    description,
  } = options;
  signal.throwIfAborted();
  const runtime = new KbTaskRuntime({ kind, documents, budget });
  runtime.signal = signal;
  const variables = {
    runtimeId: runtime.id,
    kind,
    instruction,
    documents: JSON.stringify(
      documents.map(({ id, kind: docKind, title, version, required }) => ({
        id,
        kind: docKind,
        title,
        version,
        required: !!required,
      })),
    ),
  };
  const prepared = await prepareTaskPrompt(ctx, llm, config, {
    promptKey,
    variables,
    cwd: store.scope.workspaceRoot,
    parentAgent: owner.agent,
    signal,
  });
  const readCost = documents.reduce(
    (sum, doc) => sum + estimateArtifactReadTokens(doc.id, doc.body),
    0,
  );
  const inputCost = estimatePreparedPromptTokens(prepared) + readCost;
  if (inputCost + LIMITS.outputReserveTokens >= budget.limit) {
    fail('KB_BUDGET_EXCEEDED', 413, {
      estimatedInputTokens: inputCost,
      limit: budget.limit,
      instruction: 'Reduce the selected sources or split the material.',
    });
  }
  signal.throwIfAborted();
  installation.add(runtime);
  try {
    const result = await executeTask(ctx, llm, config, {
      promptKey,
      variables,
      parentAgent: owner.agent,
      cwd: store.scope.workspaceRoot,
      signal,
      runtime,
      preparedPromptData: prepared,
      maxInputTokens: budget.limit,
      toolFilter: { allow: KB_TASK_TOOLS },
      description: description || 'ReqHub knowledge ' + kind,
      liveness: { enabled: false },
      callbacks: {
        onProgress: () => {
          signal.throwIfAborted();
        },
      },
    });
    signal.throwIfAborted();
    if (result.isError || !runtime.result) {
      throw (
        runtime.failure ||
        Object.assign(new Error('KB_MODEL_FAILED'), {
          code: 'KB_MODEL_FAILED',
          status: 502,
          details: {
            stopReason: result.stopReason,
            errorCode: result.errorCode,
            diagnostic: result.diagnostic,
          },
        })
      );
    }
    return runtime.result;
  } finally {
    installation.close(runtime);
  }
}

function sourceDocument(source, content) {
  return {
    id: 'source:' + source.id,
    kind: 'source',
    title: source.title,
    body: content,
    version: source.revision,
    required: true,
    sourceId: source.id,
    lineCount: content.split('\n').length,
  };
}

function rulesDocument(rules) {
  return {
    id: 'rules',
    kind: 'rules',
    title: 'Knowledge rules',
    body: rules.purpose + '\n\n' + rules.schema,
    version: rules.rulesHash,
    required: true,
  };
}

function wikiDocuments(pages) {
  return pages.map((page) => ({
    id: 'wiki:' + page.pageId,
    kind: 'wiki',
    title: page.meta.title,
    body: page.text,
    version: page.hash,
    required: false,
    pageId: page.pageId,
    baseHash: page.hash,
  }));
}

const CITATION = /\(source:([a-zA-Z0-9-]+)@([a-zA-Z0-9-]+)#L(\d+)-L(\d+)\)/g;

/**
 * Host validation of model page changes; any invalid item fails the whole job.
 * @param upserts - Model-proposed page changes.
 * @param context - {source, active, currentPages, contents} with frozen baselines.
 * @returns Normalized pages ready for staging writes.
 */
export function validateUpserts(upserts, { source, active, currentPages, contents }) {
  const seen = new Set();
  const current = new Map(currentPages.map((page) => [page.pageId, page]));
  const out = [];
  for (const upsert of upserts) {
    const { pageId } = upsert;
    if (!validPageId(pageId) || pageId.startsWith('sources/')) {
      fail('KB_MODEL_OUTPUT_INVALID', 400, { reason: 'invalid pageId', pageId });
    }
    if (seen.has(pageId)) {
      fail('KB_MODEL_OUTPUT_INVALID', 400, { reason: 'duplicate pageId', pageId });
    }
    seen.add(pageId);
    if (upsert.type !== pageType(pageId)) {
      fail('KB_MODEL_OUTPUT_INVALID', 400, { reason: 'type mismatch', pageId });
    }
    if (/^---\n/.test(upsert.body)) {
      fail('KB_MODEL_OUTPUT_INVALID', 400, { reason: 'body must not contain frontmatter', pageId });
    }
    for (const link of extractWikilinks(upsert.body)) {
      const target = link.split('|')[0];
      if (!validPageId(target) && !['overview', 'index'].includes(target)) {
        fail('KB_MODEL_OUTPUT_INVALID', 400, { reason: 'invalid wikilink', pageId, target });
      }
    }
    const baseline = current.get(pageId);
    if (baseline) {
      if (upsert.baseHash !== baseline.hash) {
        fail('KB_MODEL_OUTPUT_INVALID', 400, {
          reason: 'baseHash mismatch; read the current page fully first',
          pageId,
        });
      }
    } else if (upsert.baseHash) {
      fail('KB_MODEL_OUTPUT_INVALID', 400, { reason: 'unknown baseHash', pageId });
    }
    if (!upsert.sources.length) {
      fail('KB_MODEL_OUTPUT_INVALID', 400, { reason: 'page requires sources', pageId });
    }
    const refs = [];
    for (const ref of upsert.sources) {
      const known = active.get(ref.id);
      if (!known || known.revision !== ref.revision) {
        fail('KB_MODEL_OUTPUT_INVALID', 400, {
          reason: 'unknown source revision',
          pageId,
          sourceId: ref.id,
        });
      }
      const lineCount = contents.get(ref.id)?.split('\n').length;
      if (
        !Number.isSafeInteger(ref.startLine) ||
        !Number.isSafeInteger(ref.endLine) ||
        ref.startLine < 1 ||
        ref.endLine < ref.startLine ||
        ref.endLine > lineCount
      ) {
        fail('KB_MODEL_OUTPUT_INVALID', 400, {
          reason: 'citation line range outside source',
          pageId,
          sourceId: ref.id,
        });
      }
      refs.push({ id: ref.id, revision: ref.revision });
    }
    for (const match of upsert.body.matchAll(CITATION)) {
      const [, sourceId, revision, start, end] = match;
      const known = active.get(sourceId);
      const lineCount = contents.get(sourceId)?.split('\n').length;
      if (
        !known ||
        known.revision !== revision ||
        Number(start) < 1 ||
        Number(end) < Number(start) ||
        Number(end) > lineCount
      ) {
        fail('KB_MODEL_OUTPUT_INVALID', 400, {
          reason: 'invalid body citation',
          pageId,
          sourceId,
        });
      }
    }
    if (!upsert.sources.some((ref) => ref.id === source.id)) {
      fail('KB_MODEL_OUTPUT_INVALID', 400, {
        reason: 'generated pages must cite the assigned source',
        pageId,
      });
    }
    out.push({
      pageId,
      type: upsert.type,
      title: upsert.title.trim(),
      body: upsert.body,
      sources: [...new Map(refs.map((ref) => [ref.id + '@' + ref.revision, ref])).values()],
    });
  }
  return out;
}

/**
 * Execute one ingest or rebuild job: per-source analyze/generate, then publish.
 * @param options - {ctx, llm, configLoader, store, job, signal, onStage, installation}.
 * @returns {generationId, summary} or {skipped} when fingerprints all match.
 */
export async function runCompile({
  ctx,
  llm,
  configLoader,
  store,
  job,
  signal,
  onStage,
  installation,
}) {
  const config = await configLoader();
  const provider = ctx.subagents?.getProvider?.(config.ai?.delegation?.provider || 'spawn');
  if (!provider?.capabilities?.toolFilter || provider.inheritsParentContext !== false) {
    fail('KB_PROVIDER_UNAVAILABLE', 503);
  }
  signal.throwIfAborted();
  onStage?.('reading');
  const rules = await store.rules();
  const manifest = await store.sources();
  const pointer = await store.current();
  const baseGeneration = pointer.generationId;
  const baseManifest = baseGeneration ? await readReleaseManifest(store, baseGeneration) : null;
  const active = manifest.sources
    .filter((source) => source.status !== 'excluded')
    .sort((a, b) => a.id.localeCompare(b.id));
  const activeMap = new Map(active.map((source) => [source.id, source]));
  const sourceRevisions = Object.fromEntries(active.map((source) => [source.id, source.revision]));
  const fingerprint = (source) =>
    digest([
      source.revision,
      source.normalizedHash,
      source.normalizerVersion,
      rules.rulesHash,
      COMPILER_VERSION,
    ]);
  let targets =
    job.kind === 'rebuild'
      ? active
      : active.filter((source) => (job.sourceIds || []).includes(source.id));
  if (job.kind === 'ingest' && baseManifest) {
    targets = targets.filter(
      (source) =>
        !(
          baseManifest.fingerprints?.[source.id] === fingerprint(source) &&
          baseManifest.pageHashes?.['sources/' + source.id]
        ),
    );
    if (!targets.length) {
      return { skipped: true, summary: { reason: 'fingerprints-current' } };
    }
  }
  if (!targets.length) {
    fail('KB_NOTHING_TO_COMPILE', 400);
  }
  if (job.kind === 'rebuild' && !active.length) {
    fail('KB_NOTHING_TO_COMPILE', 400);
  }
  const owner = await createWorkspaceTaskAgent(
    ctx,
    { id: store.scope.workspaceId, path: store.scope.workspaceRoot },
    signal,
  );
  const staging = await prepareStaging(
    store,
    job.id,
    job.kind === 'ingest' ? baseGeneration : undefined,
  );
  try {
    let overview = '';
    if (baseGeneration) {
      overview = await readFile(
        store.path('releases', baseGeneration, 'wiki', 'overview.md'),
        'utf8',
      ).catch(() => '');
    }
    const contents = new Map();
    for (const source of targets) {
      signal.throwIfAborted();
      const { content } = await getSource(store, source.id);
      contents.set(source.id, content);
      const budget = await resolveSyncBudget({ ctx, llm, parentAgent: owner.agent, signal });
      const currentPages = await readStagingPages(staging);
      const related = selectRelatedPages(
        currentPages,
        source.title + '\n' + content.slice(0, 2000),
      );
      const indexDoc = {
        id: 'index',
        kind: 'index',
        title: 'Wiki index',
        body: buildIndex(currentPages, 'staging'),
        version: digest(currentPages.map((page) => page.hash)),
        required: false,
      };
      const rulesDoc = rulesDocument(rules);
      const sourceDoc = sourceDocument(source, content);
      onStage?.('analyzing');
      const analysis = await runModelStep({
        ctx,
        llm,
        config,
        owner,
        store,
        signal,
        installation,
        kind: 'analyze',
        promptKey: 'kb-analyze',
        documents: [rulesDoc, sourceDoc, indexDoc, ...wikiDocuments(related)],
        instruction:
          `Analyze the assigned source "${source.title}" (${source.id}@${source.revision}). ` +
          `Generation language: ${rules.language}. Extract reusable facts, entities, concepts, ` +
          'conflicts with existing pages, and proposed page changes. Cite exact source lines.',
        budget,
      });
      signal.throwIfAborted();
      await writeStagingPage(staging, {
        pageId: 'sources/' + source.id,
        type: 'source',
        title: source.title,
        body:
          analysis.summary.trim() +
          contentTemplates().wiki.sourceCitation(
            source.title,
            source.id,
            source.revision,
            sourceDoc.lineCount,
          ),
        sources: [{ id: source.id, revision: source.revision }],
      });
      onStage?.('generating');
      const afterSummary = await readStagingPages(staging);
      const analysisDoc = {
        id: 'analysis',
        kind: 'analysis',
        title: 'Frozen analysis',
        body: JSON.stringify(analysis, null, 2),
        version: digest(JSON.stringify(analysis)),
        required: true,
      };
      const generated = await runModelStep({
        ctx,
        llm,
        config,
        owner,
        store,
        signal,
        installation,
        kind: 'generate',
        promptKey: 'kb-generate',
        documents: [
          rulesDoc,
          sourceDoc,
          analysisDoc,
          { ...indexDoc, body: buildIndex(afterSummary, 'staging') },
          ...wikiDocuments(
            selectRelatedPages(afterSummary, source.title + '\n' + analysis.summary),
          ),
        ],
        instruction:
          `Generate Wiki page changes for source "${source.title}" (${source.id}@${source.revision}) ` +
          `from the frozen analysis. Generation language: ${rules.language}. ` +
          'Read each page you update fully and copy its hash as baseHash. ' +
          'Return the complete updated overview. Do not write source summary pages; the Host owns them.',
        budget,
      });
      signal.throwIfAborted();
      const pages = validateUpserts(generated.upserts || [], {
        source,
        active: activeMap,
        currentPages: afterSummary,
        contents,
      });
      for (const page of pages) {
        await writeStagingPage(staging, page);
      }
      if (generated.overview?.trim()) {
        overview = generated.overview.trim();
      }
    }
    signal.throwIfAborted();
    onStage?.('validating');
    const pages = await readStagingPages(staging);
    const findings = structuralLint({ pages, sourceRevisions });
    const finalized = await finalizeStaging(store, staging, {
      jobId: job.id,
      baseGeneration,
      rulesHash: rules.rulesHash,
      sourceRevisions,
      operation: job.kind,
      // Strip a leading H1 regardless of artifact language; the publisher
      // adds the localized heading back.
      overview: overview.replace(/^#\s+[^\n]*\s*/, ''),
    });
    signal.throwIfAborted();
    onStage?.('publishing');
    await publishRelease(store, staging, {
      generationId: finalized.generationId,
      jobId: job.id,
      epoch: rules.epoch,
      rulesHash: rules.rulesHash,
      sourceRevisions,
      baseGeneration,
      signal,
    });
    return {
      generationId: finalized.generationId,
      summary: {
        sources: targets.length,
        pages: finalized.pages.length,
        findings: findings.length,
        publishedAt: now(),
      },
    };
  } finally {
    await owner.dispose();
    await rm(join(store.dir, 'staging', job.id), { recursive: true, force: true }).catch(() => {
      // A published staging directory was renamed; nothing remains to reclaim.
    });
  }
}
