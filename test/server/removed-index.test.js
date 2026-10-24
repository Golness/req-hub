import { expect, it } from 'vitest';
import model from '../../src/shared/sync-task.cjs';
import { createTreeRoutes } from '../../src/server/routes/tree-routes.js';
import { PROMPT_REGISTRY } from '../../src/server/prompts.js';

it('keeps document routes without exposing legacy index maintenance or field lookup', () => {
  const routes = createTreeRoutes({ list: () => [] });
  const paths = routes.map(route => route.path);
  for (const path of ['rebuild-index', 'index-status', 'index-data', 'fields/']) {
    expect(paths.some(candidate => candidate?.includes(path))).toBe(false);
  }
  expect(paths).toContain('/req-hub/tree');
  expect(paths).toContain('/req-hub/file-tree');
  expect(PROMPT_REGISTRY).not.toHaveProperty('search');
  expect(PROMPT_REGISTRY).toHaveProperty('writing');
  expect(PROMPT_REGISTRY).toHaveProperty('analyze');
});

it('ignores removed post-sync flags while retaining historical tasks', () => {
  const steps = model.createSyncSteps({ runIndex: true, runAnalysis: true });
  expect(steps.map(step => step.phase)).not.toContain('index');
  expect(steps.map(step => step.phase)).not.toContain('analysis');
  expect(steps.at(-1).phase).toBe('publish');
  const historical = {
    status: 'completed', completedAt: 123,
    steps: [{ phase: 'index', label: '构建索引', status: 'completed' }],
  };
  model.repairSyncTask(historical);
  expect(historical.status).toBe('completed');
  expect(historical.steps[0].status).toBe('completed');
  expect(historical.completedAt).toBe(123);
});
