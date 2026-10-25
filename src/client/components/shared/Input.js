'use strict';
// Native refs preserve focus and selection behavior for plugin controls.
const React = require('react');
const { Input: HostInput } = require('./controls.js');
const Input = React.forwardRef(function Input({ id, ...props }, ref) {
  const generated = React.useId();
  const inputId = id || generated;
  React.useLayoutEffect(() => {
    if (!ref) return;
    const node = document.getElementById(inputId);
    if (typeof ref === 'function') { ref(node); return () => ref(null); }
    ref.current = node;
    return () => { ref.current = null; };
  }, [inputId, ref]);
  return React.createElement(HostInput, { ...props, id: inputId });
});
module.exports = { Input };
