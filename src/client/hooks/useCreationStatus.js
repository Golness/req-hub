'use strict';
const React = require('react');
const { useState, useEffect, useRef } = React;
const clientApi = require('../api/index.js');
const { showToast } = require('../components/shared/ToastContainer.js');
const { t } = require('../locale.js');
/**
 * Own branch creation availability and its explicit refresh requests.
 * @param options - Current workspace, requirement and successful open callback.
 * @returns Creation status, notices and cancellable refresh actions.
 */
function useCreationStatus({ workspace, docsDir, selectedReq, onOpen }) {
  const [creationStatus, setCreationStatus] = useState(null);
  const [creationNotice, setCreationNotice] = useState(null);
  const createRequest = useRef(null);
  const [creationRefresh, setCreationRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setCreationStatus(null);
    setCreationNotice(null);
    clientApi
      .request(
        clientApi.endpoint('create-status', `workspaceId=${encodeURIComponent(workspace.id)}`),
        {
          signal: controller.signal,
          cache: 'no-store',
        },
      )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!controller.signal.aborted) {
          setCreationStatus(data);
        }
      })
      .catch((error) => {
        // Creation status is optional; keep creation unavailable until a later successful refresh.
      });
    return () => {
      controller.abort();
      createRequest.current?.abort();
    };
  }, [workspace.id, docsDir, selectedReq?.id, creationRefresh]);
  const openCreation = async () => {
    createRequest.current?.abort();
    const controller = new AbortController();
    createRequest.current = controller;
    try {
      const res = await clientApi.request(
        clientApi.endpoint('create-status', `workspaceId=${encodeURIComponent(workspace.id)}`),
        { signal: controller.signal, cache: 'no-store' },
      );
      if (!res.ok) {
        throw new Error('CREATE_FAILED');
      }
      const data = await res.json();
      if (controller.signal.aborted) {
        return;
      }
      setCreationStatus(data);
      if (data.existingRequirement) {
        setCreationNotice(data);
        return;
      }
      setCreationRefresh((value) => value + 1);
      onOpen();
    } catch {
      if (!controller.signal.aborted) {
        showToast({ tone: 'error', text: t('create.statusFailed') });
      }
    }
  };

  return {
    creationStatus,
    creationNotice,
    creationRefresh,
    setCreationNotice,
    setCreationRefresh,
    openCreation,
  };
}
module.exports = { useCreationStatus };
