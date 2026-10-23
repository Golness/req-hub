import { describe,it,expect } from 'vitest';
import { mkdtemp,writeFile,readFile,mkdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { parsePatch,applyPatch,reversePatch } from 'diff';
import { indexDocument,validateCandidate,publishDocument,readDocumentVersion } from '../../src/server/sync-document-validator.js';
const validate=(before,after,file='requirement.md')=>{
 const bytes=Buffer.from(before),blocks=indexDocument(bytes);
 const changes=blocks.map((block,i)=>({id:'c'+i,blockId:block.id}));
 return validateCandidate(bytes,Buffer.from(after),file,changes,blocks);
};
describe('program-generated document diffs',()=>{
 it.each([
 ['LF','# 标题\n\n旧规则\n','# 标题\n\n新规则\n'],
 ['CRLF','# 标题\r\n\r\n旧规则\r\n','# 标题\r\n\r\n新规则\r\n'],
 ['BOM','\uFEFF# 标题\r\n旧规则','\uFEFF# 标题\r\n新规则'],
 ['mixed','# 标题\r\n旧规则\n尾\r\n','# 标题\r\n新规则\n尾\r\n'],
 ['no-final-newline','# 标题\n旧规则','# 标题\n新规则'],
 ['new-document','','# 新文档\n'],
 ])('round-trips %s byte-for-byte',(_name,before,after)=>{
   const result=validate(before,after);const patch=parsePatch(result.patch)[0];
   expect(applyPatch(before,patch,{fuzzFactor:0,autoConvertLineEndings:false})).toBe(after);
   expect(applyPatch(after,reversePatch(patch),{fuzzFactor:0,autoConvertLineEndings:false})).toBe(before);
 });
 it('produces no patch for identical bytes including whitespace',()=>{expect(validate('# 标题\r\n保持  空格\r\n','# 标题\r\n保持  空格\r\n').patch).toBe('');});
 it('rejects format changes and foreign targets',()=>{
  expect(()=>validate('\uFEFF# 标题\n旧规则\n','# 标题\n新规则\n')).toThrow('FORMAT');
  expect(()=>validate('# 标题\n旧规则','# 标题\n新规则\n')).toThrow('FORMAT');
  expect(()=>validate('a','b','other.md')).toThrow('SCOPE');
 });
 it('rejects a change outside the authorized parser block',()=>{
  const before='# 标题\n\n规则\n\n## 无关\n保持\n',bytes=Buffer.from(before),blocks=indexDocument(bytes);
  expect(()=>validateCandidate(bytes,Buffer.from(before.replace('保持','被修改')),'design.md',[{blockId:blocks[1].id}],blocks)).toThrow('OUT_OF_SCOPE');
 });
 it('does not silently replace invalid UTF-8',()=>{expect(()=>indexDocument(Buffer.from([0xff,0xfe]))).toThrow();});
 it('preserves untouched multilingual and repeated lines across generated text pairs',()=>{
  for(let i=0;i<40;i++){
   const before='# 标题\n\n相同 😀 中文 '+i+'\n重复\n重复\n尾部\n';
   const after=before.replace('中文 '+i,'中文 更新'+i);
   const result=validate(before,after);expect(result.patch).toContain('更新'+i);
  }
 });
 it('rejects deleting an existing document',()=>{expect(()=>validate('# 文档\n内容\n','')).toThrow('DELETE');});
});
describe('publishing validated bytes',()=>{
 it('writes identical successful snapshot and live bytes with a recovery journal',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'req-hub-v2-publish-'));
  try{const docPath=join(dir,'requirement.md'),syncDir=join(dir,'sync');await mkdir(syncDir);await writeFile(docPath,'# 标题\n旧规则\n');
   const original=await readDocumentVersion(docPath),candidateBytes=Buffer.from('# 标题\n新规则\n');const validation=validate(original.bytes.toString(),candidateBytes.toString());
   await publishDocument({docPath,syncDir,fileName:'requirement.md',original,candidateBytes,validation});
   expect(await readFile(docPath)).toEqual(candidateBytes);expect(await readFile(join(syncDir,'requirement.md'))).toEqual(candidateBytes);
   expect(JSON.parse(await readFile(join(syncDir,'publish-journal.json'),'utf8')).stage).toBe('document_written');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it('does not confuse a newly created empty live document with an absent original',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'req-hub-v2-newconflict-'));
  try{const docPath=join(dir,'design.md'),original=await readDocumentVersion(docPath);await writeFile(docPath,'');
   const candidateBytes=Buffer.from('# New\n'),validation=validate('','# New\n','design.md');
   await expect(publishDocument({docPath,syncDir:dir,fileName:'design.md',original,candidateBytes,validation})).rejects.toThrow('主文档已被修改');
   expect(await readFile(docPath,'utf8')).toBe('');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
