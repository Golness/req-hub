import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import model from '../../src/shared/sync-task.cjs';
import { SyncLifecycle } from '../../src/server/sync-lifecycle.js';
import { setActiveSync, getActiveSync, getSyncHistory, updateSyncProgress, abortSync, setAbortController, deleteAbortController, removeSyncTask } from '../../src/server/sync-state.js';

const task = options => ({ id: randomUUID(), workspaceId: randomUUID(), requirementId: 'req', status: 'running', startedAt: 1, steps: model.createSyncSteps(options), generatedFiles: [] });
const openUnits = task => task.steps.flatMap(step => [step, ...(step.chunks || [])]).filter(unit => ['pending', 'queued', 'running'].includes(unit.status));
describe('one sync lifecycle for tasks, phases and chunks', () => {
  it('never emits or archives a removed task when its old execution later returns',async()=>{
    const root=await mkdtemp(join(tmpdir(),'reqhub-removed-')),old=task(),events=[];old.snapshotDir='v2/removed';
    try {
      await setActiveSync(old,root);const lifecycle=new SyncLifecycle(old,event=>events.push(event));
      await removeSyncTask(old);
      const current={...old,removed:false,status:'running',snapshotDir:'v2/retry',steps:model.createSyncSteps()};
      await setActiveSync(current,root);
      await lifecycle.step('init',{status:'running'});await lifecycle.finish({status:'failed',error:'late failure'});
      expect(events).toHaveLength(0);expect((await getActiveSync(old.workspaceId,old.requirementId)).snapshotDir).toBe('v2/retry');
      expect(await getSyncHistory(old.workspaceId,old.requirementId)).toHaveLength(0);
      await new SyncLifecycle(current).finish({status:'failed'});
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('fences late events and completion from a reclaimed attempt with the same task ID', async () => {
    const root=await mkdtemp(join(tmpdir(),'reqhub-fenced-')), old=task();old.snapshotDir='v2/old';
    try {
      await setActiveSync(old,root);const lifecycle=new SyncLifecycle(old);
      const current={...old,steps:model.createSyncSteps(),snapshotDir:'v2/new'};
      await setActiveSync(current,root);
      await lifecycle.step('init',{status:'completed'});await lifecycle.finish({status:'failed',error:'old timeout'});
      const active=await getActiveSync(old.workspaceId,old.requirementId);
      expect(active.snapshotDir).toBe('v2/new');expect(active.status).toBe('running');expect(active.steps[0].status).toBe('pending');
      expect(await getSyncHistory(old.workspaceId,old.requirementId)).toHaveLength(0);
      await new SyncLifecycle(current).finish({status:'failed'});
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it.each(['init', 'code_analysis', 'discussion_analysis', 'merge', 'validate', 'publish'])('closes every open unit on %s failure', phase => {
    const t = task({ sessionIds: ['s'] });
    const index = t.steps.findIndex(s => s.phase === phase);
    for (const step of t.steps.slice(0, index)) model.updateSyncTask(t, { type: 'step', phase: step.phase, updates: { status: 'completed' } });
    model.updateSyncTask(t, { type: 'step', phase, updates: { status: 'running' } });
    model.updateSyncTask(t, { type: 'chunk', phase, chunkIndex: 0, updates: { status: 'running', sessionId: 'child' } });
    model.updateSyncTask(t, { type: 'chunk', phase, chunkIndex: 1, updates: { status: 'queued' } });
    model.finishSyncTask(t, { status: 'failed', error: 'fixture failure', phase, now: 10 });
    expect(t.status).toBe('failed'); expect(t.completedAt).toBe(10); expect(openUnits(t)).toHaveLength(0);
    expect(t.steps[index].status).toBe('failed'); expect(t.currentSubagentSessionId).toBeUndefined();
    model.updateSyncTask(t, { type: 'step', phase, updates: { status: 'running' } });
    model.finishSyncTask(t, { status: 'completed' }); expect(t.status).toBe('failed'); expect(t.completedAt).toBe(10);
  });
  it('does not accept success while publication remains pending', () => {
    const t = task();
    for (const step of t.steps.filter(s => s.phase !== 'publish')) model.updateSyncTask(t, { type: 'step', phase: step.phase, updates: { status: 'completed' } });
    t.publishState = 'state_committed';
    model.finishSyncTask(t, { status: 'completed' });
    expect(t.status).toBe('failed'); expect(t.steps.at(-1).status).toBe('failed'); expect(model.hasPublishedDocument(t)).toBe(true);
  });
  it('preserves completed work but closes running and queued chunks after cancellation', () => {
    const t = task(); t.steps[0].status = 'completed'; t.steps[1].status = 'running';
    model.updateSyncTask(t, { type: 'chunk', phase: 'code_analysis', chunkIndex: 0, updates: { status: 'completed' } });
    model.updateSyncTask(t, { type: 'chunk', phase: 'code_analysis', chunkIndex: 1, updates: { status: 'queued' } });
    model.updateSyncTask(t, { type: 'cancel' }); expect(t.status).toBe('cancelling');
    model.finishSyncTask(t); expect(t.status).toBe('aborted'); expect(openUnits(t)).toHaveLength(0);
    expect(t.steps[1].chunks.map(c => c.status)).toEqual(['completed', 'aborted']);
  });
  it('persists concurrent chunk events before emitting snapshots and archives one terminal result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reqhub-lifecycle-')), t = task(), events = [];
    try {
      await setActiveSync(t, root); const lifecycle = new SyncLifecycle(t, e => events.push(e));
      await lifecycle.step('code_analysis', { status: 'running', chunks: [{ index: 0, status: 'pending' }, { index: 1, status: 'pending' }] });
      await Promise.all([lifecycle.chunk('code_analysis', 0, { status: 'completed' }), lifecycle.chunk('code_analysis', 1, { status: 'running', sessionId: 'child' })]);
      const disk = JSON.parse(await readFile(join(root, 'sync-logs/v2/.sync-state.json'), 'utf8'));
      expect(disk.activeSync.steps[1].chunks[1].sessionId).toBe('child');
      await lifecycle.finish({ status: 'failed', error: 'failed chunk', phase: 'code_analysis' });
      await lifecycle.step('code_analysis', { status: 'running' });
      await updateSyncProgress(t.id, { status: 'running' }, t.workspaceId, t.requirementId);
      expect(await getActiveSync(t.workspaceId, t.requirementId)).toBeNull();
      const history = await getSyncHistory(t.workspaceId, t.requirementId);
      expect(history).toHaveLength(1); expect(history[0].status).toBe('failed'); expect(openUnits(history[0])).toHaveLength(0);
      expect(events.at(-1).sync.status).toBe('failed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains the reservation while cancelling and only releases it after finish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reqhub-cancel-')), t = task(), controller = new AbortController();
    try {
      await setActiveSync(t, root); setAbortController(t.workspaceId, t.requirementId, controller, t.id);
      expect((await abortSync(t.id, t.workspaceId, t.requirementId)).status).toBe('cancelling');
      expect((await getActiveSync(t.workspaceId, t.requirementId)).status).toBe('cancelling');
      await new SyncLifecycle(t).finish();
      expect((await getSyncHistory(t.workspaceId, t.requirementId))[0].status).toBe('aborted');
      expect(controller.signal.aborted).toBe(true);
    } finally { deleteAbortController(t.workspaceId, t.requirementId); await rm(root, { recursive: true, force: true }); }
  });
  it('repairs archived running records and closes the unfinished steps of an old failure', () => {
    const t = task(); t.steps[0].status = 'running';
    model.repairSyncTask(t); expect(t.status).toBe('failed'); expect(openUnits(t)).toHaveLength(0); expect(t.completedAt).toBeDefined();
    const old = task(); old.status = 'failed'; old.error = 'old failure'; old.completedAt = 123;
    model.repairSyncTask(old); expect(old.completedAt).toBe(123); expect(openUnits(old)).toHaveLength(0);
  });
});
