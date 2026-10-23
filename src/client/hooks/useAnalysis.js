'use strict';

/**
 * @module useAnalysis
 * @description Custom React hook that encapsulates analysis logic for the AnalyzePanel component.
 * Manages streaming analysis via Server-Sent Events (SSE), status tracking, cancellation, and state restoration.
 */

const React = require('react');
const { useState, useRef, useEffect } = React;
const { ROUTE } = require('../constants.js');
const { DocsViewerContext } = require('../context.js');

/**
 * @hook useAnalysis
 * @description Manages the full lifecycle of document analysis including starting, streaming progress,
 * cancelling, and restoring analysis state. Supports both single-requirement and full-workspace analysis modes.
 * @param {string} workspaceId - The unique identifier of the workspace to analyze.
 * @param {Object|null} selectedReq - The currently selected requirement object, or null for full-workspace analysis.
 * @param {string} selectedReq.id - The unique identifier of the selected requirement.
 * @returns {Object} An object containing analysis state and control functions:
 * @returns {boolean} returns.analyzing - Whether an analysis is currently in progress.
 * @returns {string|null} returns.analysisMode - The current analysis mode ('single' or 'full').
 * @returns {Object} returns.analysisStatus - A map of file IDs to their analysis status objects.
 * @returns {string|null} returns.error - Error message if an error occurred, or null.
 * @returns {string|null} returns.success - Success message upon completion, or null.
 * @returns {Function} returns.startAnalysis - Function to start a new analysis with a given mode.
 * @returns {Function} returns.cancelAnalysis - Function to cancel the ongoing analysis.
 * @returns {Function} returns.restoreAnalysis - Function to restore analysis state from server data.
 */
