'use strict';
const React = require('react');
const { Button } = require('./Button.js');
const { Input } = require('./Input.js');
const { Select } = require('./Select.js');
const { Modal } = require('./controls.js');
const { CompactListContext } = require('./CompactListContext.js');
const { t } = require('../../locale.js');
const css = require('./PagedList.module.css').default;
const h = React.createElement;
const INTERACTIVE =
  'button, a, input, select, textarea, summary, [role="button"], [role="checkbox"], [contenteditable="true"]';

/**
 * Scroll variable-height records while keeping paging controls outside the scroll area.
 * @param props - Keyed records, paging state and optional plain rows that fit their content.
 * @returns A compact list with persistent paging controls and full record inspection.
 */
function PagedList({
  children,
  hasMore = false,
  onMore,
  busy = false,
  resetKey,
  className = '',
  rowHeight = 64,
  inspect = true,
  onPageChange,
  rowGroupRole = 'list',
  rowRole = 'listitem',
  plainRows = false,
  fitContent = false,
}) {
  const items = React.Children.toArray(children);
  const [page, setPage] = React.useState(0);
  const [size, setSize] = React.useState(10);
  const [jump, setJump] = React.useState('1');
  const [pending, setPending] = React.useState(false);
  const [detailKey, setDetail] = React.useState(null);
  const [error, setError] = React.useState(false);
  const rows = React.useRef(null);
  const mounted = React.useRef(true);
  const waiting = React.useRef(null);
  const request = React.useRef(null);
  const detail = items.find((item) => item.key === detailKey);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current = null;
    };
  }, []);
  React.useEffect(() => {
    setPage(0);
    setDetail(null);
    setError(false);
    waiting.current = null;
    request.current = null;
    setPending(false);
  }, [resetKey]);
  React.useEffect(() => {
    if (!pending && waiting.current !== null) {
      if (items.length > waiting.current.count) {
        setPage(waiting.current.page);
      }
      waiting.current = null;
    }
  }, [items.length, size, pending]);
  const last = Math.max(0, Math.ceil(items.length / size) - 1);
  const current = Math.min(page, last);
  React.useEffect(() => {
    if (page > last) {
      setPage(last);
    }
  }, [page, last]);
  React.useEffect(() => {
    onPageChange?.(current);
  }, [current, onPageChange]);
  React.useEffect(() => {
    setJump(String(current + 1));
    if (rows.current) {
      rows.current.scrollTop = 0;
    }
  }, [current, size, resetKey]);
  const start = current * size;
  const next = async () => {
    if (current < last) {
      setPage(current + 1);
      return;
    }
    if (!hasMore || !onMore || request.current || busy) {
      return;
    }
    const identity = {};
    request.current = identity;
    waiting.current = { count: items.length, page: current + 1 };
    setError(false);
    setPending(true);
    try {
      await onMore();
    } catch {
      // Keep the current page intact when a cursor request fails.
      if (mounted.current && request.current === identity) {
        waiting.current = null;
        setError(true);
      }
    } finally {
      if (mounted.current && request.current === identity) {
        request.current = null;
        setPending(false);
      }
    }
  };
  return h(
    'div',
    {
      className: `${css.paged} ${fitContent ? css.fitContent : ''} ${className}`,
      'data-paged-list': '',
    },
    h(
      CompactListContext.Provider,
      { value: true },
      h(
        'div',
        { ref: rows, className: css.rows, role: rowGroupRole, 'aria-busy': busy || pending },
        items.slice(start, start + size).map((item, index) => {
          const clickable = inspect && !item.props?.onClick && !['button', 'a'].includes(item.type);
          const openDetail = () => setDetail(item.key);
          return h(
            'div',
            {
              key: item.key || index,
              className: css.row,
              role: rowRole,
              tabIndex: clickable ? 0 : undefined,
              'aria-label': clickable ? t('pagination.details') : undefined,
              'aria-haspopup': clickable ? 'dialog' : undefined,
              onClick: clickable
                ? (event) => {
                    if (!event.target.closest(INTERACTIVE)) {
                      openDetail();
                    }
                  }
                : undefined,
              onKeyDown: clickable
                ? (event) => {
                    if (
                      event.target === event.currentTarget &&
                      ['Enter', ' '].includes(event.key)
                    ) {
                      event.preventDefault();
                      openDetail();
                    }
                  }
                : undefined,
              style: { '--rh-list-row-height': `${rowHeight}px` },
            },
            h('div', { className: plainRows ? css.plainPreview : css.preview }, item),
          );
        }),
      ),
    ),
    error && h('p', { role: 'alert', className: css.error }, t('pagination.failed')),
    (items.length > size || hasMore) &&
      h(
        'nav',
        { className: css.pager, 'aria-label': t('pagination.label') },
        h(
          'span',
          { className: css.count, role: 'status', 'aria-live': 'polite' },
          t(hasMore ? 'pagination.rangeMore' : 'pagination.range', {
            page: current + 1,
            pages: last + 1,
            total: items.length,
            from: items.length ? start + 1 : 0,
            to: Math.min(start + size, items.length),
          }),
        ),
        h(Select, {
          className: css.pageSize,
          'aria-label': t('pagination.size'),
          value: String(size),
          disabled: busy || pending,
          options: [10, 20, 50].map((value) => ({
            id: String(value),
            label: t('pagination.sizeOption', { count: value }),
          })),
          onChange: (event) => {
            setSize(Number(event.target.value));
            setPage(0);
            setError(false);
          },
        }),
        h(
          'div',
          { className: css.navigation },
          h(
            Button,
            {
              size: 'sm',
              variant: 'ghost',
              disabled: !current || pending || busy,
              onClick: () => setPage(current - 1),
            },
            t('pagination.previous'),
          ),
          h(
            Button,
            {
              size: 'sm',
              variant: 'ghost',
              disabled: (current >= last && !hasMore) || pending || busy,
              onClick: next,
            },
            t('pagination.next'),
          ),
        ),
        h(
          'form',
          {
            className: css.jump,
            onSubmit: (event) => {
              event.preventDefault();
              const target = Number(jump);
              if (Number.isInteger(target) && target >= 1 && target <= last + 1) {
                setPage(target - 1);
                setJump(String(target));
              }
            },
          },
          h(Input, {
            className: css.pageInput,
            type: 'number',
            min: 1,
            max: last + 1,
            step: 1,
            required: true,
            value: jump,
            'aria-label': t('pagination.page'),
            disabled: busy || pending,
            onChange: (event) => setJump(event.target.value),
          }),
          h(
            Button,
            {
              type: 'submit',
              size: 'sm',
              variant: 'ghost',
              disabled:
                busy ||
                pending ||
                !Number.isInteger(Number(jump)) ||
                Number(jump) < 1 ||
                Number(jump) > last + 1,
            },
            t('pagination.jump'),
          ),
        ),
      ),
    detail &&
      h(
        Modal,
        { open: true, title: t('pagination.details'), onClose: () => setDetail(null) },
        h(
          CompactListContext.Provider,
          { value: false },
          h('div', { className: css.detail }, detail),
        ),
      ),
  );
}
module.exports = { PagedList };
