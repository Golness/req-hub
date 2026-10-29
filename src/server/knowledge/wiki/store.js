import { randomUUID, createHash } from 'node:crypto';
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const now = () => new Date().toISOString();
export function fail(code, status = 400, details = {}) { throw Object.assign(new Error(code), { status, details }); }
export function bounded(value, bytes) { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > bytes) fail('WIKI_BUDGET_EXCEEDED', 413); return value; }
const parse = row => row ? JSON.parse(row.payload) : null;
export const PAGE_TYPES = ['source','entity','concept','overview','comparison','analysis'];
export const DEFAULT_RULES = `# Wiki maintenance rules
Keep source documents unchanged.
Read the selected evidence before you generate content.
Keep each citation with its source version and line numbers.
Maintain source, entity, concept, overview, comparison, and analysis pages.
Use stable entity keys. Separate entities that share a name.
Compare new evidence with existing conclusions.
Record contradictions with both sources. Preserve uncertainty.
Keep human edits. Submit a candidate when new evidence affects a human edit.
Keep rejected relations rejected until their evidence changes.
Update links and the index with each published revision.
Answer questions from the index and relevant pages.
Save answers only when the user requests it.
Report stale claims, contradictions, orphans, missing concepts, coverage gaps, and research gaps.
Use the configured skill when it is available. Keep the requested language.
Do not expand the selected knowledge scope.`;

