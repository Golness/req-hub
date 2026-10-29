import { createRequire } from 'node:module';
import { it, expect } from 'vitest';
const require = createRequire(import.meta.url);
const { findBranchRequirement } = require('../../src/client/utils/findBranchRequirement.js');
const { parseBranchName } = require('../../src/client/utils/parseBranchName.js');
const id = '2026-10-28-门店系统-门店租金-支持ST为0的门店发起申请提交申请时支持选择多个TPM';
const entry = { id, path: `lihanping/${id}` };
const tree = { developers: [{ name: 'lihanping', requirements: [entry] }] };
const parsed = parseBranchName(`feature/lihanping/${id.toLowerCase()}`);
it('locates a Windows directory using actual ST/TPM spelling despite lowercase branch slugs', () => {
  expect(findBranchRequirement(tree, parsed, false).match).toEqual({ ...entry, developer: 'lihanping' });
  expect(findBranchRequirement(tree, { ...parsed, developer: 'LiHanPing' }, false).match?.id).toBe(id);
});
it('preserves strict matching on case-sensitive hosts and exact matching everywhere', () => {
  expect(findBranchRequirement(tree, parsed, true).match).toBeNull();
  expect(findBranchRequirement(tree, { ...parsed, requirementId: id }, true).match?.path).toBe(entry.path);
});
it('never silently picks a developer or creates a directory when matching is ambiguous', () => {
  const duplicate = { developers: [...tree.developers, { name: 'another', requirements: [{ ...entry, path: `another/${id}` }] }] };
  expect(findBranchRequirement(duplicate, { ...parsed, developer: null }, false)).toEqual({ match: null, ambiguous: true });
  expect(findBranchRequirement(duplicate, parsed, false).match?.developer).toBe('lihanping');
});
