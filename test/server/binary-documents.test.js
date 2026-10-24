import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { pdf, docx, zip } from './document-fixtures.js';
import { readSource } from '../../src/server/knowledge/source-reader.js';
import { parseBinary } from '../../src/server/knowledge/binary-parser.js';
import { KnowledgeService } from '../../src/server/knowledge/build-service.js';
vi.mock('../../src/server/config.js', () => ({ loadConfig: async () => ({ docsDir: 'docs' }) }));
const { createTreeRoutes } = await import('../../src/server/routes/tree-routes.js');
let root, docs, service;
const prefix = 'alice/2026-10-23-orders';
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'reqhub-binary-')); docs = join(root, 'docs'); await mkdir(join(docs, prefix), { recursive: true }); });
afterEach(async () => { await service?.close(); service = null; await rm(root, { recursive: true, force: true }); });
async function source(name, bytes, options) { const path = `${prefix}/${name}`; await writeFile(join(docs, path), bytes); return readSource(docs, path, options); }
async function workbook() {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('订单');
  sheet.addRow(['状态', '数量', '金额']); sheet.addRow(['已审核', 2, { formula: 'B2*10', result: 20 }]);
  sheet.getCell('D2').value = { richText: [{ text: '富文本备注' }] };
  sheet.getCell('E2').value = { formula: 'B2*20' };
  const other = book.addWorksheet('边界条件'); other.getCell('B3').value = 'unique_excel_tail';
  return Buffer.from(await book.xlsx.writeBuffer());
}
it('extracts PDF pages and rejects scans, damaged files and excessive page counts', async () => {
  const result = await source('rules.PDF', pdf());
  expect(result.text).toContain('unique_pdf_tail'); expect(result.locations.map(l => l.page)).toEqual([1, 2]);
  await expect(source('scan.pdf', pdf(['']))).rejects.toThrow('需要 OCR');
  await expect(source('bad.pdf', Buffer.from('not a PDF'))).rejects.toThrow('PDF 文件无效');
  await expect(source('long.pdf', pdf(Array(501).fill('rule')))).rejects.toThrow('500 页');
  const mixed = await source('mixed.pdf', pdf(['', 'Approval'])); expect(mixed.warnings[0]).toContain('1 页');
}, 15000);
it('extracts Chinese Word headings, paragraphs and table cells with paragraph provenance', async () => {
  const result = await source('rules.docx', docx());
  expect(result.text).toContain('# 订单规则'); expect(result.text).toContain('审核通过后发货'); expect(result.text).toContain('状态 | 已审核');
  expect(result.locations.map(l => l.paragraph)).toEqual([1, 2, 3]);
  await expect(source('bad.docx', Buffer.from('invalid'))).rejects.toThrow('Office 文件无效');
  await expect(source('wrong.docx', zip({ 'xl/workbook.xml': '<test/>' }))).rejects.toThrow('扩展名不符');
});
it('extracts sheets, cell addresses, rich text and cached formulas without calculating them', async () => {
  const result = await source('rules.xlsx', await workbook());
  expect(result.text).toContain('C2: 20 [公式：B2*10]'); expect(result.text).toContain('富文本备注'); expect(result.text).toContain('无缓存结果，未计算');
  expect(result.locations).toContainEqual(expect.objectContaining({ sheet: '边界条件', range: 'B3' }));
  expect(result.text).toContain('unique_excel_tail');
  const empty = new ExcelJS.Workbook(); empty.addWorksheet('空表');
  expect((await source('empty.xlsx', Buffer.from(await empty.xlsx.writeBuffer()))).text).toBe('');
});
it('bounds file size, Office expansion, extraction time and cancellation', async () => {
  await expect(source('large.pdf', Buffer.alloc(20 * 1024 * 1024 + 1))).rejects.toMatchObject({ status: 413 });
  const oversized = zip({ 'word/document.xml': 'small' });
  const directory = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); oversized.writeUInt32LE(41 * 1024 * 1024, directory + 24);
  await expect(source('large.docx', oversized)).rejects.toThrow('解压内容过大');
  await expect(parseBinary(pdf(), '.pdf', { timeoutMs: 1 })).rejects.toThrow('解析超过');
  const controller = new AbortController(); const task = parseBinary(pdf(), '.pdf', { signal: controller.signal }); controller.abort(new Error('测试取消'));
  await expect(task).rejects.toThrow('测试取消');
  await expect(source('old.doc', docx())).rejects.toThrow('不支持');
});
it('builds, searches globally with exact locations and versions, and leaves source bytes unchanged', async () => {
  const files = [['rules.pdf', pdf()], ['rules.docx', docx()], ['rules.xlsx', await workbook()]];
  for (const [name, bytes] of files) await writeFile(join(docs, prefix, name), bytes);
  service = new KnowledgeService({ registry: { list: () => [{ id: 'ws', path: root, title: '测试工作区' }] }, configLoader: async () => ({ docsDir: 'docs' }), databasePath: join(root, 'kb/knowledge.sqlite') });
  const scope = await service.scope('ws'), input = key => ({ requestKey: key, files: files.map(([name]) => ({ relativePath: `${prefix}/${name}` })) });
  const { job } = await service.build(scope, input('first')); await Promise.all([...service.tasks]);
  expect(scope.store.job(job.id).files.map(f => f.status)).toEqual(['completed', 'completed', 'completed']);
  const hit = (await service.searchAll('unique_pdf_tail')).hits[0]; expect(hit.sources[0].locations[0].page).toBe(2);
  expect((await service.searchAll('unique_excel_tail')).hits[0].sources[0].locations[0]).toMatchObject({ sheet: '边界条件', range: 'B3' });
  expect((await service.searchAll('审核通过')).hits[0].sources[0].locations[0].paragraph).toBe(2);
  const { job: repeated } = await service.build(scope, input('repeat')); await Promise.all([...service.tasks]);
  expect(scope.store.job(repeated.id).files.every(f => f.status === 'skipped')).toBe(true);
  for (const [name, bytes] of files) expect(await readFile(join(docs, prefix, name))).toEqual(bytes);
  const changed = docx('<w:p><w:r><w:t>已取消订单不得发货</w:t></w:r></w:p>'); await writeFile(join(docs, prefix, 'rules.docx'), changed);
  await service.build(scope, { requestKey: 'changed', files: [{ relativePath: `${prefix}/rules.docx` }] }); await Promise.all([...service.tasks]);
  const updated = (await service.searchAll('不得发货')).hits[0]; expect(updated.version).toBe(2); expect(scope.store.entry(updated.id).versions).toHaveLength(2);
}, 20000);
it('lists binary files in the shared tree and previews extracted text through the real route', async () => {
  await source('rules.pdf', pdf()); await source('rules.docx', docx()); await source('rules.xlsx', await workbook());
  const routes = createTreeRoutes({ list: () => [{ id: 'ws', path: root }] });
  async function get(path) {
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await routes.find(route => route.path === path.split('?')[0]).handler({ method: 'GET', url: path }, res);
    return JSON.parse(res.end.mock.calls[0][0]);
  }
  const tree = await get('/req-hub/file-tree?workspaceId=ws&requirementId=2026-10-23-orders');
  expect(tree.tree.map(file => file.name).sort()).toEqual(['rules.docx', 'rules.pdf', 'rules.xlsx']);
  const preview = await get(`/req-hub/read?workspaceId=ws&path=${prefix}/rules.pdf`);
  expect(preview.text).toContain('unique_pdf_tail'); expect(preview.locations[1].page).toBe(2);
});
