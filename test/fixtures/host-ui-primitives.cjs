// The desktop supplies this external module. Test only the plugin's adapter contract;
// menu keyboard traversal, viewport placement and surface styling belong to DSH.
const React = require('react');
const { createPortal } = require('react-dom');
const h = React.createElement;
const menus = new Map();
function Menu(props) {
  const { anchor, className, listClassName, children, open, items, selectedId, onSelect, portal } = props;
  menus.set(anchor.props.id, props);
  React.useEffect(() => () => { menus.delete(anchor.props.id); }, [anchor.props.id]);
  const list = open && h('div', { role: 'menu', className: listClassName }, items.map(item => h('button', {
    key: item.id, type: 'button', role: 'menuitem', disabled: item.disabled,
    'data-selected': selectedId === item.id, onClick: () => onSelect(item.id),
  }, item.label)), children);
  return h('span', { className }, anchor, list && (portal ? createPortal(list, document.body) : list));
}
module.exports = { Menu, menus, IconChevronDownOutlineRegular: props => h('svg', { ...props, viewBox: '0 0 24 24' }, h('path', { d: 'm6 9 6 6 6-6' })) };
