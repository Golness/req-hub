import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSyncCapabilities, installSyncTools, SYNC_TOOLS } from '../../src/server/sync-controlled-tools.js';
import { PhasedSyncEngine } from '../../src/server/phased-sync-engine.js';
import { createSyncHarness } from './sync-v2-harness.js';

// Match the host registry: native tools live in the parent scope, not globally,
// and the child's filtered view does not advertise those file tools.
function scopedHarness() {
  const h = createSyncHarness(), native = h.definitions.get('str_replace_editor');
  h.definitions.delete('str_replace_editor');
  const observed = new Map(), calls = [];
  const remember = async (args, exec) => {
    const text = await readFile(args.file_path, 'utf8');
    observed.set(exec.agent.session.id, text); calls.push({ name: 'read', args, exec }); return text;
  };
  const edit = vi.fn(async (args, exec) => {
    expect(observed.get(exec.agent.session.id)).toBe(await readFile(args.file_path, 'utf8'));
    expect(args.replace_all).toBe(false); calls.push({ name: 'edit', args, exec });
    return native.execute({ command: 'str_replace', path: args.file_path, old_str: args.old_string, new_str: args.new_string }, exec);
  });
  const write = vi.fn(async (args, exec) => {
    expect(observed.get(exec.agent.session.id)).toBe(''); calls.push({ name: 'write', args, exec });
    await writeFile(args.file_path, args.content);
  });
  const tools = new Map([['read', { execute: remember }], ['edit', { execute: edit }], ['write', { execute: write }]]);
  h.ctx.tools.get = (name, scope) => scope === h.parentAgent ? tools.get(name) : h.definitions.get(name);
  return { ...h, native, nativeCalls: calls, edit, write, tools };
}

describe('host native editor capability compatibility', () => {
  it('resolves the native editor from the active parent agent scope', () => {
    const h = createSyncHarness(), native = h.definitions.get('str_replace_editor');
    h.ctx.tools.get = (_name, agent) => agent === h.parentAgent ? native : undefined;
    expect(() => assertSyncCapabilities(h.ctx)).toThrow('当前会话缺少原生文件工具');
    expect(assertSyncCapabilities(h.ctx, {}, h.parentAgent).kind).toBe('str_replace_editor');
  });
  it.each(['existing', 'empty'])('completes %s document sync using scoped native read/edit/write', async mode => {
    const h = scopedHarness(), root = await mkdtemp(join(tmpdir(), 'reqhub-native-editor-'));
    try {
      expect(assertSyncCapabilities(h.ctx, {}, h.parentAgent).kind).toBe('edit');
      const engine = new PhasedSyncEngine({ ...h, config: {}, cwd: root });
      const result = await engine.sync({ docType: 'requirement', syncDir: root,
        currentDoc: mode === 'empty' ? '' : '# 标题\n\n旧规则\n',
        codeDiff: 'diff --git a/src/rule.js b/src/rule.js\n--- a/src/rule.js\n+++ b/src/rule.js\n@@ -1 +1 @@\n-old\n+new', sessionTurns: [], commits: [] });
      expect(result.errors).toEqual([]);
      expect(result.mergedDoc).toContain('新规则');
      expect(mode === 'empty' ? h.write : h.edit).toHaveBeenCalledTimes(1);
      expect(h.nativeCalls.map(call => call.name)).toEqual(['read', mode === 'empty' ? 'write' : 'edit']);
      for (const request of h.requests) expect(request.toolFilter.allow).toEqual(SYNC_TOOLS);
      for (const call of h.nativeCalls) expect(call.args.file_path).toContain(root);
    } finally { installSyncTools(h.ctx).dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it('rejects non-isolated or inherited-context providers with the exact missing capability', () => {
    const h = createSyncHarness();
    h.ctx.subagents.getProvider = () => ({ capabilities: { toolFilter: false }, inheritsParentContext: true });
    expect(() => assertSyncCapabilities(h.ctx)).toThrow('不支持工具隔离 toolFilter');
    expect(() => assertSyncCapabilities(h.ctx)).toThrow('未声明零父上下文');
    expect(h.requests).toHaveLength(0);
  });
  it('rolls back native edit output that changes content outside the authorized block', async () => {
    const h = scopedHarness(), root = await mkdtemp(join(tmpdir(), 'reqhub-native-rollback-'));
    const original = '# 标题\n\n旧规则\n\n## 其他\n必须保留\n';
    h.tools.set('edit', { execute: async (args, exec) => {
      await h.edit(args, exec);
      await writeFile(args.file_path, (await readFile(args.file_path, 'utf8')).replace('必须保留', '越界修改'));
    } });
    try {
      const engine = new PhasedSyncEngine({ ...h, config: {}, cwd: root });
      const result = await engine.sync({ docType: 'requirement', syncDir: root, currentDoc: original,
        codeDiff: 'diff --git a/src/rule.js b/src/rule.js\n--- a/src/rule.js\n+++ b/src/rule.js\n@@ -1 +1 @@\n-old\n+new', sessionTurns: [], commits: [] });
      expect(result.errors.length).toBeGreaterThan(0); expect(result.mergedDoc).toBeNull();
      const candidate = h.nativeCalls.find(call => call.name === 'edit').args.file_path;
      expect(await readFile(candidate, 'utf8')).toBe(original);
    } finally { installSyncTools(h.ctx).dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it('reports missing providers, host guards and native read support instead of claiming all capabilities are missing', () => {
    const h = scopedHarness(); h.tools.delete('read');
    expect(() => assertSyncCapabilities(h.ctx, {}, h.parentAgent)).toThrow('read + edit + write');
    h.ctx.subagents.getProvider = () => null;
    expect(() => assertSyncCapabilities(h.ctx, { ai: { delegation: { provider: 'custom' } } }, h.parentAgent)).toThrow('provider「custom」未注册');
    h.ctx.tools.guard = undefined;
    expect(() => assertSyncCapabilities(h.ctx, {}, h.parentAgent)).toThrow('tools.guard');
  });
});
