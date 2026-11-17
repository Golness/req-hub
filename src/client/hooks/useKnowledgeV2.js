'use strict';
const clientApi = require('../api/index.js');
const { useState, useEffect, useRef } = require('react');
const { t, hasLocaleKey } = require('../locale.js');
const { localizeMessage } = require('../utils/serverMessage.js');

const ACTIVE = ['queued', 'running', 'cancelling'];

/**
 * Call the knowledge-v2 API and surface Host error codes with structured details.
 * @param path - The API path under /knowledge-v2.
 * @param workspaceId - Workspace owning the current operation.
 * @param body - Request payload; null or undefined selects a read operation.
 * @param signal - Cancellation for this request.
 * @returns Parsed response data; HTTP failures reject with code and details attached.
 */
async function knowledgeV2Request(path, workspaceId, body, signal) {
  return clientApi.scopedRequest('knowledge-v2', path, workspaceId, body, signal);
}

/**
 * Translate a Host error code; unknown codes keep their raw value visible.
 * @param error - A rejected knowledgeV2Request error or plain Error.
 * @returns Localized user-facing text.
 */
function knowledgeV2ErrorText(error) {
  const code = error?.code || error?.message;
  if (code && hasLocaleKey(`kb.error.${code}`)) {
    return t(`kb.error.${code}`, error?.details);
  }
  return t('kb.error.generic', { code: localizeMessage(error) || 'UNKNOWN' });
}

/**
 * Own the workspace job list, polling only while a job is active.
 * @param workspaceId - Workspace owning the jobs.
 * @param active - Whether the owning surface is visible; hidden surfaces keep last state.
 * @returns Job state and cancel/resume/refresh actions.
 */
function useKnowledgeJobs(workspaceId, active = true) {
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const token = ++generation.current;
    const controller = new AbortController();
    let timer;
    const load = async () => {
      try {
        const data = await knowledgeV2Request('/jobs', workspaceId, null, controller.signal);
        if (generation.current !== token) {
          return;
        }
        setJobs(data.jobs || []);
        setError(null);
        if ((data.jobs || []).some((job) => ACTIVE.includes(job.status))) {
          timer = setTimeout(load, 1500);
        }
      } catch (failure) {
        if (!controller.signal.aborted && generation.current === token) {
          setError(failure);
        }
      }
    };
    load();
    return () => {
      generation.current++;
      controller.abort();
      clearTimeout(timer);
    };
  }, [workspaceId, active, revision]);
  const cancel = async (id) => {
    await knowledgeV2Request(`/jobs/${encodeURIComponent(id)}/cancel`, workspaceId, {});
    setRevision((value) => value + 1);
  };
  const resume = async (id) => {
    await knowledgeV2Request(`/jobs/${encodeURIComponent(id)}/resume`, workspaceId, {});
    setRevision((value) => value + 1);
  };
  return {
    jobs,
    error,
    cancel,
    resume,
    refresh: () => setRevision((value) => value + 1),
    running: jobs.some((job) => ACTIVE.includes(job.status)),
    activeCount: jobs.filter((job) => ACTIVE.includes(job.status)).length,
  };
}

module.exports = { knowledgeV2Request, knowledgeV2ErrorText, useKnowledgeJobs, ACTIVE };
