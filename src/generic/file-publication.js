// 文件发布确认只比较两份 JSON 清单，缺失项删除与设备状态原子提交。
import {stmt} from '../lib/db.js';
import {Catalog,readCatalog} from '../storage/catalog.js';
import {filePublication,fileDeviceState,pendingFiles,inFileScope,allowed,updateFileState} from '../storage/file-sync.js';
import {documentCondition,writeDocument} from '../storage/documents.js';
export async function prepareFilePublication(env,device,row,policy){
  const scope=JSON.parse(row.scope);if(!scope.files)return null;
  const catalog=await readCatalog(env,device.user_id),publication=await filePublication(env,row.token),state=await fileDeviceState(env,device.id);
  const model=new Catalog(structuredClone(catalog.value)),pending=pendingFiles(model,publication,scope,policy);
  const condition=documentCondition([catalog,publication,state]),snapshots=[],source=`device:${device.id}`,initial=publication.value.policy??policy;
  if(!pending.length)for(const item of model.items()){
    const path=model.path(item);
    if(item.kind!=='file'||item.deleted||!inFileScope(path,scope)||!allowed(policy,path)||!allowed(initial,path)||Object.hasOwn(publication.value.items,path))continue;
    const deleted={...model.row(item),deleted:1,version:item.version+1,source,updated:Date.now()};model.set(deleted);snapshots.push(deleted);
  }
  const nextState=updateFileState(model,state,publication,scope,policy);
  return {pending,condition,summarySafe:initial.revision===policy.revision,statements:()=>{
    const guard='EXISTS(SELECT 1 FROM publish_sessions WHERE token=? AND finished=2)',values=[row.token],statements=[];
    if(snapshots.length)statements.push(...writeDocument(env,catalog,model.value,guard,values,{count:model.items().length}));
    if(JSON.stringify(nextState)!==JSON.stringify(state.value))statements.push(...writeDocument(env,state,nextState,guard,values));
    for(const snapshot of snapshots){const encoded=JSON.stringify(snapshot);statements.push(
      stmt(env,`INSERT INTO versions(owner,entity_id,version,snapshot,created) SELECT ?,?,?,?,? WHERE ${guard}`,device.user_id,snapshot.id,snapshot.version,encoded,snapshot.updated,...values),
      stmt(env,`INSERT INTO changes(owner,entity_id,version,snapshot,source,created) SELECT ?,?,?,?,?,? WHERE ${guard}`,device.user_id,snapshot.id,snapshot.version,encoded,source,snapshot.updated,...values),
      stmt(env,`DELETE FROM versions WHERE owner=? AND entity_id=? AND version<? AND ${guard}`,device.user_id,snapshot.id,snapshot.version-19,...values));}
    if(snapshots.length)statements.push(stmt(env,`INSERT INTO sync_heads(owner,state) SELECT ?,json_object('files',1,'data',json('{}')) WHERE ${guard}
      ON CONFLICT(owner) DO UPDATE SET state=json_set(state,'$.files',COALESCE(json_extract(state,'$.files'),0)+1)`,device.user_id,...values));
    return statements;
  }};
}
