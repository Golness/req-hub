'use strict';

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Estimate only the current chunk queue; later model stages have no measured rate. */
function estimateSyncTiming(sync, now = Date.now()) {
  const end = Number.isFinite(sync.completedAt) ? sync.completedAt : now;
  const elapsedMs = Number.isFinite(sync.startedAt) ? Math.max(0, end - sync.startedAt) : null;
  const result = { elapsedMs, state: 'unknown' };
  if (!['running', 'preparing', 'cancelling'].includes(sync.status)) return { ...result, state: 'terminal' };
  if (sync.status === 'cancelling') return { ...result, state: 'cancelling' };
  const step = sync.steps?.find(item => item.status === 'running');
  if (!['code_analysis', 'discussion_analysis'].includes(step?.phase)) return result;
  const chunks = (step.chunks || []).filter(Boolean);
  const hasWeight = chunk => Number.isFinite(chunk.tokens) && chunk.tokens > 0;
  const remaining = chunks.filter(chunk => ['pending', 'queued', 'running'].includes(chunk.status || 'pending'));
  if (chunks.some(chunk => ['failed', 'aborted'].includes(chunk.status))) return result;
  if (chunks.length && !remaining.length) return { ...result, state: 'summarizing' };
  const samples = chunks.filter(chunk => chunk.status === 'completed' && hasWeight(chunk)
    && Number.isFinite(chunk.startedAt) && Number.isFinite(chunk.completedAt) && chunk.completedAt > chunk.startedAt && chunk.completedAt <= now);
  if (samples.length < 2 || !Number.isInteger(step.concurrency) || step.concurrency < 1 || remaining.some(chunk => !hasWeight(chunk))) return result;
  const rates = samples.map(chunk => (chunk.completedAt - chunk.startedAt) / chunk.tokens);
  if (Math.max(...rates) / Math.min(...rates) > 4) return result;
  const rate = median(rates), lowRate = Math.min(...rates, rate) * 0.75, highRate = Math.max(...rates, rate) * 1.5;
  const running = remaining.filter(chunk => chunk.status === 'running');
  if (running.length > step.concurrency || running.some(chunk => !Number.isFinite(chunk.startedAt) || chunk.startedAt > now)) return result;
  if (running.some(chunk => now - chunk.startedAt >= chunk.tokens * highRate)) return { ...result, state: 'overrun' };
  const simulate = speed => {
    const lanes = running.map(chunk => Math.max(0, chunk.tokens * speed - Math.max(0, now - chunk.startedAt)));
    while (lanes.length < step.concurrency) lanes.push(0);
    for (const chunk of remaining.filter(chunk => chunk.status !== 'running')) {
      const lane = lanes.indexOf(Math.min(...lanes));
      lanes[lane] += chunk.tokens * speed;
    }
    return Math.max(...lanes);
  };
  return { ...result, state: 'estimated', phase: step.phase, lowerMs: Math.max(1000, simulate(lowRate)), upperMs: Math.max(1000, simulate(highRate)) };
}

module.exports = { estimateSyncTiming };
