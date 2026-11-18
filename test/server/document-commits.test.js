import { expect, it, vi } from 'vitest';
import { notifyDocumentCommit } from '../../src/server/document-commits.js';

it('registers Feishu without waiting for reporting to finish or become available', async () => {
  let release;
  const dailyReports = {
    committed: vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
  };
  const documents = { committed: vi.fn(async () => ({ status: 'queued' })) };
  expect(
    await notifyDocumentCommit({ documents, dailyReports }, 'ws', 'requirement.md', 'sync'),
  ).toEqual({ status: 'queued' });
  expect(documents.committed).toHaveBeenCalledWith('ws', 'requirement.md', 'sync');
  expect(dailyReports.committed).toHaveBeenCalledWith('ws', 'requirement.md', 'sync');
  release();
});

it('isolates a failed reporting reader from Feishu registration', async () => {
  const dailyReports = {
    committed: vi.fn(async () => {
      throw new Error('reader unavailable');
    }),
  };
  const documents = { committed: vi.fn(async () => ({ status: 'queued' })) };
  expect(
    await notifyDocumentCommit({ documents, dailyReports }, 'ws', 'file.md', 'writing'),
  ).toEqual({ status: 'queued' });
});

it('registers reporting when Feishu is disabled, fails, or remains busy', async () => {
  const dailyReports = { committed: vi.fn(async () => {}) };
  const documents = { committed: vi.fn(async () => ({ status: 'disabled' })) };
  expect(await notifyDocumentCommit({ documents, dailyReports }, 'ws', 'one.md', 'docs')).toEqual({
    status: 'disabled',
  });
  documents.committed.mockRejectedValueOnce(new Error('remote unavailable'));
  expect(await notifyDocumentCommit({ documents, dailyReports }, 'ws', 'two.md', 'docs')).toEqual({
    status: 'failed',
    error: 'DOCUMENT_REGISTER_FAILED',
  });
  let release;
  documents.committed.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = notifyDocumentCommit(
    { documents, dailyReports },
    'ws',
    'three.md',
    'conversation',
  );
  await vi.waitFor(() =>
    expect(dailyReports.committed).toHaveBeenCalledWith('ws', 'three.md', 'conversation'),
  );
  release({ status: 'queued' });
  await pending;
});
