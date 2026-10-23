'use strict';

let diagramId = 0;

// Keep source text in ProseMirror's contentDOM so diagrams round-trip to Markdown.
function createMarkdownCodeBlockView(getMermaid, renderers) {
  return (initialNode) => {
    let node = initialNode;
    let destroyed = false;
    let revision = 0;
    let timer;
    const language = node.attrs.language || '';
    const isDiagram = language.toLowerCase() === 'mermaid';
    const pre = document.createElement('pre');
    pre.dataset.language = language;
    const code = document.createElement('code');
    if (language) code.className = `language-${language}`;
    pre.appendChild(code);
    if (!isDiagram) return { dom: pre, contentDOM: code };

    const dom = document.createElement('div');
    dom.className = 'rh-editable-mermaid';
    const preview = document.createElement('div');
    preview.className = 'rh-mermaid-preview';
    preview.contentEditable = 'false';
    const source = document.createElement('details');
    const summary = document.createElement('summary');
    summary.contentEditable = 'false';
    summary.textContent = '图表源码';
    source.append(summary, pre);
    dom.append(preview, source);

    const render = async () => {
      const currentRevision = ++revision;
      const mermaid = getMermaid();
      if (!mermaid) {
        preview.textContent = '图表加载中…';
        return;
      }
      try {
        const { svg } = await mermaid.render(`rh-editable-mermaid-${++diagramId}`, node.textContent);
        if (destroyed || currentRevision !== revision) return;
        preview.innerHTML = svg;
      } catch {
        if (destroyed || currentRevision !== revision) return;
        preview.textContent = '图表暂时无法渲染，可展开源码修改';
        source.open = true;
      }
    };
    renderers.add(render);
    render();

    return {
      dom,
      contentDOM: code,
      update(nextNode) {
        if (nextNode.type !== node.type || nextNode.attrs.language !== node.attrs.language) return false;
        const changed = nextNode.textContent !== node.textContent;
        node = nextNode;
        if (changed) {
          // Invalidate pending work as soon as the source changes.
          revision++;
          clearTimeout(timer);
          timer = setTimeout(render, 150);
        }
        return true;
      },
      stopEvent(event) {
        return summary.contains(event.target) || preview.contains(event.target);
      },
      ignoreMutation(mutation) {
        if (mutation.type === 'selection') return false;
        return !code.contains(mutation.target) && mutation.target !== code;
      },
      destroy() {
        destroyed = true;
        revision++;
        clearTimeout(timer);
        renderers.delete(render);
      },
    };
  };
}

module.exports = { createMarkdownCodeBlockView };
