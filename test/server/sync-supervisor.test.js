import { it, expect, vi } from 'vitest';
import { SyncSupervisor } from '../../src/server/sync-supervisor.js';
import model from '../../src/shared/sync-task.cjs';

function setup() {
  let now = 0;
  const supervisor = new SyncSupervisor({now:()=>now,limits:{preparing:10,idle:100,total:1000,cancelling:20}});
  const owner=supervisor.acquire({workspaceId:'one',requirementId:'r',docType:'requirement'});
  const task={id:'same',snapshotDir:'attempt-one',status:'running',steps:model.createSyncSteps(),startedAt:0};
  const recover=vi.fn(reason=>model.finishSyncTask(task,{status:'failed',error:reason,now}));
  return {supervisor,owner,task,recover,advance:value=>{now=value;}};
}
it('shares one execution lease across document types and workspaces',()=>{
  const {supervisor,owner}=setup();
  expect(supervisor.acquire({docType:'design',workspaceId:'two'})).toBeNull();
  supervisor.release(owner);expect(supervisor.acquire({docType:'design'})).not.toBeNull();
});
it('removes execution ownership even when the termination method fails and never restores its notice',()=>{
 const {supervisor,owner,task,recover}=setup();supervisor.attach(owner,task,recover);
 owner.controller.abort=()=>{throw Error('host stop failed');};owner.revoke=vi.fn();
 supervisor.remove(task);
 expect(owner.revoke).toHaveBeenCalledOnce();expect(supervisor.owner).toBeNull();
 supervisor.release(owner);supervisor.remember(task);expect(supervisor.snapshot().latest).toBeNull();
 expect(supervisor.acquire({docType:'design'})).not.toBeNull();
});
it('recovers stalled work without polling extending the lease, fences late callbacks and retains a terminal notice',async()=>{
  const {supervisor,owner,task,recover,advance}=setup();supervisor.attach(owner,task,recover);
  advance(90);supervisor.snapshot();expect(await supervisor.check()).toBe(false);
  advance(100);expect(await supervisor.check()).toBe(true);
  expect(owner.controller.signal.aborted).toBe(true);expect(recover).toHaveBeenCalledOnce();
  expect(supervisor.snapshot()).toMatchObject({active:null,latest:{status:'failed'}});
  expect(task.steps.every(step=>!['pending','running'].includes(step.status))).toBe(true);
  const next=supervisor.acquire({docType:'design'});supervisor.release(owner);expect(supervisor.owner).toBe(next);
  expect(()=>supervisor.assert(owner)).toThrow();
});
it('accepts real work activity but still applies an absolute deadline',async()=>{
  const {supervisor,owner,task,recover,advance}=setup();supervisor.attach(owner,task,recover);
  advance(90);supervisor.touch(owner);advance(110);expect(await supervisor.check()).toBe(false);
  advance(1000);supervisor.touch(owner);expect(await supervisor.check()).toBe(true);expect(task.error).toContain('TOTAL_TIMEOUT');
});
it('reclaims cancellation and preparation hangs with explicit terminal notifications',async()=>{
  const {supervisor,owner,task,recover,advance}=setup();supervisor.attach(owner,task,recover);
  owner.controller.abort();advance(20);expect(await supervisor.check()).toBe(true);expect(task.error).toContain('CANCEL_TIMEOUT');
  const pending=supervisor.acquire({docType:'design'});advance(30);await supervisor.check();
  expect(pending.controller.signal.aborted).toBe(true);expect(supervisor.snapshot().latest).toMatchObject({docType:'design',status:'failed'});
});
it('does not release the lease while the recovery writer is still settling',async()=>{
  const {supervisor,owner,task,advance}=setup();let release;
  supervisor.attach(owner,task,()=>new Promise(resolve=>{release=()=>{model.finishSyncTask(task,{status:'failed'});resolve();};}));
  advance(100);const recovery=supervisor.check();supervisor.release(owner);
  expect(supervisor.acquire({docType:'design'})).toBeNull();release();await recovery;
  expect(supervisor.acquire({docType:'design'})).not.toBeNull();
});
it('repairs unfamiliar nonterminal task, step and chunk statuses instead of leaving them stuck',()=>{
  const task={status:'processing',completedAt:1,steps:[{phase:'code_analysis',status:'waiting',chunks:[{status:'starting'}]}]};
  model.repairSyncTask(task);
  expect(task.status).toBe('failed');expect(task.steps[0].status).toBe('skipped');expect(task.steps[0].chunks[0].status).toBe('failed');
});
