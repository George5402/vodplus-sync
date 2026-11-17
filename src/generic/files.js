// 文件正文与目录、发布清单在同一事务内更新，公开请求格式保持不变。
import {assert,bytes,json,relativePath,Fault} from '../lib/http.js';
import {digest} from '../lib/crypto.js';
import {stmt} from '../lib/db.js';
import {syncSettings,assertFileAllowed} from '../sync/settings.js';
import {requestId} from './input.js';
import {publishing,publicationGuard} from './publication.js';
import {mutateFiles} from '../storage/file-transaction.js';
import {apiId} from '../storage/catalog.js';
import {filePublication,setEntry,inFileScope} from '../storage/file-sync.js';

export async function pushFile(env,request,url,device){
  const path=relativePath(url.searchParams.get('path')),operation=requestId(request.headers.get('idempotency-key'));
  const deleting=request.method==='DELETE',content=deleting?null:await bytes(request,1572864),session=request.headers.get('x-sync-session');
  const hash=deleting?null:await digest(content),fingerprint=await digest(JSON.stringify([request.method,path,hash,session]));
  const owner=device.user_id,principal=`v2:${device.id}`;
  const result=await mutateFiles(env,{owner,principal,operation,fingerprint,prepare:async model=>{
    const scope=await publishing(env,device,session);
    assert(!scope||inFileScope(path,scope),400,'文件不在本次推送范围内');
    const policy=await syncSettings(env);
    try{assertFileAllowed(policy,path);}catch(error){if(error instanceof Fault&&error.status===422)return {result:{ok:true,skipped:true,reason:error.detail.code}};throw error;}
    const snapshots=[],source=`device:${device.id}`,now=Date.now();
    if(deleting){
      const item=model.byPath(path);assert(!item||item.kind==='file',422,'目标不是普通文件');
      if(item){const row={...model.row(item),deleted:1,version:item.version+1,source,updated:now};model.set(row);snapshots.push(row);}
    }else{
      const parts=path.split('/');
      for(let i=1;i<parts.length;i++){
        const parentPath=parts.slice(0,i).join('/');const parent=model.byPath(parentPath);
        assert(!parent||parent.kind==='directory',422,'父路径不是目录');
        if(!parent||!parent.enabled){const row={id:parent?apiId(parent):crypto.randomUUID(),kind:'directory',path:parentPath,version:(parent?.version??0)+1,data:{},deleted:0,enabled:1,source,updated:now};model.set(row);snapshots.push(row);}
      }
      const current=model.byPath(path);assert(!current||current.kind==='file',422,'目标路径已被目录占用');
      if(!current||current.hash!==hash||!current.enabled||model.path(current)!==path){
        const row={id:current?apiId(current):crypto.randomUUID(),kind:'file',path,version:(current?.version??0)+1,data:{hash,size:content.length},deleted:0,enabled:1,source,updated:now};
        model.set(row);snapshots.push(row);
      }
    }
    const documents=[];
    if(session){
      const document=await filePublication(env,session),value=structuredClone(document.value);
      if(deleting)delete value.items[path];else setEntry(value.items,path,{tag:hash.slice(0,32),size:content.length});
      documents.push({document,value});
    }
    return {snapshots,documents,result:deleting?{ok:true,path}:{ok:true,path,size:content.length},
      condition:'EXISTS(SELECT 1 FROM sync_settings WHERE id=1 AND revision=?)'+(session?' AND '+publicationGuard:''),
      conditionValues:[policy.revision,...(session?[session,device.id,Date.now()]:[])],
      statements:(guard,values)=>deleting?[]:[stmt(env,`INSERT OR IGNORE INTO file_contents(owner,hash,size,content,created) SELECT ?,?,?,?,? WHERE ${guard}`,owner,hash,content.length,content.buffer.slice(content.byteOffset,content.byteOffset+content.byteLength),now,...values)]};
  }});
  return json(result);
}
