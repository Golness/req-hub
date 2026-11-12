import { parseDocument } from 'htmlparser2';
import { fail } from './contracts.js';

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'blockquote',
  'pre',
  'table',
  'ul',
  'ol',
  'dl',
  'figure',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'br',
]);
const SKIP_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'form',
  'noscript',
  'template',
  'object',
  'embed',
  'svg',
  'head',
]);
const HEADING = /^h([1-6])$/;

/**
 * Decode strict UTF-8 (BOM tolerated); other encodings fail instead of guessing.
 * @param bytes - Raw file bytes.
 * @returns The decoded text without a BOM.
 */
export function decodeUtf8(bytes) {
  const body =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    fail('KB_ENCODING_UNSUPPORTED', 415, { encoding: 'utf-8 required' });
  }
  if (text.includes('\u0000')) {
    fail('KB_BINARY_CONTENT', 415);
  }
  return text;
}

function textOf(node) {
  if (node.type === 'text') {
    return node.data;
  }
  if (node.type !== 'tag' && node.type !== 'root') {
    return '';
  }
  if (node.type === 'tag' && SKIP_TAGS.has(node.name)) {
    return '';
  }
  return (node.children || []).map(textOf).join('');
}

function renderNode(node, out, listStack) {
  if (node.type === 'text') {
    const text = node.data.replace(/\s+/g, ' ');
    if (text.trim()) {
      out.push(text);
    }
    return;
  }
  if (node.type !== 'tag' && node.type !== 'root') {
    return;
  }
  if (node.type === 'tag' && SKIP_TAGS.has(node.name)) {
    return;
  }
  const name = node.name;
  const heading = name && HEADING.exec(name);
  if (heading) {
    out.push('\n\n' + '#'.repeat(Number(heading[1])) + ' ');
    for (const child of node.children || []) {
      renderNode(child, out, listStack);
    }
    out.push('\n');
    return;
  }
  if (name === 'li') {
    const ordered = listStack.at(-1) === 'ol';
    const index = ordered
      ? (listStack.counts[listStack.length - 1] = (listStack.counts[listStack.length - 1] || 0) + 1)
      : 0;
    out.push(
      '\n' + '  '.repeat(Math.max(0, listStack.length - 1)) + (ordered ? `${index}. ` : '- '),
    );
    for (const child of node.children || []) {
      renderNode(child, out, listStack);
    }
    return;
  }
  if (name === 'ul' || name === 'ol' || name === 'dl') {
    listStack.push(name);
    listStack.counts.push(0);
    for (const child of node.children || []) {
      renderNode(child, out, listStack);
    }
    listStack.pop();
    listStack.counts.pop();
    out.push('\n');
    return;
  }
  if (name === 'tr') {
    const cells = (node.children || [])
      .filter((child) => child.type === 'tag' && (child.name === 'td' || child.name === 'th'))
      .map((cell) => textOf(cell).replace(/\s+/g, ' ').trim());
    if (cells.length) {
      out.push('\n| ' + cells.join(' | ') + ' |');
    }
    return;
  }
  if (name === 'br' || name === 'hr') {
    out.push('\n');
    return;
  }
  if (name === 'pre' || name === 'code') {
    const text = textOf(node).replace(/\s+$/g, '');
    if (text.trim()) {
      out.push(name === 'pre' ? '\n\n```\n' + text + '\n```\n' : '`' + text.trim() + '`');
    }
    return;
  }
  if (name && BLOCK_TAGS.has(name)) {
    out.push('\n\n');
  }
  for (const child of node.children || []) {
    renderNode(child, out, listStack);
  }
  if (name && BLOCK_TAGS.has(name)) {
    out.push('\n');
  }
}

/**
 * Extract readable Markdown from untrusted HTML without executing or fetching.
 * @param html - Decoded HTML text.
 * @returns {title, text} with the document title and normalized body.
 */
export function normalizeHtml(html) {
  let document;
  try {
    document = parseDocument(html, { decodeEntities: true });
  } catch {
    fail('KB_HTML_INVALID', 415);
  }
  const titleNode = (function find(node) {
    if (node.type === 'tag' && node.name === 'title') {
      return node;
    }
    for (const child of node.children || []) {
      const found = find(child);
      if (found) {
        return found;
      }
    }
    return undefined;
  })(document);
  const title = titleNode ? textOf(titleNode).replace(/\s+/g, ' ').trim() : '';
  const out = [];
  const listStack = [];
  listStack.counts = [];
  for (const child of document.children || []) {
    renderNode(child, out, listStack);
  }
  const text = out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) {
    fail('KB_HTML_EMPTY', 415);
  }
  return { title, text: (title ? `# ${title}\n\n` : '') + text + '\n' };
}

/**
 * Normalize one decoded text file by extension.
 * @param extension - Lowercase whitelisted extension including the dot.
 * @param text - Strictly decoded UTF-8 content.
 * @returns {title, content, normalized} where content is the compile body.
 */
export function normalizeText(extension, text) {
  if (!text.trim()) {
    fail('KB_SOURCE_EMPTY', 415);
  }
  if (extension === '.html' || extension === '.htm') {
    const { title, text: body } = normalizeHtml(text);
    return { title, content: body, normalized: true };
  }
  const heading = /^#\s+(.+)$/m.exec(text);
  return { title: heading ? heading[1].trim() : '', content: text, normalized: false };
}
