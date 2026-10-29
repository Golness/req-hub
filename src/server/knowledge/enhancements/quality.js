import { fromMarkdown } from 'mdast-util-from-markdown';
import { digest, fail } from './contracts.js';

/** Rules describe document structure only; no business completeness score. */
export function checkStructure(documents) {
  const findings = [];
  for (const doc of documents) {
    const children = fromMarkdown(doc.body).children;
    const add = (kind, line, details) => { if (findings.length >= 200) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413); findings.push({ id: digest([doc.id, kind, line]), kind, status: 'needsConfirmation', evidence: [{ documentId: doc.id, version: doc.version, startLine: line, endLine: line }], details, proposal: null }); };
    if (!children.some(node => node.type === 'heading' && node.depth === 1)) add('missing_title', 1, {});
    children.forEach((node, index) => {
      if (node.type === 'heading' && (!children[index + 1] || children[index + 1].type === 'heading')) add('empty_section', node.position.start.line, {});
    });
    for (const [index, line] of doc.body.split('\n').entries()) if (/\bTODO\b|待补充|待填写|\{\{[^}]+\}\}/i.test(line)) add('placeholder', index + 1, {});
  }
  return { findings, coverage: { requestedDocuments: documents.length, fullyReadDocuments: documents.length, truncated: false }, method: 'rules' };
}
