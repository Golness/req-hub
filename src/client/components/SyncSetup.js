'use strict';
const React = require('react');
const { HeaderBack } = require('./shared/HeaderBack.js');
const { Input } = require('./shared/Input.js');
const { Button } = require('./shared/Button.js');
const { t } = require('../locale.js');
const css = require('./SyncSetup.module.css').default;
const h = React.createElement;

/**
 * Group sync controls under one heading without owning their selections or effects.
 * @param props - Heading, optional summary, actions and existing control elements.
 * @returns A consistently labelled setup section.
 */
function SetupSection({ title, summary, actions, className = '', children, open, onOpenChange }) {
  const id = React.useId();
  return h(
    'section',
    { className: `${css.section} ${className}`, 'aria-labelledby': id },
    h(
      'header',
      { className: css.heading },
      h('h3', { id }, title),
      summary && h('span', { className: css.hint }, summary),
      actions && h('div', { className: css.actions }, actions),
      onOpenChange &&
        h(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            className: css.expand,
            'aria-expanded': open,
            'aria-controls': id + '-body',
            'aria-label': t(open ? 'sync.layout.collapse' : 'sync.layout.expand', {
              section: title,
            }),
            onClick: () => onOpenChange(!open),
          },
          t(open ? 'disclosure.collapse' : 'disclosure.expand'),
        ),
    ),
    h('div', { id: id + '-body', hidden: open === false }, children),
  );
}

/**
 * Render both document types with the same sections and a sticky selection/action footer.
 * @param props - Display metadata, controlled field callbacks and existing business controls.
 * @returns The setup layout; task execution and selection validation remain with its owner.
 */
function SyncSetup({
  title,
  outputName,
  requirementPath,
  branchInfo,
  baseBranch,
  onBaseBranchChange,
  baseDisabled,
  commitSummary,
  commitActions,
  commitSelection,
  references,
  sources,
  selectionSummary,
  actionLabel,
  onStart,
  startDisabled,
  error,
  activeTask,
  onBack,
  sourcesOpen,
  onSourcesOpenChange,
  sourcesSummary,
}) {
  const baseId = React.useId();
  return h(
    'div',
    { className: css.setup },
    h(HeaderBack, { onBack, label: t('common.back') }),
    h(
      'div',
      { className: css.content },
      h(
        'header',
        { className: css.pageHeading },
        h('h2', null, title),
        h('span', { className: css.hint }, outputName),
      ),
      activeTask,
      h(
        SetupSection,
        { title: t('sync.layout.target') },
        h(
          'div',
          { className: css.fields },
          h('span', { className: css.label }, t('sync.layout.requirement')),
          h('span', { className: css.readonly }, requirementPath),
          h('span', { className: css.label }, t('sync.layout.branch')),
          h(
            'span',
            { className: css.readonly },
            branchInfo.targetBranch || t('SyncPanel.message068'),
          ),
          h('label', { className: css.label, htmlFor: baseId }, t('sync.layout.base')),
          h(Input, {
            id: baseId,
            className: css.input,
            'aria-label': t('SyncPanel.message070'),
            placeholder: t('SyncPanel.message071'),
            value: baseBranch,
            disabled: baseDisabled,
            onChange: (event) => onBaseBranchChange(event.target.value),
          }),
        ),
        !baseBranch.trim() &&
          branchInfo.baseBranchHint &&
          h('p', { className: css.hint, role: 'status' }, branchInfo.baseBranchHint),
        branchInfo.targetBranchError &&
          h('p', { className: css.error, role: 'alert' }, branchInfo.targetBranchError),
      ),
      h(
        SetupSection,
        {
          title: t('sync.layout.code'),
          summary: commitSummary,
          actions: commitActions,
          className: 'rh-sync-commits',
        },
        h('p', { className: css.hint }, t('SyncPanel.message076')),
        commitSelection,
      ),
      h(
        SetupSection,
        { title: t('sync.layout.references'), summary: t('sync.layout.optional') },
        references,
      ),
      sources &&
        h(
          SetupSection,
          {
            title: t('sync.layout.sessions'),
            summary: sourcesSummary,
            open: sourcesOpen,
            onOpenChange: onSourcesOpenChange,
          },
          sources,
        ),
    ),
    h(
      'footer',
      { className: css.footer, 'aria-label': t('sync.layout.selectionSummary') },
      error && h('p', { role: 'alert', className: css.error }, error),
      h(
        'div',
        { className: css.footerRow },
        h(
          'div',
          { className: css.summary },
          h('div', { 'aria-live': 'polite' }, selectionSummary),
          h('p', { className: css.hint }, t('sync.layout.flow')),
        ),
        h(
          Button,
          {
            variant: 'primary',
            className: css.start,
            onClick: onStart,
            disabled: startDisabled,
          },
          actionLabel,
        ),
      ),
    ),
  );
}
module.exports = { SyncSetup };
