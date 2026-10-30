'use strict';
const { t } = require('../locale.js');
const disclosureCss = require('./shared/Disclosure.module.css').default;
const buttonCss = require('./shared/controls.module.css').default;

let diagramId = 0;

// Keep source text in ProseMirror's contentDOM so diagrams round-trip to Markdown.
/**
 * Create source-preserving code-block views with disposable diagram previews.
 * @param getMermaid - Callback reading the currently loaded Mermaid renderer.
 * @param renderers - The owned diagram-render queue.
 * @returns A ProseMirror node-view factory.
 */
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
    if (language) {
      code.className = `language-${language}`;
    }
    pre.appendChild(code);
    if (!isDiagram) {
      return { dom: pre, contentDOM: code };
    }

    const dom = document.createElement('div');
    dom.className = 'rh-editable-mermaid';
    const preview = document.createElement('div');
    preview.className = 'rh-mermaid-preview';
    preview.contentEditable = 'false';
    const source = document.createElement('section');
    source.className = disclosureCss.section;
    source.dataset.rhDisclosure = '';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.contentEditable = 'false';
    trigger.className = `${buttonCss.button} ${buttonCss.ghost} ${buttonCss.sm} ${disclosureCss.trigger}`;
    trigger.dataset.rhDisclosureTrigger = '';
    const title = document.createElement('span');
    title.className = disclosureCss.title;
    title.textContent = t('MarkdownCodeBlockView.message001');
    const action = document.createElement('span');
    action.className = disclosureCss.action;
    action.setAttribute('aria-hidden', 'true');
    const content = document.createElement('div');
    content.id = `rh-mermaid-source-${++diagramId}`;
    content.className = disclosureCss.content;
    content.dataset.rhDisclosureContent = '';
    trigger.setAttribute('aria-controls', content.id);
    const setOpen = (open) => {
      content.hidden = !open;
      trigger.setAttribute('aria-expanded', String(open));
      action.textContent = t(open ? 'disclosure.collapse' : 'disclosure.expand');
    };
    setOpen(false);
    trigger.onclick = () => setOpen(content.hidden);
    trigger.append(title, action);
    content.append(pre);
    source.append(trigger, content);
    dom.append(preview, source);

    const render = async () => {
      const currentRevision = ++revision;
      const mermaid = getMermaid();
      if (!mermaid) {
        preview.textContent = t('MarkdownCodeBlockView.message002');
        return;
      }
      try {
        const { svg } = await mermaid.render(
          `rh-editable-mermaid-${++diagramId}`,
          node.textContent,
        );
        if (destroyed || currentRevision !== revision) {
          return;
        }
        preview.innerHTML = svg;
      } catch {
        if (destroyed || currentRevision !== revision) {
          return;
        }
        preview.textContent = t('MarkdownCodeBlockView.message003');
        setOpen(true);
      }
    };
    renderers.add(render);
    render();

    return {
      dom,
      contentDOM: code,
      update(nextNode) {
        if (nextNode.type !== node.type || nextNode.attrs.language !== node.attrs.language) {
          return false;
        }
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
        return trigger.contains(event.target) || preview.contains(event.target);
      },
      ignoreMutation(mutation) {
        if (mutation.type === 'selection') {
          return false;
        }
        return !code.contains(mutation.target) && mutation.target !== code;
      },
      destroy() {
        destroyed = true;
        revision++;
        clearTimeout(timer);
        renderers.delete(render);
        trigger.onclick = null;
      },
    };
  };
}

module.exports = { createMarkdownCodeBlockView };
