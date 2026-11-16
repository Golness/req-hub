/**
 * Language of generated artifacts.
 *
 * UI language (general.uiLanguage) decides what the operator reads. Artifact
 * language (general.contentLanguage) decides the scaffolding written into
 * requirement documents, Wiki pages, session exports and diff bundles. They
 * are deliberately independent: an English UI can still produce Chinese
 * deliverables, and vice versa.
 *
 * Templates live here so parser-side coupling (heading stripping, diff
 * splitting, provenance lines) can be expressed in terms of the same
 * constants instead of hard-coded Chinese strings.
 */
import general from '../shared/general.cjs';

const ZH = {
  docType: { requirement: '需求文档', design: '技术方案' },
  starters: {
    requirement:
      '# 需求文档\n\n## 背景与目标\n\n## 用户与场景\n\n## 功能与业务规则\n\n## 异常与边界\n\n## 验收标准\n',
    design:
      '# 技术方案\n\n## 背景与目标\n\n## 现状与约束\n\n## 方案设计\n\n## 接口与数据设计\n\n## 风险与兼容性\n\n## 验证与发布\n',
  },
  wiki: {
    indexTitle: '# 知识索引',
    groups: { summary: '资料摘要', entity: '实体', concept: '概念', topic: '主题' },
    publishedVersion: (id) => `发布版本：${id}`,
    overviewLink: '- [[overview|概览]]',
    changelogTitle: '# 更新日志\n\n',
    overviewTitle: '# 概览',
    overviewEmpty: '暂无概览。',
    sourceCitation: (title, id, revision, endLine) =>
      `\n\n来源：[${title}](source:${id}@${revision}#L1-L${endLine})\n`,
  },
  session: {
    labels: {
      userInput: '用户输入',
      userFollowUp: '用户补充输入',
      assistantFinal: '助手最终回复',
      assistantReply: '助手回复',
      assistantIntermediate: (n) => `助手中间回复 ${n}`,
    },
    pending: '（进行中）',
    turnHeading: (n, status = '') => `## 第 ${n} 轮${status}\n\n`,
    sessionTitle: (id) => `# 会话：${id}\n\n`,
    provenance: (provider, sessionId, version) =>
      `来源：${provider}；会话 ID：${sessionId}；快照：${version}\n`,
    notice: '说明：下列内容是会话记录；未完成回复不表示已确认事实。\n\n',
  },
  diff: {
    committed: '# 已提交的变更',
    staged: '# 已暂存但未提交的变更',
    unstaged: '# 未暂存的变更',
    untracked: '# 未跟踪的新文件',
  },
  writing: {
    defaultInstruction: '结合原文和知识库完善表达、边界与可验证性',
  },
  binary: {
    pageHeading: (n, text) => `## 第 ${n} 页\n\n${text}`,
    worksheetHeading: (name) => `## 工作表：${name}`,
    formulaMissing: '；无缓存结果，未计算',
    formulaNote: (formula, note) => ` [公式：${formula}${note}]`,
  },
};

const EN = {
  docType: { requirement: 'Requirement document', design: 'Technical design' },
  starters: {
    requirement:
      '# Requirement Document\n\n## Background & Goals\n\n## Users & Scenarios\n\n## Features & Business Rules\n\n## Exceptions & Boundaries\n\n## Acceptance Criteria\n',
    design:
      '# Technical Design\n\n## Background & Goals\n\n## Current State & Constraints\n\n## Solution Design\n\n## Interfaces & Data Design\n\n## Risks & Compatibility\n\n## Validation & Release\n',
  },
  wiki: {
    indexTitle: '# Knowledge Index',
    groups: { summary: 'Source Summary', entity: 'Entities', concept: 'Concepts', topic: 'Topics' },
    publishedVersion: (id) => `Published version: ${id}`,
    overviewLink: '- [[overview|Overview]]',
    changelogTitle: '# Changelog\n\n',
    overviewTitle: '# Overview',
    overviewEmpty: 'No overview yet.',
    sourceCitation: (title, id, revision, endLine) =>
      `\n\nSource: [${title}](source:${id}@${revision}#L1-L${endLine})\n`,
  },
  session: {
    labels: {
      userInput: 'User input',
      userFollowUp: 'User follow-up',
      assistantFinal: 'Assistant final reply',
      assistantReply: 'Assistant reply',
      assistantIntermediate: (n) => `Assistant intermediate reply ${n}`,
    },
    pending: ' (in progress)',
    turnHeading: (n, status = '') => `## Turn ${n}${status}\n\n`,
    sessionTitle: (id) => `# Session: ${id}\n\n`,
    provenance: (provider, sessionId, version) =>
      `Source: ${provider}; Session ID: ${sessionId}; Snapshot: ${version}\n`,
    notice:
      'Note: The following is a session transcript; unfinished replies are not confirmed facts.\n\n',
  },
  diff: {
    committed: '# Committed Changes',
    staged: '# Staged Changes',
    unstaged: '# Unstaged Changes',
    untracked: '# Untracked Files',
  },
  writing: {
    defaultInstruction:
      'Improve wording, boundaries and verifiability using the source and knowledge base',
  },
  binary: {
    pageHeading: (n, text) => `## Page ${n}\n\n${text}`,
    worksheetHeading: (name) => `## Worksheet: ${name}`,
    formulaMissing: '; no cached result, not calculated',
    formulaNote: (formula, note) => ` [Formula: ${formula}${note}]`,
  },
};

const DICTIONARIES = { zh: ZH, en: EN };
let language = general.DEFAULT_CONTENT_LANGUAGE;

/**
 * Install the artifact language from the effective profile configuration.
 * @param {unknown} value - Saved general.contentLanguage.
 * @returns {string} The installed language.
 */
export function setContentLanguage(value) {
  language = general.normalizeContentLanguage(value);
  return language;
}

/** @returns {string} The active artifact language. */
export function currentContentLanguage() {
  return language;
}

/** @returns {typeof ZH} Templates for the active artifact language. */
export function contentTemplates() {
  return DICTIONARIES[language];
}

/**
 * Headings used to split a diff bundle, for the active artifact language.
 * @returns {string[]} Plain heading text without the leading '# '.
 */
export function diffHeadingTexts() {
  const { diff } = contentTemplates();
  return Object.values(diff).map((heading) => heading.replace(/^#\s+/, ''));
}
