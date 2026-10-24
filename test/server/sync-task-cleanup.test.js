import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planSyncTaskCleanup } from '../../src/server/sync-task-cleanup.js';

it('limits cleanup to captured execution folders and preserves a concurrently created retry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reqhub-delete-')),old='11111111-1111-1111-1111-111111111111',next='22222222-2222-2222-2222-222222222222';
 try {
  const parent=join(root,'sync-logs/v2/task');await mkdir(join(parent,old),{recursive:true});await writeFile(join(parent,old,'input.md'),'old');
  await writeFile(join(root,'requirement.md'),'FINAL');
  const cleanup=await planSyncTaskCleanup(root,{id:'task',snapshotDir:'v2/task/'+old});
  await mkdir(join(parent,next));await writeFile(join(parent,next,'input.md'),'NEW');await cleanup();await cleanup();
  await expect(access(join(parent,old))).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile(join(parent,next,'input.md'),'utf8')).toBe('NEW');expect(await readFile(join(root,'requirement.md'),'utf8')).toBe('FINAL');
 } finally {await rm(root,{recursive:true,force:true});}
});
it('rejects escaped paths and symlinked task parents without touching source documents',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reqhub-delete-boundary-'));
 try {
  await writeFile(join(root,'source.md'),'SOURCE');await mkdir(join(root,'sync-logs/v2'),{recursive:true});
  await expect(planSyncTaskCleanup(root,{id:'task',snapshotDir:'../../source.md'})).rejects.toThrow('PATH_INVALID');
  await symlink(root,join(root,'sync-logs/v2/task'),'junction');
  await expect(planSyncTaskCleanup(root,{id:'task',snapshotDir:'v2/task/11111111-1111-1111-1111-111111111111'})).rejects.toThrow('SYMLINK');
  expect(await readFile(join(root,'source.md'),'utf8')).toBe('SOURCE');
 } finally {await rm(root,{recursive:true,force:true});}
});