function useAnalysis(workspaceId, selectedReq) {
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisMode, setAnalysisMode] = useState(null);
  const [analysisStatus, setAnalysisStatus] = useState({});
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const eventSourceRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const { refreshTree, refreshSelectedReq } = React.useContext(DocsViewerContext);

  const startAnalysis = async (mode) => {
    setAnalysisMode(mode);
    setAnalyzing(true);
    setError(null);
    setSuccess(null);

    // Get preview files first
    const url = mode === 'single' && selectedReq
      ? `${ROUTE}/analyze-preview?workspaceId=${encodeURIComponent(workspaceId)}&requirementId=${encodeURIComponent(selectedReq.id)}`
      : `${ROUTE}/analyze-preview?workspaceId=${encodeURIComponent(workspaceId)}`;

    let previewData;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('获取预览失败');
      previewData = await res.json();
    } catch (e) {
      setError(String(e));
      setAnalyzing(false);
      return;
    }

    // Initialize status for all files
    const initialStatus = {};
    for (const f of previewData.files) {
      initialStatus[f.id] = { status: 'pending' };
    }
    setAnalysisStatus(initialStatus);

    // Start streaming analysis
    // 获取当前会话 ID（分析功能需要在 DSH 会话中调用）
    let currentSessionId = '';
    try {
      const ctx = window.__DSH_CTX__;
      if (ctx) {
        const uiWorkspace = ctx.get?.('uiWorkspace');
        if (uiWorkspace?.selection && typeof uiWorkspace.selection.getSnapshot === 'function') {
          const selection = uiWorkspace.selection.getSnapshot();
          if (selection?.sessionId) {
            currentSessionId = selection.sessionId;
          }
        }
      }
    } catch (e) {
      // 忽略错误
    }

    if (!currentSessionId) {
      setError('分析功能需要在活跃的 DSH 会话中调用');
      setAnalyzing(false);
      return;
    }

    const streamUrl = mode === 'single' && selectedReq
      ? `${ROUTE}/analyze-stream?workspaceId=${encodeURIComponent(workspaceId)}&requirementId=${encodeURIComponent(selectedReq.id)}&sessionId=${encodeURIComponent(currentSessionId)}`
      : `${ROUTE}/analyze-stream?workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(currentSessionId)}`;

    try {
      const eventSource = new EventSource(streamUrl);
      eventSourceRef.current = eventSource;

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'start') {
          setAnalysisStatus(prev => ({
            ...prev,
            [data.id]: { status: 'analyzing' }
          }));
        } else if (data.type === 'completed') {
          setAnalysisStatus(prev => ({
            ...prev,
            [data.id]: { status: 'completed', elapsed: data.elapsed }
          }));
        } else if (data.type === 'failed') {
          setAnalysisStatus(prev => ({
            ...prev,
            [data.id]: { status: 'failed', error: data.error }
          }));
        } else if (data.type === 'cancelled') {
          // Server acknowledged cancellation
          setAnalysisStatus(prev => {
            const next = { ...prev };
            for (const key of Object.keys(next)) {
              if (next[key].status === 'pending' || next[key].status === 'analyzing') {
                next[key] = { status: 'cancelled' };
              }
            }
            return next;
          });
          setSuccess(`分析已终止: ${data.success}/${data.total} 完成 (${data.elapsed}s)`);
          refreshTree();
          eventSource.close();
          eventSourceRef.current = null;
          setAnalyzing(false);
        } else if (data.type === 'done') {
          setSuccess(`${mode === 'single' ? '当前需求' : '全量'}分析完成: ${data.success}/${data.total} 成功 (${data.elapsed}s)`);
          refreshTree();
          // Refresh selectedReq to update hasMeta status
          refreshSelectedReq();
          eventSource.close();
          eventSourceRef.current = null;
          setAnalyzing(false);
        } else if (data.type === 'error') {
          setError(data.error);
          eventSource.close();
          eventSourceRef.current = null;
          setAnalyzing(false);
        }
      };

      eventSource.onerror = () => {
        // If user cancelled, don't show error
        if (!eventSourceRef.current) return;
        setError('连接中断');
        eventSource.close();
        eventSourceRef.current = null;
        setAnalyzing(false);
      };
    } catch (e) {
      setError(String(e));
      setAnalyzing(false);
    }
  };

  const cancelAnalysis = async () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    // Mark all pending/analyzing as cancelled
    setAnalysisStatus(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (next[key].status === 'pending' || next[key].status === 'analyzing') {
          next[key] = { status: 'cancelled' };
        }
      }
      return next;
    });
    setSuccess('分析已终止');
    setAnalyzing(false);
    refreshTree();
    // Notify server to stop processing
    try {
      await fetch(`${ROUTE}/analysis-cancel`, { method: 'POST' });
    } catch (e) {
      console.error('Failed to cancel analysis on server:', e);
    }
  };

  const restoreAnalysis = async (taskData) => {
    // Restore analysis state from server
    setAnalyzing(true);
    setAnalysisMode(taskData.mode);
    setAnalysisStatus(taskData.status);

    // Poll for status updates instead of reconnecting to SSE
    // (Reconnecting SSE would start a new analysis task!)
    const pollStatus = async () => {
      try {
        const res = await fetch(`${ROUTE}/analysis-status`);
        if (res.ok) {
          const data = await res.json();
          if (data.active) {
            setAnalysisStatus(data.status);
            return { continue: true, data };
          } else {
            // Task completed
            setAnalyzing(false);
            setSuccess(`分析完成: ${data.successCount || '?'}/${data.totalCount || '?'} 成功`);
            refreshTree();
            refreshSelectedReq();
            return { continue: false, data };
          }
        }
      } catch (e) {
        console.error('Poll error:', e);
      }
      return { continue: false, data: null };
    };

    // Initial poll
    const { continue: shouldContinue, data: initialData } = await pollStatus();

    // Return files for caller to use
    const files = initialData?.files || taskData.files || [];

    // Set up polling interval if task is still active
    if (shouldContinue) {
      pollIntervalRef.current = setInterval(async () => {
        const { continue: keepPolling } = await pollStatus();
        if (!keepPolling && pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      }, 2000); // Poll every 2 seconds
    }

    return files;
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

  return {
    analyzing,
    analysisMode,
    analysisStatus,
    error,
    success,
    startAnalysis,
    cancelAnalysis,
    restoreAnalysis,
  };
}

module.exports = { useAnalysis };
