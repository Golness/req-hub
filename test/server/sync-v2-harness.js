import { delegationContext, bindOwnedSession } from '../../src/server/delegation-context.js';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** In-process DSH contract double: tools remain scoped and all model work is deterministic. */
export function createSyncHarness({ noChange = false, skipCoverage = false, oversize = false, onStart } = {}) {
  const definitions = new Map(), hooks = new Map(), guards = [], requests = [], calls = [];
  definitions.set('str_replace_editor', { async execute(args) {
    const text = await readFile(args.path, 'utf8');
    if (args.command === 'insert' && text === '') return writeFile(args.path, args.new_str);
    if (!args.old_str || text.indexOf(args.old_str) < 0 || text.indexOf(args.old_str) !== text.lastIndexOf(args.old_str)) throw new Error('NATIVE_EDIT_AMBIGUOUS');
    await writeFile(args.path, text.replace(args.old_str, args.new_str));
  } });
  const ctx = {
    on(name, listener) { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(listener); return () => {}; },
    tools: { get: name => definitions.get(name), register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name); }, guard(fn) { guards.push(fn); return () => {}; } },
    subagents: { getProvider: () => ({ inheritsParentContext: false, capabilities: { toolFilter: true, agentOptions: true } }),
      async start(provider, request) {
        requests.push(request); onStart?.(request);
        const id = randomUUID(), signal = request.signal || new AbortController().signal, agent = { session: { id } };
        // Model the Host publishing its child before the first LLM request.
        const runtime = delegationContext.getStore(); if (runtime) bindOwnedSession(runtime, id);
        const invoke = async (name, args) => {
          const exec = { agent, signal, name, arguments: args };
          for (const guard of guards) { const denied = guard(exec); if (denied) throw new Error(denied); }
          calls.push({ name, args });
          return definitions.get(name).execute(args, exec);
        };
        const result = (async () => {
          const payload = { sessionId: id, messages: [{ role: 'user', content: request.prompt }], tools: request.toolFilter.allow.map(name => ({ name })) };
          for (const hook of hooks.get('llm/stream') || []) for await (const _ of hook(payload, async function* () {})) {}
          const read = async artifactId => {
            let offset = 0, text = '', sha256;
            do { const page = await invoke('req_hub_sync_read', { artifactId, offset, limit: 8000 }); text += page.text; offset = page.nextOffset; sha256 = page.sha256; if (page.eof) return { text, sha256 }; } while (true);
          };
          const manifestId = JSON.stringify(request.prompt).match(/manifest\.[a-z0-9-]+/)?.[0];
          const manifest = JSON.parse((await read(manifestId)).text);
          const values = {};
          if (!skipCoverage) for (const artifactId of manifest.required) values[artifactId] = (await read(artifactId)).text;
          if (manifest.candidateId) {
            const plan = JSON.parse(values['validated.plan']);
            for (const change of plan.changes) {
              const candidate = await read('candidate');
              await invoke('req_hub_sync_edit', { blockId: change.blockId, expectedHash: candidate.sha256,
                oldText: candidate.text.includes('旧规则') ? '旧规则' : '', newText: change.proposal });
            }
          } else {
            const blocks = JSON.parse(values['document.blocks'] || '[]');
            const indices = Object.entries(values).filter(([key]) => key.endsWith('.changes')).map(([, value]) => JSON.parse(value));
            let changes = [];
            if (indices.length) {
              const map=new Map();
              for(const change of indices.flatMap(index=>index.changes)) {
                const key=change.blockId+change.proposal;
                if(map.has(key)) { const old=map.get(key); old.sourceIds=[...(old.sourceIds||[old.id]),change.id,...(change.sourceIds||[])]; old.evidenceRefs=[...new Set([...old.evidenceRefs,...change.evidenceRefs])]; }
                else map.set(key,{...change});
              }
              changes=[...map.values()];
            }
            else if (!noChange) changes = [{ id: 'c1', action: blocks[0]?.type === 'empty' ? 'add' : 'modify', blockId: blocks.find(block => block.type === 'paragraph' || block.type === 'empty')?.id,
              reason: 'confirmed source rule', proposal: blocks[0]?.type === 'empty' ? '# 标题\n\n新规则\n' : '新规则', evidenceRefs: manifest.required.filter(id => /^(code\.|session\.)/.test(id)).slice(0, 1) }];
            await invoke('req_hub_sync_write', { outputId: 'report', content: oversize ? 'x'.repeat(13000) : '专业分析：已确认规则的最小变更。' });
            await invoke('req_hub_sync_write', { outputId: 'changes', content: JSON.stringify({ changes, pending: [] }) });
          }
          return { stopReason: 'completed', output: [{ type: 'text', text: '已完成' }] };
        })();
        return { id, result, dispose: async () => {} };
      }, interrupt() {} },
    skills: { load: async () => '', get: async () => null },
  };
  const parentAgent = { status: 'running', session: { id: 'parent' } };
  return { ctx, parentAgent, requests, calls, hooks, definitions, guards };
}
