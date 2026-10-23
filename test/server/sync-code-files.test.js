import { describe, expect, it } from 'vitest';
import { isSyncCodeFile, filterSyncCodeDiff, parseSyncCodeDiff } from '../../src/server/sync-code-files.js';

const patch = (file, body = '+source') => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n${body}`;

describe('sync source inputs', () => {
  it('excludes test suites, fixtures, mocks and runner configuration', () => {
    for (const path of ['test/a.js', 'src/tests/a.java', 'src/__tests__/a.ts', 'spec/a.rb', 'e2e/login.ts',
      'src/testFixtures/a.kt', 'src/androidTest/Main.kt', 'fixtures/sample.sql', '__mocks__/service.js',
      'src/Foo.test.tsx', 'src/Foo.spec.js', 'foo_test.go', 'test_api.py', 'api_spec.rb', 'conftest.py',
      'src/OrderTest.java', 'src/OrderTests.cs', 'src/OrderTestCase.java', 'src/OrderIT.java', 'src/OrderSpec.kt',
      'src/TestHelper.java', 'setupTests.ts', 'vitest.config.ts', 'jest.setup.js', 'playwright.config.ts',
      'src\\tests\\a.js', 'Project.Tests/Helper.cs', 'module-test/src/Helper.java',
      'src/__snapshots__/a.ts', 'test-utils/helper.ts']) expect(isSyncCodeFile(path), path).toBe(false);
  });

  it('keeps production paths that merely contain test-like words', () => {
    for (const path of ['src/contest.js', 'src/latest.ts', 'src/testimonial.ts', 'src/Contest.java',
      'src/Testimonial.java', 'src/testingService.ts', 'src/integration/client.ts']) expect(isSyncCodeFile(path), path).toBe(true);
  });

  it('removes tests from diffs while retaining production changes', () => {
    const filtered = filterSyncCodeDiff([patch('src/api.ts'), patch('src/api.test.ts'), patch('tests/helper.js')].join('\n'));
    expect(filtered).toContain('src/api.ts');
    expect(filtered).not.toMatch(/api.test.ts|helper.js/);
  });
  it('allows source, styles, templates, SQL and named build scripts', () => {
    for (const path of ['src/a.java', 'a.TSX', 'api.d.ts', 'view.vue', 'main.go', 'schema.sql', 'a.proto', 'a.scss', 'Makefile', 'Dockerfile.dev', 'CMakeLists.txt', 'run.ps1']) expect(isSyncCodeFile(path), path).toBe(true);
  });

  it('excludes documents, configuration, assets, locks, unknown files and build outputs', () => {
    for (const path of ['docs/design.html', 'documentation/example.js', 'README.md', 'guide.txt', 'report.pdf', 'draft.docx', 'plan.html.md', 'a.json', 'a.yaml', 'a.xml', 'a.toml', 'a.png', 'a.svg', 'package-lock.json', 'pnpm-lock.yaml', 'data.csv', 'LICENSE', 'unknown.xyz', 'dist/a.js', 'node_modules/a/index.js', 'target/Main.java', 'bundle.min.js', 'a.generated.ts', 'docs/req/sync-logs/a.js']) expect(isSyncCodeFile(path), path).toBe(false);
  });

  it('preserves source deletions and excludes binary files even with source extensions', () => {
    const deleted = 'diff --git a/deleted.ts b/deleted.ts\ndeleted file mode 100644\n--- a/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old';
    const binary = 'diff --git a/binary.js b/binary.js\nBinary files a/binary.js and b/binary.js differ';
    const filtered = filterSyncCodeDiff([patch('README.md'), deleted, binary, patch('src/a.js')].join('\n'));
    expect(filtered).toContain(deleted);
    expect(filtered).toContain('src/a.js');
    expect(filtered).not.toMatch(/README|binary/);
  });

  it('handles spaces and Git octal quoted paths', () => {
    const quoted = '"b/\\344\\270\\255\\346\\226\\207.ts"';
    const diff = `diff --git "a/old.ts" ${quoted}\n--- "a/old.ts"\n+++ ${quoted}\n@@ -1 +1 @@\n-old\n+new`;
    expect(parseSyncCodeDiff(diff)[0].file).toBe('中文.ts');
    expect(parseSyncCodeDiff(patch('src/my file.js'))[0].file).toBe('src/my file.js');
  });

  it('preserves the correct working-tree layer and never forwards filtered content', () => {
    const diff = '# 已提交的变更\n\n' + patch('guide.md') + '\n# 未暂存的变更\n\n' + patch('src/a.js');
    const filtered = filterSyncCodeDiff(diff);
    expect(filtered).toContain('# 未暂存的变更');
    expect(filtered).not.toContain('已提交');
    expect(filtered).not.toContain('guide.md');
    expect(filterSyncCodeDiff(filtered)).toBe(filtered);
  });
});
