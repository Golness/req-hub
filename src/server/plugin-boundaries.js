/** Reuse Connection's authentication, including its Host/Origin policy. */
export function authenticatedRoute(connection, route) {
  return { ...route, async handler(req, res) {
    if (!connection?.admit) { res.writeHead(503); res.end('connection unavailable'); return; }
    const admission = connection.admit(req);
    if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden'); return; }
    return route.handler(req, res);
  } };
}

/** Await every owner even when an earlier owner fails to close. */
export async function disposeAll(disposers) {
  const errors = [];
  for (const dispose of disposers) { try { await dispose(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, 'ReqHub resource cleanup failed');
}
