'use strict';
const { useState, useEffect, useRef } = require('react');
const clientApi = require('../api/index.js');
/**
 * Own requirement restoration, counts and optional commit hints for one viewer.
 * @param options - Explicit selection inputs and revision guards.
 * @returns Catalog metadata; stale requests cannot replace a newer selection.
 */
function useRequirementCatalog({
  workspace,
  docsDir,
  selectedReq,
  selectedFile,
  activePanel,
  initialReqId,
  initialLocation,
  selectionRevision,
  focusedSyncRef,
  setSelectedReq,
}) {
  const [syncHint, setSyncHint] = useState(null);
  const [totalReqs, setTotalReqs] = useState(0);
  // Recheck on returning home; only confirmed commits for this exact selection show a sync action.
  const syncHintKey = JSON.stringify([workspace.id, docsDir, selectedReq?.id]);
  const hasSyncCommits = syncHint?.key === syncHintKey && syncHint.hasCommits;
  useEffect(() => {
    if (!selectedReq || activePanel || selectedFile) {
      return;
    }
    const controller = new AbortController();
    setSyncHint(null);
    const params = new URLSearchParams({
      workspaceId: workspace.id,
      requirementId: selectedReq.id,
    });
    clientApi
      .request(clientApi.endpoint('sync-commits', `${params}`), { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!controller.signal.aborted) {
          setSyncHint({
            key: syncHintKey,
            hasCommits: Array.isArray(data?.commits) && data.commits.length > 0,
          });
        }
      })
      .catch((error) => {
        // An unavailable commit hint must not expose a sync action without confirmed commits.
      });
    return () => controller.abort();
  }, [syncHintKey, activePanel, selectedFile]);

  // Auto-select requirement from config (initialReqId) or first available
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (initialLocation) {
      isInitialMount.current = false;
      return;
    }
    const controller = new AbortController();
    const revision = selectionRevision.current;
    (async () => {
      try {
        const res = await clientApi.request(
          clientApi.endpoint(
            'tree',
            `workspaceId=${encodeURIComponent(workspace.id)}&t=${Date.now()}`,
          ),
          { signal: controller.signal },
        );
        if (!res.ok) {
          return;
        }
        const data = await res.json();
        if (
          controller.signal.aborted ||
          revision !== selectionRevision.current ||
          !data.tree?.developers
        ) {
          return;
        }

        let found = null;

        // Try to restore from config
        const restoreId =
          focusedSyncRef.current?.workspaceId === workspace.id
            ? focusedSyncRef.current.requirementId
            : initialReqId;
        if (restoreId) {
          for (const dev of data.tree.developers) {
            for (const req of dev.requirements) {
              if (req.id === restoreId) {
                found = { ...req, developer: dev.name };
                break;
              }
            }
            if (found) {
              break;
            }
          }
        }

        // Fallback: first requirement of first developer (only on initial mount)
        if (!found && isInitialMount.current && data.tree.developers.length > 0) {
          const firstDev = data.tree.developers[0];
          if (firstDev.requirements.length > 0) {
            found = { ...firstDev.requirements[0], developer: firstDev.name };
          }
        }

        isInitialMount.current = false;

        if (found) {
          setSelectedReq(found);
        } else {
          setSelectedReq(null);
        }
      } catch (error) {
        // Keep the current selection when the saved requirement cannot be restored.
      }
    })();
    return () => {
      controller.abort();
    };
  }, [workspace.id, initialReqId, initialLocation]);

  // Fetch total requirements count
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await clientApi.request(
          clientApi.endpoint(
            'tree',
            `workspaceId=${encodeURIComponent(workspace.id)}&t=${Date.now()}`,
          ),
          { signal: controller.signal },
        );
        if (res.ok) {
          const data = await res.json();
          if (!controller.signal.aborted) {
            setTotalReqs(data.totalRequirements || 0);
          }
        }
      } catch (error) {
        // Requirement counts are optional; keep the last available count on refresh failure.
      }
    })();
    return () => {
      controller.abort();
    };
  }, [workspace.id]);

  return { totalReqs, hasSyncCommits, isInitialMount };
}
module.exports = { useRequirementCatalog };
