import { msg } from '../messages.js';
import { assertWorkspaceCaller } from './caller.js';
import { freezeKnowledgeContext } from '../knowledge/enhancements/knowledge-context.js';
import { matchesWorkspacePath } from '../conversations/workspace-path.js';
import { freezeDesignReference, publishedRequirementReference } from '../sync-design-reference.js';
import taskModel from '../../shared/sync-task.cjs';
import { SyncLifecycle } from '../sync-lifecycle.js';
import { syncSupervisor } from '../sync-supervisor.js';
import { installSyncTools } from '../sync-controlled-tools.js';
import { readDocumentVersion, publishDocument, atomicWrite } from '../sync-document-validator.js';

import { resolve, relative } from 'node:path';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { findRequirementDir } from '../doc-reader.js';
import { findBranchByRequirement, beginCommitSync } from '../sync-engine.js';
import { defaultSyncBaseBranch } from '../sync-branches.js';
import { PhasedSyncEngine } from '../phased-sync-engine.js';
import { extractMultipleSessionTurns } from '../session-utils.js';
import { log } from '../logger.js';
import {
  getActiveSync,
  getSyncById,
  setAbortController,
  deleteAbortController,
  recoverSyncTask,
  getAbortController,
  isSyncTaskRemoved,
} from '../sync-state.js';
import { estimateTextTokens } from '../token-utils.js';
import { syncCancellation } from '../sync-cancellation.js';
import { readRetryArtifact } from '../sync-retry.js';
import { setActiveSync } from '../sync-state.js';

/**
 * Create the shared phased-sync use case. HTTP, tools and daily batches supply data
 * and receive structured progress; only the HTTP adapter encodes event streams.
 * @param deps - Instance-owned runtime, scope, storage and cancellation dependencies.
 * @returns An execute method and lifecycle tracking of work beyond a revoked response.
 */
