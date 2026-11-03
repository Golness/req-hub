import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  freezeDesignReference,
  listDesignReferences,
  publishedRequirementReference,
} from '../../src/server/sync-design-reference.js';

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'req-hub-design-reference-'));
  await mkdir(join(root, 'requirement', 'attachments'), { recursive: true });
  await mkdir(join(root, 'other'));
  await writeFile(join(root, 'requirement', 'requirement.md'), '# Business rules');
  await writeFile(join(root, 'requirement', 'attachments', 'rules.csv'), 'rule,value\none,2');
  await writeFile(join(root, 'other', 'secret.md'), 'OTHER_REQUIREMENT');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('lists all regular files, supports path filtering and never traverses links', async () => {
  const directory = join(root, 'requirement');
  await symlink(join(root, 'other'), join(directory, 'linked'), 'junction');
  expect(await listDesignReferences(directory)).toEqual([
    'attachments/rules.csv',
    'requirement.md',
  ]);
  expect(await listDesignReferences(directory, 'RULE')).toEqual(['attachments/rules.csv']);
  await expect(freezeDesignReference(directory, 'linked/secret.md')).rejects.toThrow(
    'SYNC_REFERENCE_INVALID',
  );
});

it.each(['../other/secret.md', 'C:\\secret.md', '/secret.md', 'missing.md', 'attachments'])(
  'rejects a forged or missing file selection: %s',
  async (path) => {
    await expect(freezeDesignReference(join(root, 'requirement'), path)).rejects.toThrow(
      'SYNC_REFERENCE_INVALID',
    );
  },
);

it('freezes complete text, tracks content changes and ignores live edits to published bytes', async () => {
  const directory = join(root, 'requirement');
  const first = await freezeDesignReference(directory, 'requirement.md');
  await writeFile(join(directory, 'requirement.md'), '# Changed business rules');
  const second = await freezeDesignReference(directory, 'requirement.md');
  expect(first.text).toBe('# Business rules');
  expect(second.sourceHash).not.toBe(first.sourceHash);
  const published = publishedRequirementReference(Buffer.from(first.text), 'requirement-attempt');
  expect(published).toMatchObject({ ...first, syncId: 'requirement-attempt' });
});

it('rejects unsupported binary data, excessive size and cancelled reads', async () => {
  const directory = join(root, 'requirement');
  await writeFile(join(directory, 'image.png'), Buffer.from([0, 255, 0]));
  await expect(freezeDesignReference(directory, 'image.png')).rejects.toThrow(
    'SYNC_REFERENCE_UNSUPPORTED',
  );
  await writeFile(join(directory, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
  await expect(freezeDesignReference(directory, 'large.txt')).rejects.toThrow(
    'SYNC_REFERENCE_TOO_LARGE',
  );
  const controller = new AbortController();
  controller.abort(new Error('CANCELLED'));
  await expect(
    freezeDesignReference(directory, 'requirement.md', controller.signal),
  ).rejects.toThrow('CANCELLED');
});
