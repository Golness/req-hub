import { describe, it, expect, afterEach } from 'vitest';
import general from '../../src/shared/general.cjs';
import {
  setContentLanguage,
  currentContentLanguage,
  contentTemplates,
  diffHeadingTexts,
} from '../../src/server/content-templates.js';
import { WRITING_STARTERS } from '../../src/server/routes/writing-routes.js';
import { sessionMessages } from '../../src/server/knowledge-v2/session-export.js';
import { parseSyncCodeDiff } from '../../src/server/sync-code-files.js';

afterEach(() => setContentLanguage(general.DEFAULT_CONTENT_LANGUAGE));

describe('artifact language', () => {
  it('normalizes and installs the configured content language', () => {
    expect(general.CONTENT_LANGUAGES).toEqual(['zh', 'en']);
    expect(general.normalizeContentLanguage('en')).toBe('en');
    expect(general.normalizeContentLanguage('fr')).toBe('zh');
    expect(setContentLanguage('en')).toBe('en');
    expect(currentContentLanguage()).toBe('en');
    expect(setContentLanguage(undefined)).toBe('zh');
  });

  it('switches document starters, wiki headings and session labels together', () => {
    setContentLanguage('zh');
    expect(WRITING_STARTERS.requirement.label).toBe('需求文档');
    expect(contentTemplates().wiki.indexTitle).toContain('知识');
    expect(sessionMessages({ userInput: '正文', summary: '答复' })[0].label).toBe('用户输入');

    setContentLanguage('en');
    expect(WRITING_STARTERS.requirement.label).toBe('Requirement document');
    expect(WRITING_STARTERS.design.content).not.toMatch(/[一-龥]/);
    expect(contentTemplates().wiki.indexTitle).toBe('# Knowledge Index');
    expect(sessionMessages({ userInput: 'body', summary: 'answer' })[0].label).toBe('User input');
  });

  it('keeps every English artifact template free of Chinese copy', () => {
    setContentLanguage('en');
    const templates = contentTemplates();
    const strings = [];
    const walk = (value) => {
      if (typeof value === 'string') strings.push(value);
      else if (typeof value === 'function') {
        strings.push(value('A', 'B'));
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(walk);
      }
    };
    walk(templates);
    expect(strings.length).toBeGreaterThan(20);
    for (const text of strings) expect(text, text).not.toMatch(/[一-龥]/);
  });

  it('diff headings stay aligned between the generator and the parser', () => {
    const patch =
      'diff --git a/src/rule.js b/src/rule.js\n--- a/src/rule.js\n+++ b/src/rule.js\n@@ -1 +1 @@\n-old\n+new';
    for (const language of ['zh', 'en']) {
      setContentLanguage(language);
      const headings = Object.values(contentTemplates().diff);
      expect(diffHeadingTexts().length).toBe(headings.length);
      for (const heading of headings) {
        const bundle = `${heading}\n\n${patch}`;
        expect(parseSyncCodeDiff(bundle), `${language}/${heading}`).toHaveLength(1);
      }
    }
  });
});
