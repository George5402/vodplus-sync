// JSON 文档通常占一行；超过安全行大小时按 UTF-8 边界分片，读取后完整校验组装。
import {assert} from '../lib/http.js';
import {all,stmt} from '../lib/db.js';
const encoder=new TextEncoder(),decoder=new TextDecoder();
const PART_BYTES=1400000,MAX_BYTES=16000000;
function splitDocument(value){
  const bytes=encoder.encode(JSON.stringify(value));assert(bytes.length<=MAX_BYTES,413,'同步清单过大，请拆分用户空间');const parts=[];
  for(let start=0;start<bytes.length;){let end=Math.min(start+PART_BYTES,bytes.length);while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;parts.push(decoder.decode(bytes.subarray(start,end)));start=end;}return parts;
}
export async function readDocument(env,key,initial){
  const rows=await all(env,'SELECT part,parts,revision,meta,value FROM json_documents WHERE key=? ORDER BY part',key);
  if(!rows.length)return {key,revision:0,meta:{},value:typeof initial==='function'?initial():structuredClone(initial)};
  const first=rows[0];assert(rows.length===first.parts&&rows.every((row,i)=>row.part===i&&row.parts===first.parts&&row.revision===first.revision),500,'文档分片不完整');
  return {key,revision:first.revision,meta:JSON.parse(first.meta),value:JSON.parse(rows.map(row=>row.value).join(''))};
}
export function writeDocument(env,document,value,guard,guardValues,meta={}){
  const parts=splitDocument(value);
  const revision=document.revision+1;
  return [...parts.map((part,i)=>stmt(env,`INSERT INTO json_documents(key,part,parts,revision,meta,value) SELECT ?,?,?,?,?,? WHERE ${guard}
    ON CONFLICT(key,part) DO UPDATE SET parts=excluded.parts,revision=excluded.revision,meta=excluded.meta,value=excluded.value`,document.key,i,parts.length,revision,JSON.stringify(meta),part,...guardValues)),
    stmt(env,`DELETE FROM json_documents WHERE key=? AND part>=? AND ${guard}`,document.key,parts.length,...guardValues)];
}
export function primaryDocument(env,document,value,condition='1',conditionValues=[],meta={}){
  const parts=splitDocument(value),revision=document.revision+1,nonce=crypto.randomUUID();
  const guard="EXISTS(SELECT 1 FROM json_documents WHERE key=? AND part=0 AND revision=? AND json_extract(meta,'$.nonce')=?)";
  const values=[document.key,revision,nonce],metadata=JSON.stringify({...meta,nonce});
  const statements=[stmt(env,`INSERT INTO json_documents(key,part,parts,revision,meta,value) SELECT ?,0,?,?,?,? WHERE ${condition}
    ON CONFLICT(key,part) DO UPDATE SET parts=excluded.parts,revision=excluded.revision,meta=excluded.meta,value=excluded.value WHERE json_documents.revision=?`,document.key,parts.length,revision,metadata,parts[0],...conditionValues,document.revision)];
  statements.push(stmt(env,`DELETE FROM json_documents WHERE key=? AND part>=? AND ${guard}`,document.key,parts.length,...values));
  for(let i=1;i<parts.length;i++)statements.push(stmt(env,`INSERT INTO json_documents(key,part,parts,revision,meta,value) SELECT ?,?,?,?,?,? WHERE ${guard}
    ON CONFLICT(key,part) DO UPDATE SET parts=excluded.parts,revision=excluded.revision,meta=excluded.meta,value=excluded.value`,document.key,i,parts.length,revision,metadata,parts[i],...values));
  return {statements,guard,values};
}
export function documentCondition(documents){
  return {sql:documents.map(()=>`COALESCE((SELECT revision FROM json_documents WHERE key=? AND part=0),0)=?`).join(' AND ')||'1',values:documents.flatMap(document=>[document.key,document.revision])};
}
