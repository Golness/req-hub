'use strict';
const React = require('react');
const { Button } = require('./Button.js');
const { t } = require('../../locale.js');
const css = require('./ScrollList.module.css').default;
const h = React.createElement;

/**
 * Reveal already-loaded records in batches without pagination or clipping their content.
 * @param props - Keyed records, an accessible label and an optional identity for reset.
 * @returns A content-sized list that grows on scroll and retains a keyboard load action.
 */
function ScrollList({ children, label, resetKey, batchSize = 20, className = '' }) {
  const items = React.Children.toArray(children);
  const [visible, setVisible] = React.useState(batchSize);
  React.useEffect(() => setVisible(batchSize), [resetKey, batchSize]);
  const more = () => setVisible((count) => Math.min(items.length, count + batchSize));
  return h(
    'div',
    {
      className: `${css.scroll} ${className}`,
      role: 'region',
      'aria-label': label,
      tabIndex: 0,
      'data-rh-scroll-list': '',
      onScroll: (event) => {
        const node = event.currentTarget;
        if (node.scrollHeight - node.scrollTop - node.clientHeight < 80) {
          more();
        }
      },
    },
    h(
      'div',
      { role: 'list', className: css.items },
      items.slice(0, visible).map((item) => h('div', { key: item.key, role: 'listitem' }, item)),
    ),
    visible < items.length &&
      h(
        Button,
        { size: 'sm', variant: 'ghost', onClick: more },
        t('list.showMore', { count: items.length - visible }),
      ),
  );
}
module.exports = { ScrollList };
