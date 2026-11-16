'use strict';
const { clientError } = require('../utils/serverMessage.js');
const React = require('react');
const { HoverCard } = require('./shared/controls.js');
const { Disclosure } = require('./shared/Disclosure.js');
const { Select } = require('./shared/Select.js');
const { Button } = require('./shared/Button.js');
const { SettingsActionBar } = require('./shared/SettingsActionBar.js');
const { Breadcrumb } = require('./shared/Breadcrumb.js');
const { PagedList } = require('./shared/PagedList.js');
const { LarkErrorDetails } = require('./LarkErrorDetails.js');
const { LarkWorkspaceBindings } = require('./LarkWorkspaceBindings.js');
const { ROUTE } = require('../constants.js');
const { t, hasLocaleKey } = require('../locale.js');
const form = require('./shared/SettingsForm.module.css').default;
const css = require('./LarkTargetSettings.module.css').default;
const layout = require('./LarkSettings.module.css').default;
const h = React.createElement;
const { IconInfo } = require('../icons.js').createIconComponents(h);

/**
 * Browse remote destinations while keeping the shared Wiki selection across workspace changes.
 * @param props - Initial workspace preference, connection revision and connection form lock.
 * @returns A binding summary or a hierarchical destination browser after successful removal.
 */
function LarkTargetSettings({ workspaceId, connectionKey, disabled, connectionBusy = false }) {
  const [workspaces, setWorkspaces] = React.useState(null);
  const [workspace, setWorkspace] = React.useState(workspaceId || '');
  const [type, setType] = React.useState('folder');
  const [useDefault, setUseDefault] = React.useState(false);
  const restoredScope = React.useRef(null);
  const defaultWiki = type === 'wiki' && useDefault;
  const [values, setValues] = React.useState(null);
  const [browser, setBrowser] = React.useState(null);
  const [spacePages, setSpacePages] = React.useState([]);
  const [spacePage, setSpacePage] = React.useState(0);
  const [selected, setSelected] = React.useState(null);
  const [defaultSpace, setDefaultSpace] = React.useState(null);
  const activeSelection = defaultWiki ? defaultSpace : selected;
  const [busy, setBusy] = React.useState(null);
  const [bindingListBusy, setBindingListBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const [reload, setReload] = React.useState(0);
  const [workspaceReload, setWorkspaceReload] = React.useState(0);
  const owner = React.useRef(null);
  const saving = React.useRef(false);
  const id = React.useId();
  const text = (key) => {
    const full = `lark.${key}`;
    return hasLocaleKey(full) ? t(full) : key;
  };
  const message = (code) => {
    const codes = [
      'LARK_APP_SCOPE_REQUIRED',
      'LARK_USER_SCOPE_REQUIRED',
      'LARK_NETWORK_FAILED',
      'LARK_LOGIN_REQUIRED',
      'LARK_WIKI_NAME_AMBIGUOUS',
      'LARK_WORKSPACE_NAME_AMBIGUOUS',
      'LARK_TARGET_INVALID',
      'LARK_TARGET_ACCESS_FAILED',
      'LARK_TARGET_CONFLICT',
      'LARK_WORKSPACE_INVALID',
      'LARK_TARGET_SAVED',
      'LARK_TARGET_REMOVED',
      'LARK_AUTH_UNVERIFIED',
      'LARK_CHECK_TIMEOUT',
      'LARK_CHECK_FAILED',
      'LARK_CONFIG_INVALID',
      'LARK_CHECK_BUSY',
      'LARK_QUEUE_FULL',
      'LARK_QUEUE_TIMEOUT',
      'LARK_CLI_NOT_FOUND',
      'LARK_RESPONSE_INVALID',
      'LARK_CHECK_CANCELLED',
      'LARK_OUTPUT_LIMIT',
    ];
    return text(codes.includes(code) ? code : 'LARK_TARGET_FAILED');
  };
  const request = async (action, body, signal) => {
    const response = await fetch(`${ROUTE}/lark/target-${action}`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || data.error || (data.code && !data.saved)) {
      const failure = clientError(data.error || data.code, 'LARK_TARGET_FAILED');
      failure.details = data.details;
      throw failure;
    }
    return data;
  };
  React.useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetch(`${ROUTE}/workspaces`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('LARK_WORKSPACE_INVALID');
        }
        const items = await response.json();
        if (!Array.isArray(items)) {
          throw new Error('LARK_RESPONSE_INVALID');
        }
        if (!controller.signal.aborted) {
          setWorkspaces(items);
          setWorkspace((previous) =>
            items.some((item) => item.id === previous) ? previous : items[0]?.id || '',
          );
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason);
        }
      });
    return () => controller.abort();
  }, [workspaceReload]);

  const browseBody = (trail, pageToken = '') => {
    const parent = trail.at(-1);
    return {
      workspaceId: workspace,
      type,
      pageToken,
      spaceId: type === 'wiki' ? parent?.spaceId || '' : '',
      parentToken: parent && parent.kind !== 'space' ? parent.token : '',
    };
  };
  React.useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    if (disabled) {
      setBusy(null);
      return () => controller.abort();
    }
    setValues(null);
    setBrowser(null);
    setSpacePages([]);
    setSpacePage(0);
    setSelected(null);
    setResult(null);
    if (!workspace || !workspaces?.some((item) => item.id === workspace)) {
      setBusy(null);
      return () => controller.abort();
    }
    setBusy('browse');
    setError(null);
    const load = async () => {
      try {
        const current = await request('get', { workspaceId: workspace }, controller.signal);
        if (!controller.signal.aborted) {
          setValues(current);
          const scopeKey = connectionKey;
          if (restoredScope.current !== scopeKey) {
            restoredScope.current = scopeKey;
            const savedDefault = current.binding?.useDefault === true;
            const savedWiki = current.binding?.kind === 'wiki';
            setDefaultSpace(null);
            setUseDefault(savedDefault);
            if (savedWiki) {
              setType('wiki');
            }
            if (savedDefault !== useDefault || (savedWiki && type !== 'wiki')) {
              return;
            }
          }
        }
        if (!disabled) {
          const options = await request('options', browseBody([]), controller.signal);
          if (!controller.signal.aborted) {
            setBrowser({ ...options, trail: [] });
            if (defaultWiki) {
              setSpacePages([options]);
              const savedSpace = options.items.find(
                (item) => item.kind === 'space' && item.spaceId === current.binding?.spaceId,
              );
              setDefaultSpace(
                (previous) =>
                  previous || (savedSpace ? { item: savedSpace, trail: [savedSpace] } : null),
              );
            }
          }
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason);
        }
      } finally {
        if (!controller.signal.aborted) {
          setBusy(null);
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [workspace, workspaces, type, useDefault, connectionKey, disabled, reload]);

  const loadLevel = async (trail, pageToken = '', append = false) => {
    if (busy || disabled) {
      return;
    }
    const signal = owner.current.signal;
    setBusy('browse');
    setError(null);
    setResult(null);
    try {
      const options = await request('options', browseBody(trail, pageToken), signal);
      if (!signal.aborted) {
        setBrowser((previous) => ({
          ...options,
          trail,
          items: append
            ? [
                ...previous.items,
                ...options.items.filter(
                  (item) =>
                    !previous.items.some(
                      (old) => old.kind === item.kind && old.token === item.token,
                    ),
                ),
              ]
            : options.items,
        }));
        if (!append) {
          setSelected(null);
        }
        return options;
      }
    } catch (reason) {
      if (!signal.aborted) {
        setError(reason);
      }
      if (append) {
        throw reason;
      }
    } finally {
      if (!signal.aborted) {
        setBusy(null);
      }
    }
  };
  const choose = (item, trail) => {
    if (defaultWiki) {
      setDefaultSpace({ item, trail });
    } else {
      setSelected({ item, trail });
    }
    setResult(null);
    setError(null);
  };
  const bind = async (remove = false) => {
    if (saving.current || busy || bindingListBusy || disabled || (!remove && !activeSelection)) {
      return;
    }
    if (!remove && !defaultWiki && values?.binding) {
      return;
    }
    saving.current = true;
    const signal = owner.current.signal;
    setBusy('save');
    setError(null);
    setResult(null);
    try {
      let action = remove ? 'remove' : 'save';
      let body = { workspaceId: workspace, expectedRevision: values.revision };
      if (!remove && defaultWiki) {
        action = 'default-save';
        body = {
          workspaceId: workspace,
          spaceId: activeSelection.item.spaceId,
          expectedDefaultRevision: values.defaultRevision,
        };
      } else if (!remove) {
        body.selection = activeSelection.item;
      }
      const data = await request(action, body, signal);
      if (!data.saved) {
        throw new Error('LARK_TARGET_FAILED');
      }
      if (!signal.aborted) {
        setValues((previous) => ({
          ...previous,
          binding: data.binding,
          revision: data.revision,
          defaultRevision: data.defaultRevision || previous.defaultRevision,
        }));
        setResult(data);
        setSelected(null);
      }
    } catch (reason) {
      if (!signal.aborted) {
        reason.retryBinding = { remove, defaultWiki };
        setError(reason);
      }
    } finally {
      saving.current = false;
      if (!signal.aborted) {
        setBusy(null);
      }
    }
  };
  const locked = !!busy || disabled || bindingListBusy;
  let retryLabel = t('common.retry');
  if (error?.retryBinding?.remove) {
    retryLabel = text('targetRetryRemove');
  } else if (error?.retryBinding?.defaultWiki) {
    retryLabel = text('defaultWikiRetrySaveAll');
  } else if (error?.retryBinding) {
    retryLabel = text('targetRetrySave');
  }
  const trail = browser?.trail || [];
  const parent = trail.at(-1);
  const workspaceNames = (workspaces || []).map((item) => item.title || item.id);
  const field = (key, control) =>
    h(
      'div',
      { className: `${form.field} ${layout.configurationField}` },
      h('span', { className: form.fieldTitle, id: `${id}-${key}` }, text(key)),
      control,
    );
  const refreshWorkspaces = h(
    Button,
    {
      disabled: locked,
      size: 'sm',
      onClick: () => setWorkspaceReload((value) => value + 1),
    },
    text('browseWorkspacesRefresh'),
  );
  const changeSpacePage = async (next) => {
    if (locked) {
      return;
    }
    if (spacePages[next]) {
      setBrowser({ ...spacePages[next], trail: [] });
      setSpacePage(next);
      setResult(null);
      setError(null);
      return;
    }
    const signal = owner.current.signal;
    const options = await loadLevel([], browser.pageToken);
    if (options && !signal.aborted) {
      setSpacePages((previous) => [...previous, options]);
      setSpacePage(next);
    }
  };
  const switchMode = (next) => {
    setUseDefault(next);
    if (next) {
      setType('wiki');
    }
    setResult(null);
    setError(null);
  };
  const modePicker = h(
    'div',
    { className: layout.modeOptions, role: 'radiogroup', 'aria-label': text('targetMode') },
    [true, false].map((value) =>
      h(
        'label',
        { key: String(value), className: layout.mode },
        h('input', {
          type: 'radio',
          name: `${id}-mode`,
          checked: defaultWiki === value,
          disabled: locked,
          'aria-label': text(value ? 'defaultMode' : 'manualMode'),
          onChange: () => switchMode(value),
        }),
        text(value ? 'defaultMode' : 'manualMode'),
      ),
    ),
  );
  const workspacePicker = field(
    'browseWorkspace',
    h(
      'div',
      { className: layout.fieldActions },
      h(Select, {
        'aria-labelledby': `${id}-browseWorkspace`,
        'aria-label': text('browseWorkspace'),
        className: form.zoneSelect,
        searchable: true,
        disabled: locked || !workspaces?.length,
        value: workspace,
        options: (workspaces || []).map((item) => ({
          id: item.id,
          label: item.title || item.id,
          title: item.path,
        })),
        onChange: (event) => setWorkspace(event.target.value),
      }),
      refreshWorkspaces,
    ),
  );
  let spaceOptions = browser?.items || [];
  if (defaultSpace && !spaceOptions.some((item) => item.token === defaultSpace.item.token)) {
    spaceOptions = [defaultSpace.item, ...spaceOptions];
  }
  const defaultPicker = h(
    React.Fragment,
    null,
    field(
      'spaceLabel',
      h(
        'div',
        { className: layout.fieldActions },
        h(Select, {
          'aria-labelledby': `${id}-spaceLabel`,
          'aria-label': text('spaceLabel'),
          className: form.zoneSelect,
          value: defaultSpace?.item.token || '',
          searchable: true,
          placeholder: text('spacePlaceholder'),
          disabled: locked || !browser,
          options: spaceOptions.map((item) => ({ id: item.token, label: item.title })),
          onChange: (event) => {
            const item = spaceOptions.find((entry) => entry.token === event.target.value);
            if (item) {
              choose(item, [item]);
            }
          },
        }),
        h(
          Button,
          { disabled: locked, size: 'sm', onClick: () => setReload((value) => value + 1) },
          text('refreshSpaces'),
        ),
      ),
    ),
    browser &&
      !browser.items.length &&
      !browser.hasMore &&
      !defaultSpace &&
      h('p', { className: form.muted }, text('spacesEmpty')),
    browser &&
      (spacePages.length > 1 || browser.hasMore) &&
      h(
        'div',
        { className: layout.pager },
        h('span', { className: form.muted }, t('lark.spacePage', { page: spacePage + 1 })),
        h(
          Button,
          {
            size: 'sm',
            disabled: locked || spacePage === 0,
            onClick: () => changeSpacePage(spacePage - 1),
          },
          t('pagination.previous'),
        ),
        h(
          Button,
          {
            size: 'sm',
            disabled: locked || (!browser.hasMore && spacePage + 1 >= spacePages.length),
            onClick: () => changeSpacePage(spacePage + 1),
          },
          t('pagination.next'),
        ),
      ),
    h(
      'div',
      { className: layout.summary },
      h('p', { className: form.muted }, t('lark.defaultScope', { count: workspaceNames.length })),
      h(
        Disclosure,
        {
          compact: true,
          lazy: true,
          title: t('lark.workspaceList', { count: workspaceNames.length }),
        },
        h(LarkWorkspaceBindings, {
          revision: JSON.stringify([workspaces, values?.defaultRevision]),
          disabled: !!busy || disabled,
          onBusyChange: setBindingListBusy,
          onRemoved: (workspaceId, data) => {
            setValues(
              (previous) =>
                previous && {
                  ...previous,
                  ...(workspaceId === workspace ? { binding: null, revision: null } : {}),
                  defaultRevision: data.defaultRevision,
                },
            );
          },
        }),
      ),
      defaultSpace &&
        h(
          'p',
          { className: form.muted },
          t('lark.defaultWikiPreview', {
            space: defaultSpace.item.title,
            count: workspaceNames.length,
          }),
        ),
    ),
  );
  const breadcrumbs = [
    { label: text('targetType.' + type), depth: 0 },
    ...trail.map((item, index) => ({ label: item.title, depth: index + 1 })),
  ];
  const manualBrowser =
    browser &&
    h(
      'div',
      { className: form.section },
      h(
        'div',
        { className: css.breadcrumb },
        h(Breadcrumb, {
          items: breadcrumbs,
          onNavigate: (item) => {
            if (!locked) {
              void loadLevel(trail.slice(0, item.depth));
            }
          },
        }),
      ),
      h(
        'div',
        { className: layout.actions },
        h(
          Button,
          {
            size: 'sm',
            disabled: locked || !trail.length,
            onClick: () => loadLevel(trail.slice(0, -1)),
          },
          text('browseUp'),
        ),
        h(
          Button,
          { size: 'sm', disabled: locked, onClick: () => loadLevel(trail) },
          text('browseRefresh'),
        ),
        parent &&
          parent.kind !== 'space' &&
          h(
            Button,
            { size: 'sm', disabled: locked, onClick: () => choose(parent, trail) },
            text(type === 'wiki' ? 'browseChooseNode' : 'browseChooseFolder'),
          ),
      ),
      !browser.items.length &&
        !browser.hasMore &&
        h('p', { className: form.muted }, text('browseEmpty')),
      h(
        PagedList,
        {
          className: css.list,
          rowHeight: 44,
          inspect: false,
          resetKey: JSON.stringify([workspace, type, trail.map((item) => item.token)]),
          hasMore: browser.hasMore,
          busy: !!busy,
          onMore: () => loadLevel(trail, browser.pageToken, true),
        },
        browser.items.map((item) =>
          h(
            'div',
            { key: item.kind + ':' + item.token, className: css.row },
            item.kind !== 'space'
              ? h('input', {
                  type: 'radio',
                  name: `${id}-destination`,
                  className: css.radio,
                  'aria-label': t('lark.browseChoose', { title: item.title }),
                  checked: selected?.item.token === item.token && selected?.item.kind === item.kind,
                  disabled: locked,
                  onChange: () => choose(item, [...trail, item]),
                })
              : h('span', { className: css.spacer, 'aria-hidden': true }),
            h(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                className: css.name,
                disabled: locked,
                'aria-label': t('lark.browseOpen', { title: item.title }),
                onClick: () => loadLevel([...trail, item]),
              },
              item.title,
            ),
          ),
        ),
      ),
      selected &&
        h(
          'p',
          { className: form.muted },
          t('lark.browseSelected', {
            path: selected.trail.map((item) => item.title).join(' / '),
          }),
        ),
    );
  const manualPicker = h(
    React.Fragment,
    null,
    workspacePicker,
    h(
      'div',
      { className: layout.summary },
      h(
        'p',
        { className: form.muted },
        values?.binding
          ? t('lark.targetBound', {
              title: values.binding.title,
              type: text('targetType.' + values.binding.kind),
            })
          : text('notBound'),
      ),
      values?.binding &&
        h(
          SettingsActionBar,
          null,
          h(
            Button,
            { tone: 'danger', disabled: locked, onClick: () => bind(true) },
            text('targetRemove'),
          ),
        ),
    ),
    values &&
      !values.binding &&
      field(
        'browseType',
        h(Select, {
          'aria-labelledby': `${id}-browseType`,
          'aria-label': text('browseType'),
          className: form.zoneSelect,
          searchable: false,
          disabled: locked,
          value: type,
          options: ['folder', 'wiki'].map((kind) => ({
            id: kind,
            label: text('targetType.' + kind),
          })),
          onChange: (event) => setType(event.target.value),
        }),
      ),
    values && !values.binding && manualBrowser,
  );
  return h(
    'section',
    { className: layout.group, 'aria-labelledby': `${id}-title` },
    h(
      'div',
      { className: layout.header },
      h('h3', { id: `${id}-title` }, text('publishTitle')),
      h(
        'div',
        { className: layout.actions },
        h(HoverCard, {
          surfaceClassName: form.helpBubble,
          anchor: h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              className: form.helpButton,
              'aria-label': text('targetHelp'),
            },
            h(IconInfo, { size: 14 }),
          ),
          content: text(defaultWiki ? 'defaultWikiNotice' : 'targetReadOnly'),
        }),
        (defaultWiki || !workspaces?.length) && refreshWorkspaces,
      ),
    ),
    modePicker,
    h('p', { className: form.muted }, text(defaultWiki ? 'defaultIntro' : 'manualIntro')),
    !workspaces && !error && h('p', { role: 'status', className: form.muted }, text('loading')),
    workspaces?.length === 0 && h('p', { className: form.muted }, text('targetNoWorkspace')),
    workspaces?.length > 0 &&
      h(
        React.Fragment,
        null,
        defaultWiki ? defaultPicker : manualPicker,
        busy === 'browse' &&
          h('p', { role: 'status', className: form.muted }, text('browseLoading')),
        (defaultWiki || (values && !values.binding)) &&
          h(
            SettingsActionBar,
            null,
            h(
              Button,
              {
                variant: 'primary',
                disabled: locked || !values || !activeSelection,
                onClick: () => bind(),
              },
              text(defaultWiki ? 'defaultWikiSaveAll' : 'targetSave'),
            ),
            busy === 'save' &&
              h(
                'span',
                { role: 'status', className: form.muted },
                text(defaultWiki ? 'defaultWikiSaving' : 'targetSaving'),
              ),
          ),
      ),
    disabled &&
      h(
        'p',
        { className: form.muted },
        text(connectionBusy ? 'targetConnectionBusy' : 'targetSaveConnection'),
      ),
    error &&
      h(
        'div',
        { role: 'alert', className: layout.status },
        h('p', { className: form.error }, message(error.message || error)),
        h(LarkErrorDetails, { code: error.message, details: error.details }),
      ),
    error &&
      h(
        SettingsActionBar,
        null,
        h(
          Button,
          {
            disabled: locked,
            onClick: () => {
              if (error.retryBinding) {
                void bind(error.retryBinding.remove);
                return;
              }
              if (!workspaces) {
                setWorkspaceReload((value) => value + 1);
              } else {
                setReload((value) => value + 1);
              }
            },
          },
          retryLabel,
        ),
      ),
    result &&
      h(
        'p',
        { role: 'status', className: form.muted },
        result.total !== undefined
          ? t('lark.defaultWikiResult', {
              total: result.total,
              created: result.created,
              reused: result.reused,
            })
          : message(result.code),
      ),
  );
}
module.exports = { LarkTargetSettings };
