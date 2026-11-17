// 文件发布清单与设备基线集中保存在 JSON 文档中，按数字文件 ID 比较内容指纹。
import {assert,inside} from '../lib/http.js';
import {readDocument} from './documents.js';
import {assertFileAllowed} from '../sync/settings.js';
export const filePublication=(env,session)=>readDocument(env,`publish-files:${session}`,()=>({items:{}}));
export const fileDeviceState=(env,device)=>readDocument(env,`device-files:${device}`,()=>({held:{},known:{},dirty:{}}));
export function setEntry(object,key,value){Object.defineProperty(object,String(key),{value,writable:true,configurable:true,enumerable:true});}
export const inFileScope=(path,scope)=>scope.files&&scope.roots.some(root=>inside(path,root));
export function allowed(policy,path){try{assertFileAllowed(policy,path);return true;}catch(error){if(error.status===422)return false;throw error;}}
export function visibleFiles(model,scope,policy){
  const blocked=model.items().filter(item=>item.kind==='directory'&&!item.deleted&&!item.enabled).map(item=>model.path(item));
  return model.items().filter(item=>item.kind==='file'&&!item.deleted&&item.enabled&&inFileScope(model.path(item),scope)&&allowed(policy,model.path(item))&&!blocked.some(root=>inside(model.path(item),root)));
}
export function pendingFiles(model,publication,scope,policy){
  const visible=new Map(visibleFiles(model,scope,policy).map(item=>[model.path(item),item]));const pending=[];
  for(const [path,item] of Object.entries(publication.value.items)){
    if(item.excluded||!inFileScope(path,scope)||!allowed(policy,path))continue;
    const current=visible.get(path);
    if(!current||current.tag!==item.tag||current.size!==item.size)pending.push({type:'file',path});
  }
  return pending;
}
export function updateFileState(model,document,publication,scope,policy){
  const next=structuredClone(document.value);
  const initial=publication.value.policy??policy;
  for(const [id,item] of Object.entries(next.held))if(inFileScope(item.path,scope)&&allowed(policy,item.path)&&allowed(initial,item.path))delete next.held[id];
  for(const path of Object.keys(next.known))if(inFileScope(path,scope)&&allowed(policy,path)&&allowed(initial,path))delete next.known[path];
  for(const file of visibleFiles(model,scope,policy)){
    const path=model.path(file);if(!Object.hasOwn(publication.value.items,path)||publication.value.items[path].excluded||!allowed(initial,path))continue;
    setEntry(next.held,file.id,{tag:file.tag,path});setEntry(next.known,path,true);
  }
  if(initial.revision===policy.revision)for(const [key,pending] of Object.entries(next.dirty))if(pending.roots.every(root=>scope.roots.some(parent=>inside(root,parent))))delete next.dirty[key];
  return next;
}
export function verifyFingerprint(hash){assert(typeof hash==='string'&&/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(hash),400,'内容指纹需要 32 或 64 位小写十六进制');return hash.slice(0,32);}
