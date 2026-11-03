'use strict';
const { t } = require('../../locale.js');
const css = require('./SyncVersionCompare.module.css').default;
const { Button } = require('./Button.js');
const React = require('react');
const h = React.createElement;
const { ROUTE } = require('../../constants.js');
const { useDiffReview } = require('./DiffReviewPage.js');
const { SyncDocTypeTabs } = require('./SyncDocTypeTabs.js');
const { VersionSelect } = require('./VersionSelect.js');
const { hasPublishedDocument } = require('../../../shared/sync-task.cjs');

/**
 * Compare recorded versions with optional type tabs and open the read-only review directly.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function SyncVersionCompare({
  history,
  workspaceId,
  requirementId,
  docType: selectedDocType,
  onDocTypeChange,
  showTypeTabs = true,
}) {
  const id = React.useId();
  const [localDocType, setLocalDocType] = React.useState('requirement');
  const docType = selectedDocType || localDocType;
  const setDocType = (type) => {
    setLocalDocType(type);
    onDocTypeChange?.(type);
  };
  const versions = history.filter((sync) => hasPublishedDocument(sync) && sync.docType === docType);
  const [selection, setSelection] = React.useState(null);
  const review = useDiffReview();
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const request = React.useRef(0);
  const oldId = selection?.oldId ?? versions[1]?.id ?? '';
  const newId = selection?.newId ?? versions[0]?.id ?? '';
  React.useEffect(() => {
    request.current++;
    setSelection(null);
    setError('');
    setLoading(false);
    return () => {
      request.current++;
    };
  }, [docType, workspaceId, requirementId, history]);
  const change = (side, id) => {
    request.current++;
    setSelection({ oldId, newId, [side]: id });
    setError('');
    setLoading(false);
  };
  const compare = async (event) => {
    const returnFocus = event.currentTarget;
    const token = ++request.current;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        workspaceId,
        requirementId,
        syncId1: oldId,
        syncId2: newId,
      });
      const response = await fetch(`${ROUTE}/sync-version-diff?${params}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t('SyncVersionCompare.message001'));
      }
      if (token === request.current) {
        review.open({
          ...data,
          returnFocus,
          fileName: docType === 'requirement' ? 'requirement.md' : 'design.md',
        });
      }
    } catch (error) {
      if (token === request.current) {
        setError(error.message);
      }
    } finally {
      if (token === request.current) {
        setLoading(false);
      }
    }
  };
  if (review.page) {
    return review.page;
  }
  return h(
    'section',
    { className: css.spacing, 'aria-label': t('SyncVersionCompare.message002') },
    h('h3', null, t('SyncVersionCompare.message002')),
    showTypeTabs &&
      h(SyncDocTypeTabs, { value: docType, onChange: setDocType, panelId: id + '-panel' }),
    h(
      'div',
      {
        role: showTypeTabs ? 'tabpanel' : undefined,
        id: `${id}-panel`,
        'aria-labelledby': showTypeTabs ? `${id}-panel-tab-${docType}` : undefined,
      },
      h('p', { className: css.mutedText }, t('SyncVersionCompare.message003')),
      versions.length < 2
        ? h(
            'p',
            { role: 'status' },
            t('SyncVersionCompare.message004', { value0: versions.length }),
          )
        : h(
            'div',
            null,
            h(
              'div',
              { className: css.row },
              h(VersionSelect, {
                key: `${docType}-base`,
                label: t('SyncVersionCompare.message005'),
                versions,
                value: oldId,
                onChange: (id) => change('oldId', id),
              }),
              h(VersionSelect, {
                key: `${docType}-target`,
                label: t('SyncVersionCompare.message006'),
                versions,
                value: newId,
                onChange: (id) => change('newId', id),
              }),
            ),
            h(
              'div',
              { className: css.actions },
              h(
                Button,
                {
                  variant: 'ghost',
                  className: css.action,
                  disabled: loading,
                  onClick: () => {
                    request.current++;
                    setSelection({ oldId: newId, newId: oldId });
                    setError('');
                  },
                },
                t('SyncVersionCompare.message007'),
              ),
              h(
                Button,
                {
                  variant: 'primary',
                  className: css.action,
                  disabled: loading || !oldId || !newId || oldId === newId,
                  onClick: compare,
                },
                loading ? t('SyncVersionCompare.message008') : t('SyncVersionCompare.message009'),
              ),
            ),
            oldId === newId && h('p', { role: 'status' }, t('SyncVersionCompare.message010')),
          ),
      error && h('p', { role: 'alert' }, error),
    ),
  );
}
module.exports = { SyncVersionCompare };
