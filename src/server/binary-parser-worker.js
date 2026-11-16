import { msg, messageDescriptor } from './messages.js';
import { contentTemplates, setContentLanguage } from './content-templates.js';
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseDocument } from 'htmlparser2';
import yauzl from 'yauzl';

const { limits, extension } = workerData;
setContentLanguage(workerData.contentLanguage);
const bytes = Buffer.from(workerData.bytes);
const require = createRequire(import.meta.url);

function collector() {
  const chunks = [];
  const locations = [];
  let size = 0;
  let line = 1;
  return {
    add(text, location) {
      text = text.replaceAll('\u0000', '').trim();
      if (!text) {
        return;
      }
      size += text.length + 2;
      if (size > limits.characters) {
        throw new Error('ERR_EXTRACTED_TEXT_TOO_LARGE');
      }
      const startLine = line;
      line += text.split('\n').length + 1;
      chunks.push(text);
      locations.push({ ...location, startLine, endLine: line - 2 });
    },
    result() {
      return { text: chunks.join('\n\n'), coordinate: 'extracted', locations };
    },
  };
}

async function checkOfficeArchive() {
  await new Promise((resolve, reject) =>
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error) {
        return reject(new Error('ERR_OFFICE_FILE_INVALID'));
      }
      let total = 0;
      let count = 0;
      let main = false;
      let done = false;
      const fail = (message) => {
        if (!done) {
          done = true;
          zip.close();
          reject(new Error(message));
        }
      };
      zip.on('error', () => fail('ERR_OFFICE_ARCHIVE_CORRUPTED'));
      zip.on('entry', (entry) => {
        total += entry.uncompressedSize;
        count++;
        if (total > limits.zipBytes || count > limits.zipEntries) {
          return fail('ERR_OFFICE_EXTRACTED_CONTENT_TOO_LARGE');
        }
        if (entry.generalPurposeBitFlag & 1) {
          return fail('ERR_ENCRYPTED_OFFICE_UNSUPPORTED');
        }
        if (entry.fileName === (extension === '.docx' ? 'word/document.xml' : 'xl/workbook.xml')) {
          main = true;
        }
        zip.readEntry();
      });
      zip.on('end', () => {
        if (!done) {
          done = true;
          zip.close();
          main ? resolve() : reject(new Error('ERR_FILE_CONTENT_EXTENSION_MISMATCH'));
        }
      });
      zip.readEntry();
    }),
  );
}

async function pdf() {
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new Error('ERR_PDF_INVALID');
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    cMapUrl: join(root, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: join(root, 'standard_fonts') + '/',
    verbosity: 0,
  });
  let document;
  try {
    document = await task.promise;
    if (document.numPages > limits.pages) {
      throw new Error('ERR_PDF_TOO_MANY_PAGES');
    }
    const output = collector();
    let textPages = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = '';
      let previousY;
      for (const item of content.items) {
        if (!('str' in item)) {
          continue;
        }
        const y = item.transform?.[5];
        if (
          previousY !== undefined &&
          y !== undefined &&
          Math.abs(y - previousY) > 2 &&
          !text.endsWith('\n')
        ) {
          text += '\n';
        }
        text += item.str + (item.hasEOL ? '\n' : ' ');
        previousY = y;
      }
      if (text.trim()) {
        textPages++;
        output.add(contentTemplates().binary.pageHeading(pageNumber, text.trim()), {
          page: pageNumber,
        });
      }
      page.cleanup();
    }
    if (!textPages) {
      throw new Error('ERR_PDF_NO_TEXT_NEEDS_OCR');
    }
    const result = output.result();
    if (textPages !== document.numPages) {
      result.warnings = [
        messageDescriptor(
          msg('ERR_PDF_PAGE_NO_TEXT_OCR_SKIPPED', { v0: document.numPages - textPages }),
        ),
      ];
    }
    return result;
  } catch (error) {
    if (error.name === 'PasswordException') {
      throw new Error('ERR_PDF_ENCRYPTED');
    }
    throw error;
  } finally {
    await task.destroy();
  }
}

async function docx() {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.convertToHtml(
    { buffer: bytes },
    { externalFileAccess: false, convertImage: mammoth.images.imgElement(async () => ({})) },
  );
  const root = parseDocument(value);
  const output = collector();
  let paragraph = 0;
  const textOf = (node) => {
    if (node.type === 'text') {
      return node.data;
    } else if (node.name === 'br') {
      return '\n';
    } else {
      return (node.children || []).map(textOf).join('');
    }
  };
  const visit = (node) => {
    if (node.name === 'img') {
      return;
    }
    if (/^(p|h[1-6]|li|tr)$/.test(node.name || '')) {
      if (++paragraph > limits.blocks) {
        throw new Error('ERR_WORD_TOO_MANY_PARAGRAPHS');
      }
      const heading = /^h[1-6]$/.test(node.name);
      const text =
        node.name === 'tr'
          ? (node.children || [])
              .filter((n) => /^(td|th)$/.test(n.name))
              .map(textOf)
              .join(' | ')
          : textOf(node);
      let prefix;
      if (heading) {
        prefix = '#'.repeat(Number(node.name[1])) + ' ';
      } else if (node.name === 'li') {
        prefix = '- ';
      } else {
        prefix = '';
      }
      output.add(`${prefix}${text}`, { paragraph });
      return;
    }
    for (const child of node.children || []) {
      visit(child);
    }
  };
  visit(root);
  return output.result();
}

async function xlsx() {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  if (workbook.worksheets.length > limits.sheets) {
    throw new Error('ERR_EXCEL_TOO_MANY_SHEETS');
  }
  const output = collector();
  let count = 0;
  for (const sheet of workbook.worksheets) {
    let started = false;
    sheet.eachRow((row) => {
      const values = [];
      let first;
      let last;
      row.eachCell((cell) => {
        if (++count > limits.cells) {
          throw new Error('ERR_EXCEL_TOO_MANY_CELLS');
        }
        if (cell.isMerged && cell.master.address !== cell.address) {
          return;
        }
        const value = cell.value;
        const display = value instanceof Date ? value.toISOString() : cell.text;
        const binary = contentTemplates().binary;
        const formula = cell.formula
          ? binary.formulaNote(cell.formula, cell.result === undefined ? binary.formulaMissing : '')
          : '';
        values.push(`${cell.address}: ${display}${formula}`);
        first ??= cell.address;
        last = cell.address;
      });
      if (values.length) {
        if (!started) {
          output.add(contentTemplates().binary.worksheetHeading(sheet.name), { sheet: sheet.name });
          started = true;
        }
        output.add(values.join(' | '), {
          sheet: sheet.name,
          range: first === last ? first : `${first}:${last}`,
        });
      }
    });
  }
  return output.result();
}

try {
  if (extension !== '.pdf') {
    await checkOfficeArchive();
  }
  const result = await { '.pdf': pdf, '.docx': docx, '.xlsx': xlsx }[extension]();
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: messageDescriptor(error) });
}
