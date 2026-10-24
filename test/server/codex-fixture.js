import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function codexRecords({ id = 'cx-one', cwd = 'D:/repo', final = '确认采用新规则。', intermediate = '我先检查接口。', incomplete = false } = {}) {
  const row = (type, payload) => ({ timestamp: '2026-10-24T01:00:00Z', type, payload });
  const records = [
    row('session_meta', { id, cwd, timestamp: '2026-10-24T01:00:00Z', source: 'cli' }),
    row('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
    row('turn_context', { turn_id: 'turn-1', workspace_roots: [cwd] }),
    row('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'DEVELOPER_SECRET' }] }),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>CONTEXT_SECRET</environment_context>' }] }),
    row('event_msg', { type: 'user_message', message: '用户确认新规则' }),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '用户确认新规则' }] }),
    row('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'THINKING_SECRET' }] }),
    row('response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: intermediate }] }),
    row('event_msg', { type: 'agent_message', message: intermediate, phase: 'commentary' }),
    row('response_item', { type: 'function_call', name: 'read', arguments: 'TOOL_SECRET' }),
    row('response_item', { type: 'function_call_output', output: 'RESULT_SECRET' }),
    row('event_msg', { type: 'user_message', message: '保留旧接口。' }),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '保留旧接口。' }] }),
    row('response_item', { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: final }] }),
    row('event_msg', { type: 'agent_message', message: final, phase: 'final' }),
    row('event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: final }),
  ];
  if (incomplete) records.push(row('event_msg', { type: 'task_started', turn_id: 'turn-2' }), row('event_msg', { type: 'user_message', message: '尚未结束的输入' }), row('response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '仍在处理' }] }));
  return records;
}

export async function writeCodexRollout(home, records, name = 'one') {
  const file = join(home, 'sessions', '2026', '10', '24', `rollout-${name}.jsonl`);
  await mkdir(join(home, 'sessions', '2026', '10', '24'), { recursive: true });
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

export function codexState(home, sessions, projects = []) {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,rollout_path TEXT,archived INTEGER,title TEXT,created_at INTEGER,updated_at INTEGER,source TEXT,project_id TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER);`);
  for (const project of projects) {
    db.prepare('INSERT INTO projects VALUES(?,?)').run(project.id, project.title);
    project.paths.forEach((path, index) => db.prepare('INSERT INTO project_roots VALUES(?,?,?)').run(project.id, path, index));
  }
  for (const session of sessions) db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)').run(session.id, session.cwd, session.file, session.archived || 0, session.title || session.id, 1761267600, 1761267700, session.source || 'cli', session.projectId || null);
  return db;
}
