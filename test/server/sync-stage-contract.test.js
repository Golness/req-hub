import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindOwnedSession } from '../../src/server/delegation-context.js';
import { PROMPT_REGISTRY } from '../../src/server/prompts.js';
import { SyncArtifacts } from '../../src/server/sync-artifacts.js';
import { installSyncTools } from '../../src/server/sync-controlled-tools.js';
import { indexDocument } from '../../src/server/sync-document-validator.js';
import { PhasedSyncEngine } from '../../src/server/phased-sync-engine.js';
import { createSyncHarness } from './sync-v2-harness.js';

describe('sync stage contracts', () => {
  it.each(['requirement', 'design'])(
    'keeps analysis output requirements out of the %s editing prompt',
    (docType) => {
      const edit = PROMPT_REGISTRY[`phased-merge-${docType}`].default;
      expect(edit).toContain('There are no analysis outputIds');
      expect(edit).toContain('Successful req_hub_sync_edit receipts');
      expect(edit).not.toContain('Only written=true');
      expect(edit).not.toContain('Keep each output within limitBytes');
      for (const source of [
        'code-analysis',
        'discussion-analysis',
        'code-analysis-merge',
        'discussion-analysis-merge',
      ]) {
        const key = `phased-${source}-${docType}`;
        expect(PROMPT_REGISTRY[key].default).toContain('Only written=true');
      }
    },
  );

  it('denies cross-stage tools and steers editing by receipts without requesting analysis output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'req-hub-stage-contract-'));
    const h = createSyncHarness();
    const installation = installSyncTools(h.ctx);
    try {
      const store = await new SyncArtifacts(join(root, 'input')).init();
      await store.put('plan', 'frozen plan');
      const originalBytes = Buffer.from('# Title\n\nOld rule\n');
      const blocks = indexDocument(originalBytes);
      const blockId = blocks.find((block) => block.type === 'paragraph').id;
      const candidatePath = join(root, 'candidate.md');
      await writeFile(candidatePath, originalBytes);
      const edit = installation.create({
        store,
        allowed: ['plan'],
        required: ['plan'],
        outputs: {},
        candidatePath,
        originalBytes,
        fileName: 'requirement.md',
        changes: [{ blockId }],
        blocks,
      });
      const analysis = installation.create({
        store,
        allowed: [],
        required: [],
        outputs: { report: join(root, 'report.md') },
      });
      bindOwnedSession(edit, edit.id);
      bindOwnedSession(analysis, analysis.id);
      const signal = new AbortController().signal;
      const exec = (runtime, name, parent) => ({
        name,
        parent,
        signal,
        agent: { session: { id: runtime.id } },
      });
      for (const parent of [undefined, Symbol('run_code')]) {
        for (const [runtime, name] of [
          [edit, 'req_hub_sync_write'],
          [analysis, 'req_hub_sync_edit'],
        ]) {
          expect(h.guards.some((guard) => guard(exec(runtime, name, parent)))).toBe(true);
        }
      }
      expect(h.guards.every((guard) => !guard(exec(edit, 'req_hub_sync_edit')))).toBe(true);
      expect(h.guards.every((guard) => !guard(exec(analysis, 'req_hub_sync_write')))).toBe(true);
      expect(h.guards.every((guard) => !guard(exec({ id: 'foreign' }, 'other')))).toBe(true);
      await expect(edit.write({ outputId: 'changes', content: {} })).rejects.toThrow(
        'This stage has no analysis outputIds',
      );
      await expect(analysis.edit({})).rejects.toThrow('SYNC_STAGE_TOOL_DENIED');
      expect(edit.invalidOutputWrites).toBe(0);
      expect(edit.outputFailure).toBeUndefined();
      const messages = [];
      const agent = { session: { id: edit.id }, steer: (message) => messages.push(message) };
      const stop = async () => {
        for (const hook of h.hooks.get('agent/turn-stopping')) {
          await hook({ agent, signal });
        }
      };
      await stop();
      expect(messages[0].content[0].text).toContain('"remaining":1');
      expect(messages[0].content[0].text).not.toContain('then write every missing output');
      await edit.read({ artifactId: 'plan' });
      await stop();
      expect(messages[1].content[0].text).toContain(
        JSON.stringify({ missingEditBlockIds: [blockId] }).slice(1, -1),
      );
      const candidate = await edit.read({ artifactId: 'candidate' });
      await h.definitions.get('req_hub_sync_edit').execute(
        {
          blockId,
          expectedHash: candidate.sha256,
          oldText: 'Old rule',
          newText: 'New rule',
        },
        exec(edit, 'req_hub_sync_edit'),
      );
      await stop();
      expect(messages).toHaveLength(2);
      expect(await readFile(candidatePath, 'utf8')).toContain('New rule');
      expect(edit.outputWritten.size).toBe(0);
    } finally {
      installation.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['requirement', 'design'])(
    'completes an empty %s candidate with no analysis outputs in the edit stage',
    async (docType) => {
      const root = await mkdtemp(join(tmpdir(), 'req-hub-stage-empty-'));
      const h = createSyncHarness();
      try {
        const engine = new PhasedSyncEngine({ ...h, config: {}, cwd: root });
        const result = await engine.sync({
          docType,
          currentDoc: '',
          codeDiff:
            'diff --git a/rule.js b/rule.js\n--- a/rule.js\n+++ b/rule.js\n@@ -1 +1 @@\n-old\n+new',
          syncDir: root,
        });
        expect(result.errors).toEqual([]);
        expect(result.mergedDoc).toContain('新规则');
        expect(h.requests.at(-1).toolFilter.allow).toEqual([
          'req_hub_sync_read',
          'req_hub_sync_edit',
        ]);
        const metadata = JSON.parse(await readFile(join(root, 'input', 'manifest.json'), 'utf8'));
        const artifact = metadata.artifacts.find((entry) => entry.id === 'manifest.edit');
        const manifest = JSON.parse(await readFile(join(root, 'input', artifact.file), 'utf8'));
        expect(manifest.outputIds).toEqual([]);
        const state = JSON.parse(await readFile(join(root, 'edit.read-state.json'), 'utf8'));
        expect(state.outputsWritten).toEqual([]);
        expect(state.invalidOutputWrites).toBe(0);
      } finally {
        installSyncTools(h.ctx).dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
