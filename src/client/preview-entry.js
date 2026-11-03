/**
 * Standalone preview entry — exports components for browser preview.
 * Not part of the DSH plugin; only used by screenshot scripts.
 *
 * This file is built separately as an IIFE bundle with React as external,
 * exposing window.__ReqHubPreview__ with all component constructors.
 */
'use strict';

const React = require('react');
const h = React.createElement;

// Load all plugin CSS (injected as <style> tags by the build)
require('./styles/tokens.css');
require('./styles/base.css');
require('./styles/layout.css');
require('./styles/components.css');
require('./styles/buttons.css');
require('./styles/selects.css');
require('./styles/markdown.css');
require('./styles/animations.css');

const { CreateDirForm } = require('./components/CreateDirForm.js');
const { RequirementDirModal } = require('./components/RequirementDirModal.js');
const { WorkspaceModal } = require('./components/WorkspaceModal.js');
const { DocsViewerContext } = require('./context.js');
const { installLocale } = require('./locale.js');
const { showToast } = require('./components/shared/ToastContainer.js');

// Install locale immediately (normally done by Cordis apply)
installLocale({
  locale: {
    register: () => {},
    get: () => ({ lang: 'zh-CN' }),
  },
});

// Expose everything on a global
window.__ReqHubPreview__ = {
  React,
  h,
  CreateDirForm,
  RequirementDirModal,
  WorkspaceModal,
  DocsViewerContext,
  showToast,
};
