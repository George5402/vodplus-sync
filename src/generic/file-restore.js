// 文件快照、变化清单与设备状态各使用 JSON 文档，正文按固定摘要读取 BLOB。
import {assert,inside,json} from '../lib/http.js';
import {one,stmt} from '../lib/db.js';
import {Catalog,readCatalog} from '../storage/catalog.js';
import {readDocument,writeDocument,documentCondition} from '../storage/documents.js';
import {fileDeviceState,visibleFiles,inFileScope,allowed,setEntry} from '../storage/file-sync.js';
import {getContent} from '../storage/content.js';
const restoreKey=session=>`restore-files:${session}`;
export async function prepareFileRestore(env,device,{session,scope,scopeHash,policy,full}){
  if(!scope.files)return null;
  const catalog=await readCatalog(env,device.user_id),model=new Catalog(catalog.value),state=await fileDeviceState(env,device.id);
  const baseline=await one(env,'SELECT dirty FROM restore_baselines WHERE device=? AND scope_hash=?',device.id,scopeHash);
  const pending=Object.values(state.value.dirty).some(item=>item.roots.some(root=>scope.roots.some(other=>inside(root,other)||inside(other,root))));
  const forced=!!full||!!baseline?.dirty||pending,snapshot={},changes=[],next=structuredClone(state.value);
  const visible=visibleFiles(model,scope,policy),paths=new Set(visible.map(item=>model.path(item).toLowerCase()));
  for(const file of visible){
    const path=model.path(file),held=state.value.held[file.id];
    setEntry(snapshot,file.id,{path,size:file.size,hash:file.hash});
    if(forced||!held||held.tag!==file.tag||held.path!==path)changes.push({op:'put',id:file.id,marker:crypto.randomUUID().replaceAll('-','')});
  }
  const deleted=new Set();
  for(const path of Object.keys(state.value.known))if(inFileScope(path,scope)&&allowed(policy,path)&&!paths.has(path.toLowerCase())&&!deleted.has(path)){
    changes.push({op:'delete',path});deleted.add(path);
  }
  for(const item of Object.values(snapshot))setEntry(next.known,item.path,true);
  setEntry(next.dirty,scopeHash,{token:session,roots:scope.roots});
  const pages=Array.from({length:Math.ceil(changes.length/25)},()=>crypto.randomUUID().replaceAll('-',''));
  const document={key:restoreKey(session),revision:0};
  const condition=documentCondition([catalog,state]);
  return {forced,hasHeld:Object.values(state.value.held).some(item=>inFileScope(item.path,scope)),condition,total:changes.length,page:pages[0]??null,
    statements:()=>{
      const guard='EXISTS(SELECT 1 FROM restore_sessions WHERE token=?)',values=[session];
      return [...writeDocument(env,document,{snapshot,changes,pages},guard,values),...writeDocument(env,state,next,guard,values)];
    }};
}
export async function fileRestorePage(env,row,marker){
  const document=await readDocument(env,restoreKey(row.token),null);assert(document.value,404,'恢复文件清单不存在');
  const index=document.value.pages.indexOf(marker);assert(index>=0,404,'恢复包不存在');
  const page=document.value.changes.slice(index*25,index*25+25);
  const items=page.map(change=>change.op==='delete'?{type:'file',op:'delete',path:change.path}:{type:'file',op:'put',path:document.value.snapshot[change.id].path,size:document.value.snapshot[change.id].size,content:change.marker});
  const first=row.data_count+index*25+1,last=first+page.length-1;
  await stmt(env,'UPDATE restore_sessions SET delivered=MAX(delivered,?) WHERE token=? AND delivered>=?',last,row.token,first-1).run();
  return json({items,next:document.value.pages[index+1]??null,done:index+1>=document.value.pages.length});
}
export async function fileRestoreContent(env,device,row,marker){
  const document=await readDocument(env,restoreKey(row.token),null);assert(document.value,404,'恢复文件清单不存在');
  const item=document.value.changes.find(change=>change.op==='put'&&change.marker===marker);assert(item,404,'恢复文件不存在');
  const content=await getContent(env,device.user_id,document.value.snapshot[item.id].hash);assert(content,404,'文件内容不存在');
  return new Response(content.body,{headers:{'content-type':'application/octet-stream','content-length':String(content.size)}});
}
export async function prepareFileAcknowledgement(env,device,row){
  const scope=JSON.parse(row.scope);if(!scope.files)return null;
  const document=await readDocument(env,restoreKey(row.token),null);assert(document.value,404,'恢复文件清单不存在');
  const state=await fileDeviceState(env,device.id);assert(state.value.dirty[row.scope_hash]?.token===row.token,409,'已有较新的下载任务，请重新开始完整下载',{code:'RESTORE_SUPERSEDED'});
  const policy=JSON.parse(row.policy),next=structuredClone(state.value);
  for(const [key,item] of Object.entries(next.held))if(inFileScope(item.path,scope)&&allowed(policy,item.path))delete next.held[key];
  for(const path of Object.keys(next.known))if(inFileScope(path,scope)&&allowed(policy,path))delete next.known[path];
  for(const [id,item] of Object.entries(document.value.snapshot)){
    setEntry(next.held,id,{tag:item.hash.slice(0,32),path:item.path});setEntry(next.known,item.path,true);
  }
  delete next.dirty[row.scope_hash];
  return {condition:documentCondition([state]),statements:()=>writeDocument(env,state,next,'EXISTS(SELECT 1 FROM restore_sessions WHERE token=? AND acknowledged=2)',[row.token])};
}