export function createSyncExecution({
  registry,
  llm,
  sessions,
  ctx,
  options,
  storage,
  library,
  codex,
  dsh,
  loadState,
  referenceDirectory,
  ownerScope,
  isClosed,
  controllers,
  pendingSyncs,
  retire,
}) {
  const sessionQuery = ctx?.sessionQuery;
  const application = {
    async execute(suppliedInput, caller = {}, onEvent = () => {}) {
      if (!suppliedInput || typeof suppliedInput !== 'object' || Array.isArray(suppliedInput)) {
        throw Object.assign(new Error('SYNC_REQUEST_INVALID'), { status: 400 });
      }
      if (Buffer.byteLength(JSON.stringify(suppliedInput)) > 10 * 1024 * 1024) {
        throw Object.assign(new Error('SYNC_INPUT_TOO_LARGE'), { status: 413 });
      }
      if (isClosed()) {
        throw Object.assign(new Error('SESSION_SERVICE_CLOSED'), { status: 503 });
      }
      const parentSignal = caller.signal;
      parentSignal?.throwIfAborted();
      const requestedWorkspace = registry
        .list()
        .find((item) => item.id === suppliedInput.workspaceId);
      if (requestedWorkspace) {
        await assertWorkspaceCaller(caller, requestedWorkspace);
      }
      await retire();
      if (isClosed()) {
        throw Object.assign(new Error('SESSION_SERVICE_CLOSED'), { status: 503 });
      }
      const requestController = new AbortController();
      const cancelParent = () => requestController.abort(parentSignal.reason);
      if (parentSignal?.aborted) {
        cancelParent();
      } else {
        parentSignal?.addEventListener('abort', cancelParent, { once: true });
      }
      let streaming = false;
      let ended = false;
      let status = 200;
      let value;
      const reply = (result, code = 200) => {
        status = code;
        value = result;
      };
      const emit = (event) => {
        value = event;
        onEvent(event);
      };
      let detach;
      const detached = new Promise((resolve) => {
        detach = resolve;
      });
      const execution = syncCancellation.run(requestController.signal, async () => {
        let syncTask;
        let syncId;
        let lifecycle;
        let abortController;
        let sendEvent = () => {};
        let workspaceId;
        let requirementId;
        let lease;
        let quickRequirementReference;
        let retrySource;
        let retryFrozen;
        let preparationScope;
        try {
          let input = suppliedInput;
          if (input.retrySyncId) {
            const directory = await referenceDirectory(input.workspaceId, input.requirementId);
            await loadState(input.workspaceId, input.requirementId, directory);
            retrySource = await getSyncById(
              input.retrySyncId,
              input.workspaceId,
              input.requirementId,
            );
            if (
              !retrySource ||
              !['failed', 'aborted'].includes(retrySource.status) ||
              retrySource.snapshotDir !== input.snapshotDir ||
              taskModel.hasPublishedDocument(retrySource)
            ) {
              throw Object.assign(new Error('SYNC_RETRY_INVALID'), { statusCode: 409 });
            }
            if (
              input.retryChunkIndex !== undefined &&
              (!Number.isInteger(input.retryChunkIndex) ||
                input.retryChunkIndex < 0 ||
                !input.retryPhase)
            ) {
              throw Object.assign(new Error('SYNC_RETRY_NODE_INVALID'), { statusCode: 400 });
            }
            if (input.retryPhase) {
              const step = retrySource.steps?.find((item) => item.phase === input.retryPhase);
              const unit =
                input.retryChunkIndex === undefined ? step : step?.chunks?.[input.retryChunkIndex];
              if (!unit || !['failed', 'aborted'].includes(unit.status)) {
                throw Object.assign(new Error('SYNC_RETRY_NODE_INVALID'), { statusCode: 409 });
              }
            }
            retryFrozen = readRetryArtifact(storage, retrySource, 'retry.input');
            input = {
              ...(retrySource.retryRequest || retrySource),
              workspaceId: input.workspaceId,
              requirementId: input.requirementId,
              requestId: input.requestId,
              quick: false,
            };
          }
          if (
            input.requestId !== undefined &&
            (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(input.requestId))
          ) {
            throw Object.assign(new Error('SYNC_REQUEST_INVALID'), { statusCode: 400 });
          }
          const { docType: requestedDocType, sessionIds: requestedSessionIds = [] } = input;
          const docType = input.quick === true ? 'requirement' : requestedDocType;
          const sessionIds = input.quick === true ? [] : requestedSessionIds;
          ({ workspaceId, requirementId } = input);

          if (!workspaceId || !requirementId || !docType) {
            reply({ error: 'Missing workspaceId, requirementId, or docType' }, 400);
            return;
          }

          const workspaces = registry.list();
          const workspace = workspaces.find((w) => w.id === workspaceId);

          if (!workspace) {
            reply({ error: 'Workspace not found' }, 404);
            return;
          }
          await assertWorkspaceCaller(caller, workspace);

          await syncSupervisor.check();
          lease = syncSupervisor.acquire(
            {
              requestId: input.requestId,
              workspaceId,
              requirementId,
              docType,
              docTypeName: docType === 'requirement' ? 'DOC_REQUIREMENT' : 'DOC_TECHNICAL_DESIGN',
            },
            requestController,
          );
          if (!lease) {
            return reply(
              {
                active: true,
                sync: syncSupervisor.snapshot().active,
                message: 'SYNC_TASK_ALREADY_RUNNING',
              },
              409,
            );
          }
          lease.scope = ownerScope;
          if (input.quick === true) {
            syncSupervisor.beginQuick(lease);
          }
          lease.onRecovered = (reason) => {
            syncSupervisor.finishQuick(lease, lease.deleted ? 'aborted' : 'failed', reason);
            if (syncTask) {
              deleteAbortController(workspaceId, requirementId, syncId, abortController);
            }
            controllers.delete(abortController);
            if (streaming && !ended) {
              try {
                emit(
                  lease.deleted
                    ? { type: 'deleted', syncId, snapshotDir: syncTask?.snapshotDir }
                    : {
                        type: 'error',
                        error: reason,
                        sync: lease.notice || syncTask,
                        quickSync: lease.quickSync,
                      },
                );
              } catch (error) {
                // A disconnected client cannot receive the terminal event; cleanup still proceeds.
              }
            }
            ended = true;
            detach();
          };
          abortController = lease.controller;
          lease.revoke = () => installSyncTools(ctx)?.revoke(abortController.signal);
          const onPreparation = (activity) => syncSupervisor.preparing(lease, activity);
          onPreparation({ stage: 'preparing' });

          let quickBaseBranch;
          if (input.quick === true) {
            await findBranchByRequirement(
              workspace.path,
              requirementId,
              undefined,
              input.targetBranch ?? '',
            );
            quickBaseBranch = await defaultSyncBaseBranch(workspace.path);
            if (!quickBaseBranch) {
              throw Object.assign(new Error('SYNC_BASE_BRANCH_MISSING'), { statusCode: 400 });
            }
          }

          const documentTypes = input.quick === true ? ['requirement', 'design'] : [docType];
          for (const docType of documentTypes) {
            syncSupervisor.assert(lease);
            syncTask = undefined;
            syncId = undefined;
            lifecycle = undefined;
            const config = await loadConfig();
            const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
            const reqDir = await findRequirementDir(docsRoot, requirementId);
            if (!reqDir) {
              throw Object.assign(new Error('SYNC_REQUIREMENT_NOT_FOUND'), { statusCode: 404 });
            }
            preparationScope = { input, workspace, docsRoot, reqDir, docType };
            syncSupervisor.assert(lease);
            if (!llm) {
              throw Object.assign(new Error('SYNC_LLM_UNAVAILABLE'), { statusCode: 503 });
            }
            if (
              !Array.isArray(sessionIds) ||
              sessionIds.some((id) => typeof id !== 'string') ||
              new Set(sessionIds).size !== sessionIds.length
            ) {
              return reply({ error: 'SESSION_SELECTION_INVALID' }, 400);
            }
            onPreparation({ stage: 'sessions' });
            const codexIds = sessionIds.filter((id) => id.startsWith('codex:'));
            if (!retryFrozen && codexIds.length) {
              const cached = await codex.list(workspaceId);
              const allowed = new Set(
                (cached.sessions || [])
                  .filter((entry) => matchesWorkspacePath({ path: entry.cwd }, workspace.path))
                  .map((entry) => entry.id),
              );
              if (codexIds.some((id) => !allowed.has(id))) {
                throw Object.assign(new Error('CODEX_SESSION_WORKSPACE_MISMATCH'), {
                  statusCode: 403,
                });
              }
            }
            const codexSnapshots = new Map(
              (retryFrozen
                ? []
                : await codex.snapshots(codexIds, workspaceId, {
                    signal: requestController.signal,
                  })
              ).map((snapshot) => [snapshot.sessionId, snapshot]),
            );
            const dshIds = sessionIds.filter((id) => !id.startsWith('codex:'));
            syncSupervisor.assert(lease);
            if (
              !retryFrozen &&
              dshIds.length &&
              !(await library.list(workspaceId, dsh)).workspace
            ) {
              await library.refresh(workspaceId, workspaceId, dsh, undefined, {
                signal: requestController.signal,
              });
            }
            const dshSnapshots = new Map(
              (retryFrozen
                ? []
                : await library.snapshots(workspaceId, dshIds, dsh, {
                    signal: requestController.signal,
                  })
              ).map((snapshot) => [snapshot.sessionId, snapshot]),
            );
            syncSupervisor.assert(lease);
            const sessionInput =
              retryFrozen?.sessionInput ||
              (await extractMultipleSessionTurns(sessionQuery, sessionIds, {
                sessions,
                readSnapshot: (id) => codexSnapshots.get(id) || dshSnapshots.get(id),
              }));
            for (const snapshot of sessionInput.snapshots) {
              if (input.sessionVersions?.[snapshot.sessionId] !== snapshot.version) {
                return reply({ error: 'SESSION_CHANGED' }, 409);
              }
              if (!snapshot.syncTurnCount) {
                return reply({ error: msg('SESSION_EMPTY', { v0: snapshot.sessionId }) }, 400);
              }
            }
            const docTypeName =
              docType === 'requirement' ? 'DOC_REQUIREMENT' : 'DOC_TECHNICAL_DESIGN';

            let designReference = retryFrozen?.designReference;
            if (docType === 'design' && !designReference) {
              if (input.quick === true) {
                if (!quickRequirementReference) {
                  throw new Error('SYNC_REFERENCE_MISSING');
                }
                designReference = quickRequirementReference;
              } else if (
                input.designReferencePath !== undefined &&
                input.designReferencePath !== ''
              ) {
                const directory = await referenceDirectory(workspaceId, requirementId);
                designReference = await freezeDesignReference(
                  directory,
                  input.designReferencePath,
                  abortController.signal,
                );
              }
            }
            const referenceMetadata = designReference
              ? { ...designReference, text: undefined }
              : undefined;

            const hasSessions = sessionIds.length > 0;
            const fields = {
              workspaceId,
              workspace,
              docsRoot,
              requirementId,
              docType,
              docTypeName,
              ...(referenceMetadata ? { designReference: referenceMetadata } : {}),
              requirementPath: relative(docsRoot, reqDir).replaceAll('\\', '/'),
              sessionIds,
              conversationStorageVersion: 1,
              ownerProfile: library.owner,
              sessionSnapshots: sessionInput.snapshots.map(
                ({ sessionId, conversationId, version, syncTurnCount }) => ({
                  sessionId,
                  conversationId,
                  version,
                  syncTurnCount,
                }),
              ),
              targetBranch: input.targetBranch,
              baseBranch:
                quickBaseBranch ||
                input.baseBranch?.trim() ||
                (await defaultSyncBaseBranch(workspace.path)),
              commitHashes: input.commitHashes,
              branchTip: input.branchTip,
              baseCommit: input.baseCommit,
              includeWorkingChanges:
                input.quick === true ? false : input.includeWorkingChanges !== false,
              startedAt: Date.now(),
              ...(lease.quickSync ? { quickSyncId: lease.quickSync.id } : {}),
              status: 'running', // running | completed | failed
              steps: taskModel.createSyncSteps({ sessionIds }),
              generatedFiles: [],
              retryRequest: { ...input, docType, quick: false },
              ...(retrySource ? { retryOf: retrySource.id } : {}),
            };

            if (isClosed()) {
              throw new Error('SYNC_PLUGIN_UNLOADING');
            }
            syncSupervisor.assert(lease);
            await loadState(workspaceId, requirementId, reqDir);
            const orphan = await getActiveSync(workspaceId, requirementId);
            if (orphan) {
              await recoverSyncTask(orphan, 'SYNC_OWNER_MISSING_ORIGINAL');
            }
            const staleController = getAbortController(workspaceId, requirementId);
            if (staleController) {
              staleController.controller.abort();
              deleteAbortController(
                workspaceId,
                requirementId,
                staleController.syncId,
                staleController.controller,
              );
            }
            let prepared = await beginCommitSync(workspace.path, reqDir, fields, {
              signal: abortController.signal,
              onProgress: onPreparation,
              frozen: retryFrozen?.prepared,
            });
            syncSupervisor.assert(lease);
            if (prepared.active) {
              await recoverSyncTask(prepared.sync, 'SYNC_OWNER_MISSING_ORIGINAL');
              prepared = await beginCommitSync(workspace.path, reqDir, fields, {
                signal: abortController.signal,
                onProgress: onPreparation,
              });
            }
            if (prepared.skipped && lease.quickSync) {
              lease.quickSync.documents.push({ docType, status: 'skipped' });
              if (docType === 'requirement') {
                const directory = await referenceDirectory(workspaceId, requirementId);
                quickRequirementReference = await freezeDesignReference(
                  directory,
                  'requirement.md',
                  abortController.signal,
                );
                syncSupervisor.advanceQuick(lease, 'design');
                continue;
              }
              syncSupervisor.finishQuick(lease, 'completed');
              if (streaming) {
                sendEvent({
                  type: 'done',
                  sync: lease.notice,
                  quickSync: lease.quickSync,
                  skipped: true,
                });
                ended = true;
              } else {
                reply({ ...prepared, quickSync: lease.quickSync });
              }
              return;
            }
            if (prepared.active && lease.quickSync) {
              throw Object.assign(new Error('SYNC_SEQUENCE_CONFLICT'), { statusCode: 409 });
            }
            if (prepared.active || prepared.skipped) {
              reply(prepared);
              return;
            }
            syncTask = prepared.sync;
            await library.store.pin(
              JSON.stringify([workspaceId, requirementId, syncTask.snapshotDir]),
              sessionInput.snapshots.filter((snapshot) => snapshot.conversationId),
            );
            syncId = syncTask.id;
            syncSupervisor.attach(lease, syncTask, (reason) => recoverSyncTask(syncTask, reason));
            controllers.set(abortController, syncTask);
            if (isClosed()) {
              abortController.abort();
            }
            setAbortController(workspaceId, requirementId, abortController, syncId);
            const { branchName, commits, codeDiff, uncommittedChanges, sourceSnapshots } = prepared;

            streaming = true;

            sendEvent = (data) => {
              if (syncSupervisor.owner !== lease) {
                return;
              }
              syncSupervisor.touch(lease);
              if (ended || ended) {
                return;
              }
              try {
                emit({
                  ...data,
                  ...(lease.quickSync ? { quickSync: lease.quickSync } : {}),
                });
              } catch (error) {
                log.sync.debug(msg('SYNC_CONNECTION_LOST_TASK_PERSISTING', { v0: error.message }));
              }
            };
            lifecycle = new SyncLifecycle(syncTask, sendEvent);
            const updateStep = (phase, updates) => lifecycle.step(phase, updates);
            const addFile = (phase, fileName, logicalId) =>
              lifecycle.file(phase, storage.artifact(syncTask, fileName, { logicalId }));

            sendEvent({ type: 'sync_started', syncId, commitHash: syncTask.commitHash });
            await updateStep('init', {
              status: 'running',
              text: 'SYNC_READING_FROZEN_COMMITS',
            });

            // Read current document
            const docFileName = docType === 'requirement' ? 'requirement.md' : 'design.md';
            const docPath = join(reqDir, docFileName);

            const originalVersion = retryFrozen?.originalVersion
              ? {
                  exists: retryFrozen.originalVersion.exists,
                  bytes: Buffer.from(retryFrozen.originalVersion.base64, 'base64'),
                }
              : await readDocumentVersion(docPath);
            const currentDoc = originalVersion.bytes.toString('utf8');
            const isNewDoc = !originalVersion.exists;

            const initText = [];
            if (commits && commits.length > 0) {
              initText.push(msg('SYNC_COMMIT_COUNT', { v0: commits.length }));
            } else {
              initText.push('SYNC_NO_COMMITS');
            }
            if (uncommittedChanges.hasChanges) {
              const parts = [];
              if (uncommittedChanges.staged) {
                parts.push('STATUS_STAGED');
              }
              if (uncommittedChanges.unstaged) {
                parts.push('STATUS_UNSTAGED');
              }
              if (uncommittedChanges.untracked.length > 0) {
                parts.push(msg('SYNC_NEW_FILE_COUNT', { v0: uncommittedChanges.untracked.length }));
              }
              initText.push(msg('SYNC_UNCOMMITTED_CHANGES', { v0: parts }));
            }
            if (isNewDoc) {
              initText.push('SYNC_NEW_DOCUMENT');
            }

            // ─── Step 2: Session Extract ──────────────────────────
            const sessionTurns = sessionInput.turns;
            if (sessionIds.length > 0) {
              await updateStep('init', {
                status: 'running',
                text: msg('SYNC_EXTRACT_SESSION_CONTENT', { v0: sessionIds.length }),
              });

              try {
                await updateStep('init', {
                  status: 'running',
                  text: msg('SYNC_TURNS_EXTRACTED_CHECK_BUDGET', { v0: sessionTurns.length }),
                });
              } catch (e) {
                log.sync.warn(msg('SYNC_EXTRACT_SESSION_CONTENT_FAILED', { v0: e.message }));
                throw msg('SYNC_SESSION_EXTRACTION_FAILED', { v0: e.message });
              }
            }

            // ─── Step 3-5: Run phased sync engine ────────────────

            const syncDir = storage.attemptRoot(syncTask, true);

            // Scheduled runs delegate through a dedicated background agent.
            // Prefer that owned agent: looking it up in the live session
            // registry would fail for workspaces without an active session.
            const parentAgent = caller.agent;
            if (!parentAgent) {
              throw new Error('SESSION_NOT_ACTIVE');
            }

            if (abortController.signal.aborted) {
              throw new Error('SYNC_TERMINATED');
            }

            const engine = new PhasedSyncEngine({
              llm,
              config,
              cwd: workspace.path,
              ctx,
              parentAgent,
              signal: abortController.signal,
              storage,
              task: syncTask,
              retrySource,
              onActivity: () => syncSupervisor.touch(lease),
              assertActive: () => {
                syncSupervisor.assert(lease);
                storage.assert(syncTask);
              },
            });

            await updateStep('init', {
              status: 'running',
              text: 'SYNC_CALCULATE_CHUNK_BUDGET',
            });
            const knowledgeContext =
              retryFrozen?.knowledgeContext ||
              (await freezeKnowledgeContext(
                options.knowledgeV2?.context,
                input.knowledgeScopeIds,
                input.knowledgeQuery || requirementId,
                abortController.signal,
                input.knowledgeReferenceRefs,
              ));
            syncSupervisor.assert(lease);
            const { sync: preparedTask, ...frozenPrepared } = prepared;
            storage.putEvidence(
              syncTask,
              'retry.input',
              JSON.stringify({
                prepared: frozenPrepared,
                sessionInput,
                designReference,
                originalVersion: {
                  exists: originalVersion.exists,
                  base64: originalVersion.bytes.toString('base64'),
                },
                knowledgeContext,
              }),
            );
            const preparedChunks = await engine.prepareSyncChunks({
              docType,
              currentDoc,
              originalVersion,
              commits,
              codeDiff,
              sourceSnapshots,
              sessionTurns,
              knowledgeContext,
              designReference,
              syncContext: {
                taskId: syncId,
                branchName,
                targetSha: syncTask.commitHash,
                baseSha: syncTask.baselineCommit,
                attempt: syncTask.snapshotDir,
              },
              hasUncommitted: uncommittedChanges.hasChanges,
              syncDir,
              onPreparation: (activity) => updateStep('init', { activity }),
            });
            if (knowledgeContext.length) {
              await lifecycle.metadata({
                knowledgeRefs: knowledgeContext.map(({ text, ...reference }) => reference),
              });
            }
            for (const reference of knowledgeContext) {
              await addFile('init', reference.id + '.json', reference.id);
            }
            if (designReference) {
              await addFile('init', 'design-reference.json', 'design.reference');
            }
            await addFile('init', 'input-code.diff', 'code.input');
            await addFile('init', 'manifest.json');
            for (const entry of preparedChunks.store.entries.values()) {
              if (entry.file.startsWith('sessions/')) {
                await addFile('init', entry.file.replaceAll('/', '-'), entry.id);
              }
            }
            await updateStep('code_analysis', {
              chunks: preparedChunks.code.map((c) => ({
                index: c.index,
                tokens: c.tokens,
                inputBudget: c.inputBudget,
                files: c.details.map((d) => ({ file: d.file, tokens: d.tokens })),
              })),
            });
            if (hasSessions) {
              await updateStep('discussion_analysis', {
                chunks: preparedChunks.discussion.map((c) => ({
                  index: c.index,
                  tokens: c.tokens,
                  inputBudget: c.inputBudget,
                  turns: c.details,
                })),
              });
            }
            await updateStep('init', {
              status: 'completed',
              text: [
                ...initText,
                msg('SYNC_CHUNK_BUDGET_CHECK_PASSED', {
                  v0: preparedChunks.code.length,
                  v1: preparedChunks.discussion.length,
                }),
              ],
              inputBudget: preparedChunks.budget,
              sourceTokens: estimateTextTokens(codeDiff),
              hasUncommitted: uncommittedChanges.hasChanges,
            });

            const result = await engine.sync({
              preparedChunks,
              originalVersion,
              sourceSnapshots,
              docType,
              currentDoc,
              commits,
              codeDiff,
              sessionTurns,
              hasUncommitted: uncommittedChanges.hasChanges,
              reqDir,
              syncDir,
              onProgress: async (progress) => {
                if (progress.status === 'output_file') {
                  return addFile(progress.phase, progress.fileName);
                }
                await lifecycle.progress(progress);
              },
            });

            if (result.aborted || abortController.signal.aborted) {
              throw new Error('SYNC_TERMINATED');
            }
            if (result.errors?.length || typeof result.mergedDoc !== 'string') {
              const failure = new Error(
                result.errors?.map((item) => item.error).join('；') || 'SYNC_NO_VALID_DOC_SNAPSHOT',
              );
              failure.phase = result.errors?.[0]?.phase;
              throw failure;
            }
            if (result.patchFile) {
              await addFile('merge', result.patchFile);
            }
            if (result.appliedDiffFile) {
              await addFile('merge', result.appliedDiffFile);
            }
            if (
              result.schemaVersion !== 2 ||
              !result.validation ||
              !Buffer.isBuffer(result.candidateBytes)
            ) {
              throw new Error('SYNC_V2_RESULT_REQUIRED');
            }
            await lifecycle.metadata({
              originalHash: result.validation.originalHash,
              candidateHash: result.validation.candidateHash,
              publishState: 'prepared',
            });
            await updateStep('publish', {
              status: 'running',
              text: 'SYNC_CHECK_VERSION_AND_PUBLISH',
            });
            syncSupervisor.assert(lease);
            await publishDocument({
              docPath,
              syncDir: join(syncDir, 'outputs'),
              fileName: docFileName,
              original: originalVersion,
              candidateBytes: result.candidateBytes,
              validation: result.validation,
              signal: abortController.signal,
              assertActive: () => {
                syncSupervisor.assert(lease);
                storage.assert(syncTask);
              },
            });
            await lifecycle.metadata({ publishState: 'document_written' });
            if (options.knowledgeV2?.sync) {
              try {
                await options.knowledgeV2.sync.capture(workspaceId, relative(docsRoot, docPath));
              } catch (error) {
                await lifecycle.metadata({
                  knowledge: { status: 'failed', code: 'KB_SYNC_FAILED' },
                });
              }
            }
            await updateStep('publish', {
              status: 'completed',
              text: 'SYNC_PUBLISHED_DOC_MATCHES_SNAPSHOT',
            });
            await addFile('merge', docFileName);

            await lifecycle.metadata({ stats: result.stats, publishState: 'state_committed' });

            try {
              const journalPath = storage.file(syncTask, 'publish-journal.json');
              const journal = JSON.parse(await readFile(journalPath, 'utf8'));
              await atomicWrite(
                journalPath,
                JSON.stringify({ ...journal, stage: 'state_committed' }, null, 2),
                abortController.signal,
                () => {
                  syncSupervisor.assert(lease);
                  storage.assert(syncTask);
                },
              );
            } catch (error) {
              log.sync.warn(msg('SYNC_PUBLISH_JOURNAL_FINALIZE_FAILED', { v0: error.message }));
            }

            abortController.signal.throwIfAborted();
            await lifecycle.finish();
            log.sync.info(
              msg('SYNC_PHASED_SYNC_FINISHED', { v0: docTypeName, v1: syncTask.status }),
            );

            if (lease.quickSync) {
              lease.quickSync.documents.push({
                docType,
                status: syncTask.status,
                id: syncTask.id,
                snapshotDir: syncTask.snapshotDir,
                workspaceId,
                requirementId,
              });
              if (syncTask.status !== 'completed') {
                throw new Error(syncTask.error || 'SYNC_DOCUMENT_NOT_COMPLETED');
              }
              if (docType === 'requirement') {
                quickRequirementReference = publishedRequirementReference(
                  result.candidateBytes,
                  syncTask.id,
                );
                sendEvent({ type: 'document_done', sync: syncTask });
                deleteAbortController(workspaceId, requirementId, syncId, abortController);
                controllers.delete(abortController);
                syncSupervisor.advanceQuick(lease, 'design');
                continue;
              }
              syncSupervisor.finishQuick(lease, 'completed');
            }
            sendEvent({
              type: 'done',
              sync: syncTask,
              status: syncTask.status,
              syncId,
              docType,
              stats: result.stats,
              files: syncTask.generatedFiles,
            });
            ended = true;
          }
        } catch (e) {
          const rejectionStatus = e.statusCode || e.status;
          const inputRejected = rejectionStatus >= 400 && rejectionStatus < 500;
          if (
            !syncTask &&
            lease &&
            preparationScope &&
            !lease.deleted &&
            (!inputRejected || lease.controller.signal.aborted)
          ) {
            try {
              const { workspace, docsRoot, reqDir, docType, input } = preparationScope;
              await loadState(workspaceId, requirementId, reqDir);
              if (!(await getActiveSync(workspaceId, requirementId))) {
                syncTask = {
                  schemaVersion: 2,
                  workspaceId,
                  requirementId,
                  docType,
                  docTypeName: docType === 'design' ? 'DOC_TECHNICAL_DESIGN' : 'DOC_REQUIREMENT',
                  taskId: 'preparing-' + docType,
                  startedAt: lease.startedAt,
                  status: 'running',
                  steps: taskModel.createSyncSteps({ sessionIds: input.sessionIds }),
                  retryRequest: { ...input, docType, quick: false },
                  generatedFiles: [],
                };
                await setActiveSync(syncTask, reqDir);
                syncId = syncTask.id;
                lease.task = syncTask;
              }
            } catch (error) {
              log.sync.error('SYNC_PREPARATION_STATE_FAILED: ' + error.message);
            }
          }
          log.sync.error(msg('SYNC_PHASED_SYNC_FAILED', { v0: e.message }));
          syncSupervisor.finishQuick(
            lease,
            abortController?.signal.aborted ? 'aborted' : 'failed',
            e.message,
          );

          if (syncTask && !isSyncTaskRemoved(syncTask)) {
            lifecycle ||= new SyncLifecycle(syncTask, sendEvent);
            try {
              await lifecycle.finish({
                status: abortController?.signal.aborted ? 'aborted' : 'failed',
                error: e.message,
                phase: e.phase,
              });
            } catch (persistError) {
              log.sync.error(msg('SYNC_PERSIST_FINAL_STATE_FAILED', { v0: persistError.message }));
            }
          }

          if (streaming) {
            try {
              sendEvent({
                type: 'error',
                error: e.message,
                sync: lease?.notice || syncTask,
                quickSync: lease?.quickSync,
              });
            } catch (error) {
              // A disconnected client cannot receive the error event; cleanup still proceeds.
            }
          } else {
            let status;
            if (['SYNC_BRANCH_INVALID', 'SYNC_WORKSPACE_REPOSITORY_MISMATCH'].includes(e.message)) {
              status = 400;
            } else if (/^(?:COMMIT_LIST_CHANGED|INPUT_CHANGED):/.test(e.message)) {
              status = 409;
            } else if (
              /^(?:COMMIT_OUT_OF_RANGE|COMMIT_SELECTION_INVALID|BASE_BRANCH_)/.test(e.message)
            ) {
              status = 400;
            } else {
              status = 500;
            }
            reply(
              { error: e.message, ...(syncTask ? { sync: syncTask } : {}) },
              e.statusCode || e.status || status,
            );
          }
          ended = true;
        } finally {
          parentSignal?.removeEventListener('abort', cancelParent);
          if (syncTask) {
            deleteAbortController(workspaceId, requirementId, syncId, abortController);
          }
          controllers.delete(abortController);
          if (lease) {
            syncSupervisor.finishQuick(
              lease,
              abortController?.signal.aborted ? 'aborted' : 'failed',
              'SYNC_SEQUENCE_INCOMPLETE',
            );
            syncSupervisor.release(lease);
          }
          if (lease?.deleted) {
            await lease
              .cleanup?.()
              .catch((error) =>
                log.sync.debug(msg('SYNC_DELETE_TASK_CLEANUP', { v0: error.message })),
              );
          }
        }
      });
      pendingSyncs.add(execution);
      // Revocation may finish the caller's response before an uncooperative child stops.
      // Keep the actual execution owned until it settles; teardown must await it.
      void execution
        .finally(() => pendingSyncs.delete(execution))
        .catch((error) => {
          log.sync.error(error.message);
        });
      await Promise.race([execution, detached]);
      return { status, value };
    },
  };
  return {
    execute(...args) {
      const pending = application.execute(...args);
      pendingSyncs.add(pending);
      return pending.finally(() => pendingSyncs.delete(pending));
    },
  };
}
