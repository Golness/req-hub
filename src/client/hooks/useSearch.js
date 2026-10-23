'use strict';
const { useState, useEffect, useRef } = require('react');
const { knowledgeRequest } = require('./useKnowledge.js');

function useSearch() {
  const [state, setState] = useState({ results: [], loading: false, error: null, searched: false, knowledgeReady: null, hasMore: false });
  const controller = useRef(null);
  const version = useRef(0);
  useEffect(() => {
    version.current++; controller.current?.abort();
    setState({ results: [], loading: false, error: null, searched: false, knowledgeReady: null, hasMore: false });
    const abort = new AbortController();
    knowledgeRequest('/search/status', null, null, abort.signal).then(status => {
      if (!abort.signal.aborted) setState(old => ({ ...old, knowledgeReady: status.ready, warnings: status.warnings || [] }));
    }).catch(error => { if (!abort.signal.aborted) setState(old => ({ ...old, error: error.message })); });
    return () => { abort.abort(); controller.current?.abort(); version.current++; };
  }, []);
  const handleSearch = async (query, limit = 20) => {
    if (!query.trim()) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const token = ++version.current;
    setState(old => ({ ...old, loading: true, error: null, searched: true }));
    try {
      const data = await knowledgeRequest(`/search?q=${encodeURIComponent(query.trim())}&limit=${limit}`, null, null, abort.signal);
      if (token === version.current) setState({ results: data.hits || [], hasMore: data.hasMore, knowledgeReady: data.knowledgeReady, warnings: data.warnings || [], searched: true, loading: false, error: null });
    } catch (error) {
      if (!abort.signal.aborted && token === version.current) setState(old => ({ ...old, error: error.message, loading: false }));
    }
  };
  return { ...state, handleSearch };
}
module.exports = { useSearch };
