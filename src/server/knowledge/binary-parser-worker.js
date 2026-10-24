import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseDocument } from 'htmlparser2';
import yauzl from 'yauzl';

const { limits, extension } = workerData;
const bytes = Buffer.from(workerData.bytes);
const require = createRequire(import.meta.url);

function collector() {
  const chunks = [], locations = []; let size = 0, line = 1;
  return {
    add(text, location) {
      text = text.replaceAll('\u0000', '').trim();
      if (!text) return;
      size += text.length + 2;
      if (size > limits.characters) throw new Error('提取正文超过 200 万字符，请拆分文件');
      const startLine = line; line += text.split('\n').length + 1;
      chunks.push(text); locations.push({ ...location, startLine, endLine: line - 2 });
    },
    result() { return { text: chunks.join('\n\n'), coordinate: 'extracted', locations }; },
  };
}

// Bound Office ZIP expansion before handing it to an in-memory document parser.
async function checkOfficeArchive() {
  await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(new Error('Office 文件无效、已加密或已损坏'));
    let total = 0, count = 0, main = false, done = false;
    const fail = message => { if (!done) { done = true; zip.close(); reject(new Error(message)); } };
    zip.on('error', () => fail('Office 压缩包损坏'));
    zip.on('entry', entry => {
      total += entry.uncompressedSize; count++;
      if (total > limits.zipBytes || count > limits.zipEntries) return fail('Office 解压内容过大，请拆分文件');
      if (entry.generalPurposeBitFlag & 1) return fail('暂不支持加密的 Office 文件');
      if (entry.fileName === (extension === '.docx' ? 'word/document.xml' : 'xl/workbook.xml')) main = true;
      zip.readEntry();
    });
    zip.on('end', () => { if (!done) { done = true; zip.close(); main ? resolve() : reject(new Error('文件内容与扩展名不符')); } });
    zip.readEntry();
  }));
}

async function pdf() {
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('PDF 文件无效或已损坏');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
    cMapUrl: join(root, 'cmaps') + '/', cMapPacked: true, standardFontDataUrl: join(root, 'standard_fonts') + '/', verbosity: 0 });
  let document;
  try {
    document = await task.promise;
    if (document.numPages > limits.pages) throw new Error('PDF 超过 500 页，请拆分文件');
    const output = collector(); let textPages = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber), content = await page.getTextContent();
      let text = '', previousY;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform?.[5];
        if (previousY !== undefined && y !== undefined && Math.abs(y - previousY) > 2 && !text.endsWith('\n')) text += '\n';
        text += item.str + (item.hasEOL ? '\n' : ' '); previousY = y;
      }
      if (text.trim()) { textPages++; output.add(`## 第 ${pageNumber} 页\n\n${text.trim()}`, { page: pageNumber }); }
      page.cleanup();
    }
    if (!textPages) throw new Error('PDF 未提取到文字，可能是扫描件，需要 OCR；当前仅支持文字型 PDF');
    const result = output.result();
    if (textPages !== document.numPages) result.warnings = [`${document.numPages - textPages} 页未提取到文字（空白页或扫描页），未执行 OCR`];
    return result;
  } catch (error) {
    if (error.name === 'PasswordException') throw new Error('PDF 已加密，请先解除密码后再分析');
    throw error;
  } finally { await task.destroy(); }
}

async function docx() {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.convertToHtml({ buffer: bytes }, { externalFileAccess: false,
    convertImage: mammoth.images.imgElement(async () => ({})) });
  const root = parseDocument(value), output = collector(); let paragraph = 0;
  const textOf = node => node.type === 'text' ? node.data : node.name === 'br' ? '\n' : (node.children || []).map(textOf).join('');
  const visit = node => {
    if (node.name === 'img') return;
    if (/^(p|h[1-6]|li|tr)$/.test(node.name || '')) {
      if (++paragraph > limits.blocks) throw new Error('Word 超过 10000 个段落或表格行，请拆分文件');
      const heading = /^h[1-6]$/.test(node.name);
      const text = node.name === 'tr' ? (node.children || []).filter(n => /^(td|th)$/.test(n.name)).map(textOf).join(' | ') : textOf(node);
      output.add(`${heading ? '#'.repeat(Number(node.name[1])) + ' ' : node.name === 'li' ? '- ' : ''}${text}`, { paragraph });
      return;
    }
    for (const child of node.children || []) visit(child);
  };
  visit(root); return output.result();
}

async function xlsx() {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  if (workbook.worksheets.length > limits.sheets) throw new Error('Excel 超过 50 个工作表，请拆分文件');
  const output = collector(); let count = 0;
  for (const sheet of workbook.worksheets) {
    let started = false;
    sheet.eachRow(row => {
      const values = []; let first, last;
      row.eachCell(cell => {
        if (++count > limits.cells) throw new Error('Excel 超过 100000 个非空单元格，请拆分文件');
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const value = cell.value;
        const display = value instanceof Date ? value.toISOString() : cell.text;
        const formula = cell.formula ? ` [公式：${cell.formula}${cell.result === undefined ? '；无缓存结果，未计算' : ''}]` : '';
        values.push(`${cell.address}: ${display}${formula}`); first ??= cell.address; last = cell.address;
      });
      if (values.length) {
        if (!started) { output.add(`## 工作表：${sheet.name}`, { sheet: sheet.name }); started = true; }
        output.add(values.join(' | '), { sheet: sheet.name, range: first === last ? first : `${first}:${last}` });
      }
    });
  }
  return output.result();
}

try {
  if (extension !== '.pdf') await checkOfficeArchive();
  const result = await ({ '.pdf': pdf, '.docx': docx, '.xlsx': xlsx }[extension])();
  parentPort.postMessage({ result });
} catch (error) { parentPort.postMessage({ error: error.message || '文档解析失败' }); }
