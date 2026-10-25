'use strict';
const { t } = require('../../locale.js');
const React = require('react');
const { Select } = require('./Select.js');
const h = React.createElement;

function VersionSelect({ label, versions, value, onChange }) {
  const id = React.useId();
  const versionDate = version => {
    const date = new Date(version.completedAt || version.startedAt);
    return Number.isNaN(date.getTime()) ? t("VersionSelect.message001") : date.toLocaleString('zh-CN', { hour12: false });
  };
  return h('div', { className: 'rh-version-select' },
    h('label', { className: 'rh-version-label', htmlFor: id }, label),
    h(Select, {
      id, className: 'rh-version-picker', value, onChange: event => onChange(event.target.value),
      disabled: !versions.length, placeholder: t("VersionSelect.message002"),
      options: versions.map((version, index) => ({ id: version.id, label: h('span', { className: 'rh-version-value' },
        h('span', { className: 'rh-version-name' }, (version.commitHash || version.id).slice(0, 8),
          index === 0 && h('span', { className: 'rh-version-latest' }, t("FileTreeSidebar.message028"))),
        h('span', { className: 'rh-version-date' }, versionDate(version))) })),
    }));
}
module.exports = { VersionSelect };