/** Additive Wiki schema. Source database format and existing rows stay intact. */
export class WikiStore {
  constructor(knowledgeStore) {
    this.db = knowledgeStore.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_wiki_meta (version INTEGER NOT NULL);
      INSERT INTO knowledge_wiki_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM knowledge_wiki_meta);
    `);
    if (this.db.prepare('SELECT version FROM knowledge_wiki_meta').get().version !== 1) fail('WIKI_FORMAT_UNSUPPORTED', 503);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_rules(scope_id TEXT NOT NULL REFERENCES scopes(id),version INTEGER NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(scope_id,version));
      CREATE TABLE IF NOT EXISTS knowledge_source_snapshots(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),document_id TEXT NOT NULL,version INTEGER NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(scope_id,document_id,version,hash));
      CREATE TABLE IF NOT EXISTS knowledge_summaries(scope_id TEXT NOT NULL,document_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope_id,document_id));
      CREATE TABLE IF NOT EXISTS knowledge_summary_revisions(scope_id TEXT NOT NULL,document_id TEXT NOT NULL,version INTEGER NOT NULL,source_version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope_id,document_id,version));
      CREATE TABLE IF NOT EXISTS knowledge_wiki_pages(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES scopes(id),entity_key TEXT NOT NULL,slug TEXT NOT NULL,page_type TEXT NOT NULL,title TEXT NOT NULL,current_revision TEXT,status TEXT NOT NULL,version INTEGER NOT NULL,human_edited INTEGER NOT NULL DEFAULT 0,UNIQUE(scope_id,entity_key),UNIQUE(scope_id,slug));
      CREATE TABLE IF NOT EXISTS knowledge_wiki_revisions(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES knowledge_wiki_pages(id),scope_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(page_id,version));
      CREATE TABLE IF NOT EXISTS knowledge_page_sources(scope_id TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES knowledge_wiki_revisions(id),snapshot_id TEXT NOT NULL REFERENCES knowledge_source_snapshots(id),start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,PRIMARY KEY(revision_id,snapshot_id,start_line,end_line));
      CREATE TABLE IF NOT EXISTS knowledge_wiki_refs(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,from_page_id TEXT NOT NULL REFERENCES knowledge_wiki_pages(id),to_page_id TEXT NOT NULL REFERENCES knowledge_wiki_pages(id),ref_type TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(scope_id,from_page_id,to_page_id,ref_type));
      CREATE TABLE IF NOT EXISTS knowledge_review_decisions(scope_id TEXT NOT NULL,target_key TEXT NOT NULL,evidence_hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope_id,target_key,evidence_hash));
      CREATE TABLE IF NOT EXISTS knowledge_jobs(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_candidates(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_changelog(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,scope_id TEXT NOT NULL,operation TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,scope_id TEXT NOT NULL,document_id TEXT NOT NULL,source_version INTEGER NOT NULL,change_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',UNIQUE(scope_id,document_id,source_version));
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_wiki_fts USING fts5(id UNINDEXED,title,body,tokenize='unicode61 remove_diacritics 2');
      CREATE INDEX IF NOT EXISTS knowledge_wiki_jobs_scope ON knowledge_jobs(scope_id,status);
      CREATE INDEX IF NOT EXISTS knowledge_wiki_pages_scope ON knowledge_wiki_pages(scope_id,id);
      CREATE TRIGGER IF NOT EXISTS knowledge_wiki_doc_created AFTER INSERT ON documents BEGIN
        INSERT OR IGNORE INTO knowledge_outbox(scope_id,document_id,source_version,change_type) VALUES(new.scope_id,new.id,new.version,'created');
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_wiki_doc_updated AFTER UPDATE OF version ON documents WHEN new.version != old.version BEGIN
        INSERT OR IGNORE INTO knowledge_outbox(scope_id,document_id,source_version,change_type) VALUES(new.scope_id,new.id,new.version,'updated');
        UPDATE knowledge_wiki_pages SET status='stale' WHERE current_revision IN (SELECT ps.revision_id FROM knowledge_page_sources ps JOIN knowledge_source_snapshots s ON s.id=ps.snapshot_id WHERE s.document_id=new.id);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_wiki_source_status AFTER UPDATE OF status ON sources WHEN new.status != 'active' BEGIN
        UPDATE knowledge_wiki_pages SET status='stale' WHERE current_revision IN (SELECT ps.revision_id FROM knowledge_page_sources ps JOIN knowledge_source_snapshots s ON s.id=ps.snapshot_id JOIN documents d ON d.id=s.document_id WHERE d.scope_id=new.scope_id AND d.path=new.path);
      END;
    `);
    for (const row of this.db.prepare("SELECT payload FROM knowledge_jobs WHERE status IN ('queued','running','cancelling')").all()) {
      const job = parse(row); job.status = 'interrupted'; job.error = { code: 'WIKI_INTERRUPTED', retryable: true }; this.saveJob(job);
    }
    this.db.prepare("UPDATE knowledge_outbox SET status='interrupted' WHERE status IN ('queued','running')").run();
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  rules(scope) {
    let row = this.db.prepare('SELECT * FROM knowledge_rules WHERE scope_id=? ORDER BY version DESC LIMIT 1').get(scope);
    if (!row) { this.db.prepare('INSERT INTO knowledge_rules VALUES (?,?,?,?,?)').run(scope,1,DEFAULT_RULES,digest(DEFAULT_RULES),now()); row = this.rules(scope); }
    return row;
  }
  append(scope, operation, detail = {}) { this.db.prepare('INSERT INTO knowledge_changelog(id,scope_id,operation,payload,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),scope,operation,JSON.stringify(detail),now()); }
  logs(scope, cursor = 0, limit = 30) { return this.pageRows('SELECT sequence,id,operation,payload,created_at FROM knowledge_changelog WHERE scope_id=? AND sequence>? ORDER BY sequence', [scope,cursor],limit, row => ({ ...row, detail: JSON.parse(row.payload),payload:undefined }), 'sequence'); }
  pageRows(sql,args,limit,map = row => row,key = 'id') { const rows = this.db.prepare(sql+' LIMIT ?').all(...args,limit+1); return { items: rows.slice(0,limit).map(map),hasMore:rows.length>limit,nextCursor:rows.length>limit?rows[limit-1][key]:null }; }
  documents(scope,cursor='',limit=30) { return this.pageRows('SELECT id,title,version,path FROM documents WHERE scope_id=? AND id>? ORDER BY id',[scope,cursor],limit); }
  pages(scope,cursor='',limit=30) { return this.pageRows('SELECT * FROM knowledge_wiki_pages WHERE scope_id=? AND id>? ORDER BY id',[scope,cursor],limit); }
  page(scope,id,revision) {
    const page = this.db.prepare('SELECT * FROM knowledge_wiki_pages WHERE scope_id=? AND id=?').get(scope,id); if (!page) fail('WIKI_NOT_FOUND',404);
    const saved = this.db.prepare('SELECT * FROM knowledge_wiki_revisions WHERE scope_id=? AND page_id=? AND id=?').get(scope,id,revision||page.current_revision);
    const refs=this.db.prepare('SELECT payload FROM knowledge_wiki_refs WHERE scope_id=? AND (from_page_id=? OR to_page_id=?)').all(scope,id,id).map(parse).map(ref=>{
      const from=this.db.prepare('SELECT status,current_revision FROM knowledge_wiki_pages WHERE scope_id=? AND id=?').get(scope,ref.fromPageId);
      const to=this.db.prepare('SELECT status,version FROM knowledge_wiki_pages WHERE scope_id=? AND id=?').get(scope,ref.toPageId);
      return {...ref,validity:from?.status==='ready'&&to?.status==='ready'&&(!ref.fromRevision||ref.fromRevision===from.current_revision)&&(!ref.toVersion||ref.toVersion===to.version)?'valid':'stale'};
    });
    return { ...page,...(saved?{revision:parse(saved),body:parse(saved).body}:{}),refs };
  }
  snapshot(scope,doc) {
    const existing = this.db.prepare('SELECT id FROM knowledge_source_snapshots WHERE scope_id=? AND document_id=? AND version=? AND hash=?').get(scope,doc.id,doc.version,digest(doc.body));
    if (existing) return existing.id;
    const id=randomUUID(); this.db.prepare('INSERT INTO knowledge_source_snapshots VALUES (?,?,?,?,?,?)').run(id,scope,doc.id,doc.version,digest(doc.body),JSON.stringify(doc)); return id;
  }
  saveJob(job) { job.updatedAt=now(); this.db.prepare('INSERT INTO knowledge_jobs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(job.id,job.scopeId,job.status,JSON.stringify(job)); }
  job(scope,id) { return parse(this.db.prepare('SELECT payload FROM knowledge_jobs WHERE scope_id=? AND id=?').get(scope,id)); }
  jobs(scope) { return this.db.prepare('SELECT payload FROM knowledge_jobs WHERE scope_id=? ORDER BY rowid DESC LIMIT 100').all(scope).map(parse); }
  candidate(scope,id) { const row=parse(this.db.prepare('SELECT payload FROM knowledge_candidates WHERE scope_id=? AND id=?').get(scope,id)); if(!row)fail('WIKI_NOT_FOUND',404);return row; }
  candidates(scope) { return this.db.prepare("SELECT payload FROM knowledge_candidates WHERE scope_id=? AND status='pending' ORDER BY rowid LIMIT 100").all(scope).map(parse); }
  saveCandidate(value) { value.inputHash=digest([value.manifest,value.ruleVersion,value.ruleHash,value.pages,value.summaries,value.refs,value.rules]);this.db.prepare('INSERT INTO knowledge_candidates VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(value.id,value.scopeId,value.status,JSON.stringify(value)); }
  summary(scope,id) { return parse(this.db.prepare('SELECT payload FROM knowledge_summaries WHERE scope_id=? AND document_id=?').get(scope,id)); }
  saveSummary(scope,value) {
    this.db.prepare('INSERT INTO knowledge_summary_revisions VALUES (?,?,?,?,?)').run(scope,value.documentId,value.version,value.sourceVersion,JSON.stringify(value));
    this.db.prepare('INSERT INTO knowledge_summaries VALUES (?,?,?,?) ON CONFLICT(scope_id,document_id) DO UPDATE SET version=excluded.version,payload=excluded.payload').run(scope,value.documentId,value.version,JSON.stringify(value));
  }
  outbox(scope) { return this.db.prepare("SELECT * FROM knowledge_outbox WHERE scope_id=? AND status='pending' ORDER BY sequence LIMIT 200").all(scope); }
  eventState(sequence,status) { this.db.prepare('UPDATE knowledge_outbox SET status=? WHERE sequence=?').run(status,sequence); }
  publishPage(scope,proposal,ruleVersion,actor) {
    const existing = proposal.pageId ? this.page(scope,proposal.pageId) : this.db.prepare('SELECT * FROM knowledge_wiki_pages WHERE scope_id=? AND entity_key=?').get(scope,proposal.entityKey);
    if ((existing?.version||0)!==proposal.baseVersion) fail('WIKI_VERSION_CONFLICT',409);
    const id=existing?.id||randomUUID(),version=(existing?.version||0)+1,revisionId=randomUUID();
    this.db.prepare("UPDATE knowledge_wiki_pages SET status='stale' WHERE current_revision IN (SELECT ps.revision_id FROM knowledge_page_sources ps JOIN knowledge_source_snapshots s ON s.id=ps.snapshot_id WHERE s.document_id=?)").run('wiki:'+id);
    const revision={ id:revisionId,pageId:id,version,body:proposal.body,title:proposal.title,evidence:proposal.evidence,ruleVersion,actor,createdAt:now() };
    this.db.prepare("INSERT INTO knowledge_wiki_pages VALUES (?,?,?,?,?,?,?,'ready',?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,page_type=excluded.page_type,current_revision=excluded.current_revision,status='ready',version=excluded.version,human_edited=excluded.human_edited")
      .run(id,scope,existing?.entity_key||proposal.entityKey,(existing?.slug||digest([scope,proposal.entityKey]).slice(0,24)),proposal.pageType,proposal.title,revisionId,version,actor==='user'?1:existing?.human_edited||0);
    this.db.prepare('INSERT INTO knowledge_wiki_revisions VALUES (?,?,?,?,?)').run(revisionId,id,scope,version,JSON.stringify(revision));
    for (const ref of proposal.evidence) this.db.prepare('INSERT OR IGNORE INTO knowledge_page_sources VALUES (?,?,?,?,?)').run(scope,revisionId,ref.snapshotId,ref.startLine,ref.endLine);
    this.db.prepare('DELETE FROM knowledge_wiki_fts WHERE id=?').run(id);this.db.prepare('INSERT INTO knowledge_wiki_fts VALUES (?,?,?)').run(id,proposal.title,proposal.body);
    this.append(scope,'wiki_published',{pageId:id,oldVersion:version-1,newVersion:version,actor}); return id;
  }
}
