/**
 * Reuse Connection's authentication, including its Host/Origin policy.
 * @param connection - The Host Connection admission service.
 * @param route - The route to protect with admission checks.
 * @returns A route that rejects requests denied by the Connection.
 */
export function authenticatedRoute(connection, route) {
  return {
    ...route,
    async handler(req, res) {
      if (!connection?.admit) {
        res.writeHead(503);
        res.end('connection unavailable');
        return;
      }
      const admission = connection.admit(req);
      if ('rejection' in admission) {
        res.writeHead(admission.rejection);
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      return route.handler(req, res);
    },
  };
}

/**
 * Await every owner even when an earlier owner fails to close.
 * @param disposers - Cleanup callbacks, including asynchronous callbacks.
 * @returns Completion after all disposers settle; collected failures reject as AggregateError.
 */
export async function disposeAll(disposers) {
  const errors = [];
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, 'ReqHub resource cleanup failed');
  }
}

/**
 * Own acquisitions before initialization starts. Stop admission first, cancel all producers,
 * then release resources in reverse acquisition order, awaiting every cleanup even on failure.
 * @returns An owner whose close method is idempotent, including failed initialization.
 */
export function createLifecycle() {
  const admissions = [];
  const resources = [];
  const stoppers = [];
  const pending = new Set();
  let closing;
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    own(dispose, stop) {
      resources.push(dispose);
      if (stop) {
        stoppers.push(stop);
      }
    },
    admit(dispose) {
      admissions.push(dispose);
    },
    run(callback) {
      if (closed) {
        return Promise.reject(new Error('REQ_HUB_CLOSED'));
      }
      const work = Promise.resolve().then(() => {
        if (closed) {
          throw new Error('REQ_HUB_CLOSED');
        }
        return callback();
      });
      pending.add(work);
      return work.finally(() => pending.delete(work));
    },
    close() {
      closed = true;
      closing ||= disposeAll([
        ...admissions.toReversed(),
        ...stoppers.toReversed(),
        ...resources.toReversed(),
        () => Promise.allSettled([...pending]),
      ]);
      return closing;
    },
  };
}
