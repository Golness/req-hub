'use strict';
const React = require('react');
const { t } = require('../locale.js');
const { ROUTE } = require('../constants.js');
const { SessionSelectionContext } = require('../context.js');
const { Button } = require('./shared/Button.js');
const { Input } = require('./shared/Input.js');
const { Select } = require('./shared/Select.js');
const { Skeleton } = require('./shared/Skeleton.js');
const css = require('./WikiPanel.module.css').default;
const h = React.createElement;
const ACTIVE = ['queued','running','cancelling'];
function WikiPanel({ workspaceId, tab }) {
  const session = React.useContext(SessionSelectionContext);
  const [data,setData] = React.useState({ items:[] }), [jobs,setJobs] = React.useState([]), [candidates,setCandidates] = React.useState([]);
  const [error,setError] = React.useState(null), [busy,setBusy] = React.useState(false), [revision,setRevision] = React.useState(0);
  const [instruction,setInstruction] = React.useState(''), [detail,setDetail] = React.useState(null), [body,setBody] = React.useState('');
  const [summary,setSummary] = React.useState(''), [classification,setClassification] = React.useState('other'), [tags,setTags] = React.useState({entities:'[]',concepts:'[]',decisions:'[]'});
  const [title,setTitle] = React.useState(''), [answerId,setAnswerId] = React.useState(null), [selected,setSelected] = React.useState([]);
  const [scopes,setScopes] = React.useState([]), [scopeIds,setScopeIds] = React.useState(null), [loading,setLoading] = React.useState(true);
  const [history,setHistory] = React.useState(null), [refTarget,setRefTarget] = React.useState(''), [refType,setRefType] = React.useState('related');
  const [backup,setBackup] = React.useState(null),[restoreCursor,setRestoreCursor]=React.useState(null);
  const [candidateDrafts,setCandidateDrafts]=React.useState({});
  const [jobCursor,setJobCursor]=React.useState(null),[candidateCursor,setCandidateCursor]=React.useState(null);
  const rulesVersion = React.useRef(null);
  const owner = React.useRef(null);
  const request = async (path,method='GET',input,signal=owner.current?.signal) => {
    const response=await fetch(`${ROUTE}/knowledge/wiki${path}${method==='GET'?(path.includes('?')?'&':'?')+'workspaceId='+encodeURIComponent(workspaceId):''}`,{
      method,signal,headers:{'Content-Type':'application/json',...(session()?{'x-session-id':session()}:{})},...(method==='GET'?{}:{body:JSON.stringify({...input,workspaceId})})
    });
    const value=await response.json();if(!response.ok)throw new Error(value.error||'WIKI_FAILED');return value;
  };
  const refresh=()=>setRevision(value=>value+1);
  const perform=async (action,reload=true)=>{const signal=owner.current?.signal;setBusy(true);setError(null);try{const result=await action();if(!signal?.aborted){if(result?.projection?.status==='failed')setError('WIKI_PROJECTION_FAILED');if(reload)refresh();}return result;}catch(error){if(!signal?.aborted)setError(error.message);}finally{if(!signal?.aborted)setBusy(false);}};
  React.useEffect(()=>{
    const controller=new AbortController();owner.current=controller;let timer;
    const load=async()=>{
      try{
        const [jobData,candidateData,scopeData]=await Promise.all([request('/jobs','GET',null,controller.signal),request('/candidates','GET',null,controller.signal),tab==='query'?request('/scopes','GET',null,controller.signal):Promise.resolve({items:[]})]);
        if(controller.signal.aborted)return;
        setJobs(jobData.items||[]);setCandidates(candidateData.items||[]);
        setJobCursor(jobData.nextCursor??null);setCandidateCursor(candidateData.nextCursor??null);
        setScopes(scopeData.items||[]);if(tab==='query')setScopeIds(old=>old===null?scopeData.items.filter(item=>item.current).map(item=>item.id):old);
        const path=tab==='index'?'/index':tab==='wiki'?'/pages':tab==='rules'?'/rules':tab==='changes'?'/changelog':null;
        if(path){const result=await request(path,'GET',null,controller.signal);if(!controller.signal.aborted){setData(result);if(tab==='rules'&&rulesVersion.current===null){setBody(result.body);rulesVersion.current=result.version;}}}
        if(jobData.items?.some(job=>ACTIVE.includes(job.status)))timer=setTimeout(load,1000);
      }catch(error){if(!controller.signal.aborted)setError(error.message);}finally{if(!controller.signal.aborted)setLoading(false);}
    };
    load();return()=>{controller.abort();clearTimeout(timer);};
  },[workspaceId,tab,revision]);
  const label=(key)=>t(`wiki.${key}`);
  const button=(key,action,disabled=busy)=>h(Button,{type:'button',disabled,className:'rh-btn rh-btn-ghost rh-btn-sm',onClick:()=>perform(action)},label(key));
  const start=kind=>request('/jobs','POST',{kind,instruction,...(kind==='query'?{scopeIds:scopeIds||[]}:{...selected.length?{documentIds:selected}:{}})});
  const loadMore=()=>perform(async()=>{const path=tab==='index'?'/index':tab==='wiki'?'/pages':'/changelog';const next=await request(path+'?cursor='+encodeURIComponent(data.nextCursor));setData({...next,items:[...(data.items||[]),...next.items]});},false);
  const sourceDetail=async id=>{const value=await request('/summaries/'+id);setDetail({kind:'source',id,...value});setSummary(value.summary?.summary||'');setClassification(value.summary?.classification||'other');setTags(Object.fromEntries(['entities','concepts','decisions'].map(key=>[key,JSON.stringify(value.summary?.[key]||[],null,2)])));};
  const pageDetail=async (id,revision)=>{const page=await request('/pages/'+id+(revision?'?revision='+encodeURIComponent(revision):''));setDetail({kind:'wiki',historical:!!revision,...page});setBody(page.body);setHistory(null);};
  const exportWiki=async()=>{const backup=await request('/export');const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='reqhub-wiki.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),0);};
  const restoreWiki=async(value,cursor=0)=>{const result=await request('/restore','POST',{backup:value,cursor});setBackup(value);setRestoreCursor(result.nextCursor);};
  const evidence=refs=>h('ul',null,(refs||[]).map((ref,index)=>h('li',{key:index},h('button',{type:'button',onClick:()=>perform(async()=>{const snapshot=await request('/evidence/'+ref.snapshotId);setDetail({kind:'evidence',...snapshot});})},`${ref.documentId} · v${ref.version} · ${ref.startLine}–${ref.endLine}`))));
  const answer=jobs.find(job=>job.id===answerId);
  return h('section',{className:css.panel,id:'knowledge-content',role:'tabpanel','aria-labelledby':'knowledge-tab-'+tab},
    h('div',{className:css.toolbar},h('strong',null,t(`wiki.tab.${tab}`)),button('refresh',async()=>{}),button('export',exportWiki)),
    h('details',null,h('summary',null,label('restore')),h('p',null,label('restoreHint')),h('input',{type:'file',accept:'.json,application/json','aria-label':label('restore'),disabled:busy,onChange:event=>{const file=event.target.files?.[0];if(file)perform(async()=>{if(file.size>20000000)throw new Error('WIKI_BUDGET_EXCEEDED');await restoreWiki(JSON.parse(await file.text()));});}}),restoreCursor!==null&&button('restoreMore',()=>restoreWiki(backup,restoreCursor))),
    error&&h('div',{className:css.error,role:'alert'},error==='WIKI_PROJECTION_FAILED'?label('projectionFailed'):t('wiki.error',{code:error})),
    error==='WIKI_PROJECTION_FAILED'&&button('retryProjection',()=>request('/projection','POST',{})),
    loading&&h(Skeleton,{lines:3}),
    !loading&&!data.items?.length&&['index','wiki','changes'].includes(tab)&&h('p',{role:'status',className:css.muted},label('empty')),
    tab==='index'&&h(React.Fragment,null,
      h('p',{className:css.muted},label('sourceHint')),
      h('div',{className:css.toolbar},button('ingest',()=>start('ingest')),button('backfill',()=>request('/backfill','POST',{documentIds:(data.items||[]).map(item=>item.id)}))),
      h('div',{className:css.list},(data.items||[]).map(doc=>h('div',{key:doc.id,className:css.card},
        h('label',null,h('input',{type:'checkbox',checked:selected.includes(doc.id),onChange:event=>setSelected(old=>event.target.checked?[...old,doc.id]:old.filter(id=>id!==doc.id))}),doc.title,` · v${doc.version}`),
        h('p',null,doc.path),h('p',null,t(`wiki.status.${doc.wikiStatus||'not_processed'}`)),h('p',null,doc.summary?.summary||label('noSummary')),button('details',()=>sourceDetail(doc.id)))))),
    tab==='wiki'&&h(React.Fragment,null,
      h(Input,{className:css.input,value:instruction,'aria-label':label('search'),placeholder:label('search'),onChange:event=>setInstruction(event.target.value)}),
      h(Button,{type:'button',disabled:busy,onClick:()=>perform(async()=>setData(await request('/search?q='+encodeURIComponent(instruction))),false)},label('search')),
      h('div',{className:css.list},(data.items||[]).map(page=>h('article',{className:css.card,key:page.id},h('h3',null,page.title),h('p',null,t(`wiki.type.${page.page_type}`),` · v${page.version} · `,t(`wiki.status.${page.status}`)),button('details',()=>pageDetail(page.id)))))),
    ['query','lint'].includes(tab)&&h(React.Fragment,null,
      tab==='query'&&h('fieldset',null,h('legend',null,label('scopes')),scopes.map(scope=>h('label',{key:scope.id,className:css.toolbar},h('input',{type:'checkbox',checked:(scopeIds||[]).includes(scope.id),onChange:event=>setScopeIds(old=>event.target.checked?[...(old||[]),scope.id]:(old||[]).filter(id=>id!==scope.id))}),scope.title))),
      h('label',{className:css.field},label('instruction'),h('textarea',{className:css.editor,value:instruction,onChange:event=>setInstruction(event.target.value)})),
      button(tab==='query'?'ask':'lint',async()=>{const job=await start(tab);setAnswerId(job.id);}),
      answer?.result&&h('article',{className:css.card},h('pre',{className:css.body},answer.result.answer||JSON.stringify(answer.result.findings,null,2)),evidence(answer.result.evidence),
        tab==='query'&&h('div',{className:css.field},h(Input,{className:css.input,value:title,placeholder:label('title'),'aria-label':label('title'),onChange:event=>setTitle(event.target.value)}),button('saveAnswer',()=>request('/jobs/'+answer.id+'/save','POST',{title}))))),
    tab==='rules'&&h(React.Fragment,null,h('p',null,t('wiki.rulesVersion',{version:data.version})),h('textarea',{className:css.editor,'aria-label':label('rulesBody'),value:body,onChange:event=>setBody(event.target.value)}),button('saveRules',()=>request('/rules','PUT',{body,expectedVersion:rulesVersion.current}))),
    tab==='changes'&&h('ol',null,(data.items||[]).map(item=>h('li',{key:item.id},`${item.created_at} · ${item.operation}`,h('pre',{className:css.body},JSON.stringify(item.detail,null,2))))),
    data.hasMore&&h(Button,{onClick:loadMore,disabled:busy,type:'button'},label('more')),
    detail&&h('article',{className:css.card},h('div',{className:css.toolbar},h('h3',null,detail.title||detail.document?.title),button('close',async()=>setDetail(null))),
      detail.kind==='evidence'&&h('pre',{className:css.body},detail.body),
      detail.kind==='source'&&h(React.Fragment,null,
        h('label',{className:css.field},label('summary'),h('textarea',{className:css.editor,value:summary,onChange:event=>setSummary(event.target.value)})),
        h(Select,{className:css.select,value:classification,'aria-label':label('classification'),onChange:event=>setClassification(event.target.value)},['requirement','design','cr','other'].map(value=>h('option',{key:value,value},t(`wiki.class.${value}`)))),
        ['entities','concepts','decisions'].map(key=>h('label',{key,className:css.field},label(key),h('textarea',{className:css.editor,value:tags[key],onChange:event=>setTags(old=>({...old,[key]:event.target.value}))}))),
        button('save',async()=>{const updated=await request('/summaries/'+detail.id,'PUT',{summary,classification,expectedVersion:detail.summary?.version||0,...Object.fromEntries(Object.entries(tags).map(([key,value])=>[key,JSON.parse(value)]))});setDetail(old=>({...old,summary:updated}));})),
      detail.kind==='wiki'&&h(React.Fragment,null,h('textarea',{className:css.editor,'aria-label':label('pageBody'),value:body,onChange:event=>setBody(event.target.value)}),
        detail.historical&&h('p',{role:'status'},t('wiki.historical',{version:detail.revision.version})),
        h('div',{className:css.toolbar},!detail.historical&&button('save',async()=>{const updated=await request('/pages/'+detail.id,'PUT',{body,expectedVersion:detail.version});setDetail({kind:'wiki',...updated});}),button('regenerate',()=>request('/pages/'+detail.id+'/regenerate','POST',{})),button('history',async()=>setHistory(await request('/pages/'+detail.id+'/revisions'))),detail.historical&&button('current',()=>pageDetail(detail.id))),
        history&&h('div',null,history.items.map(item=>h('button',{type:'button',key:item.id,onClick:()=>perform(()=>pageDetail(detail.id,item.id),false)},`v${item.version} · ${item.createdAt}`)),history.hasMore&&h('button',{type:'button',onClick:()=>perform(async()=>{const next=await request('/pages/'+detail.id+'/revisions?cursor='+history.nextCursor);setHistory({...next,items:[...history.items,...next.items]});},false)},label('more'))),
        evidence(detail.revision?.evidence),
        h('div',{className:css.field},h(Input,{className:css.input,value:refTarget,'aria-label':label('refTarget'),placeholder:label('refTarget'),onChange:event=>setRefTarget(event.target.value)}),h(Select,{value:refType,'aria-label':label('refType'),onChange:event=>setRefType(event.target.value)},['related','depends_on','contradicts','supersedes'].map(type=>h('option',{key:type,value:type},t(`wiki.ref.${type}`)))),button('addRef',async()=>{await request('/refs','POST',{fromPageId:detail.id,toPageId:refTarget,refType});await pageDetail(detail.id);})),
        h('p',{className:css.muted},t('wiki.pageId',{id:detail.id})),
        (detail.refs||[]).map(ref=>h('div',{className:css.card,key:ref.id},`${ref.fromPageId} → ${ref.toPageId} · `,t(`wiki.ref.${ref.refType}`),' · ',t(`wiki.validity.${ref.validity}`),' · ',t(`wiki.status.${ref.reviewState}`),h('div',{className:css.toolbar},...['accepted','rejected'].map(decision=>button(decision,async()=>{await request('/refs/'+ref.id,'PUT',{decision,expectedVersion:ref.version});await pageDetail(detail.id);}))))))),
    h('details',null,h('summary',null,label('candidates')),candidateCursor!==null&&h('button',{type:'button',disabled:busy,onClick:()=>perform(async()=>{const next=await request('/candidates?cursor='+candidateCursor);setCandidates(old=>[...old,...next.items]);setCandidateCursor(next.nextCursor);},false)},label('more')),candidates.map(candidate=>h('article',{className:css.card,key:candidate.id},
      h('pre',{className:css.body},JSON.stringify({pages:candidate.pages,summaries:candidate.summaries,rules:candidate.rules},null,2)),
      h('details',null,h('summary',null,label('editCandidate')),h('textarea',{className:css.editor,'aria-label':label('candidateContent'),value:candidateDrafts[candidate.id]??JSON.stringify({pages:candidate.pages.map(({title,body})=>({title,body})),rules:candidate.rules},null,2),onChange:event=>setCandidateDrafts(old=>({...old,[candidate.id]:event.target.value}))}),button('saveCandidate',async()=>{await request('/candidates/'+candidate.id,'PUT',{...JSON.parse(candidateDrafts[candidate.id]||JSON.stringify({pages:candidate.pages,rules:candidate.rules})),expectedVersion:candidate.version});setCandidateDrafts(old=>{const next={...old};delete next[candidate.id];return next;});})),
      h('div',{className:css.toolbar},button('publish',()=>request('/candidates/'+candidate.id+'/publish','POST',{expectedVersion:candidate.version,inputHash:candidate.inputHash}),busy||candidateDrafts[candidate.id]!==undefined),button('reject',()=>request('/candidates/'+candidate.id+'/reject','POST',{expectedVersion:candidate.version})))))),
    h('details',null,h('summary',null,label('jobs')),jobCursor!==null&&h('button',{type:'button',disabled:busy,onClick:()=>perform(async()=>{const next=await request('/jobs?cursor='+jobCursor);setJobs(old=>[...old,...next.items]);setJobCursor(next.nextCursor);},false)},label('more')),jobs.map(job=>h('article',{className:css.card,key:job.id},
      h('p',null,job.kind,' · ',t(`wiki.status.${job.status}`)),h('p',null,label('skill')+': '+(job.skillName||'—')+' · '+t(`wiki.skill.${job.skillStatus||'not_bound'}`)),
      job.error&&h('p',{className:css.error},t('wiki.error',{code:job.error.code})),
      h('div',{className:css.toolbar},ACTIVE.includes(job.status)?button('cancel',()=>request('/jobs/'+job.id+'/cancel','POST',{})):button('retry',()=>request('/jobs/'+job.id+'/retry','POST',{})),button('deleteJob',()=>request('/jobs/'+job.id,'DELETE',{})),job.kind==='query'&&job.status==='completed'&&button('details',async()=>setAnswerId(job.id))))))
  );
}
module.exports = { WikiPanel };
