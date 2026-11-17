// 紧凑状态只判断选中分区是否变化，数据变更仍使用完整的事务恢复流程。
import {assert,json} from '../lib/http.js';
import {one,stmt} from '../lib/db.js';
export const EMPTY_HEADS='{"files":0,"data":{}}';
export const headsSql="COALESCE((SELECT state FROM sync_heads WHERE owner=?),'{\"files\":0,\"data\":{}}')";
// 分别命中已确认/未确认两段索引末端，避免每次确认扫描全部历史会话。
export const latestRestoreSql=`MAX(
  COALESCE((SELECT MAX(s.seq) FROM restore_sessions s WHERE s.device=restore_sessions.device AND s.scope_hash=restore_sessions.scope_hash AND s.acknowledged=0),0),
  COALESCE((SELECT MAX(s.seq) FROM restore_sessions s WHERE s.device=restore_sessions.device AND s.scope_hash=restore_sessions.scope_hash AND s.acknowledged=1),0))`;
export function invalidateOverlappingBaselines(env,device,scopeHash,scope,guard,values){
  return stmt(env,`DELETE FROM restore_baselines AS b WHERE b.device=? AND b.scope_hash<>? AND b.dirty=0 AND EXISTS(
    SELECT 1 FROM restore_sessions s WHERE s.token=b.session AND (
      EXISTS(SELECT 1 FROM json_each(s.scope,'$.namespaces') n WHERE n.value IN(SELECT value FROM json_each(?,'$.namespaces')))
      OR (json_extract(s.scope,'$.files')=1 AND json_extract(?,'$.files')=1 AND EXISTS(
        SELECT 1 FROM json_each(s.scope,'$.roots') a JOIN json_each(?,'$.roots') z ON a.value='' OR z.value='' OR a.value=z.value OR substr(a.value,1,length(z.value)+1)=z.value||'/' OR substr(z.value,1,length(a.value)+1)=a.value||'/'))))
    AND ${guard}`,device.id,scopeHash,scope,scope,scope,...values);
}
const parse=text=>{try{return JSON.parse(text);}catch{return null;}};
const unchanged=(saved,current,scope)=>saved&&(!scope.files||(saved.files??0)===(current.files??0))&&scope.namespaces.every(name=>(saved.data?.[name]??0)===(current.data?.[name]??0));
function covers(saved,scope){return saved&&scope.namespaces.every(name=>saved.namespaces.includes(name))&&(!scope.files||(saved.files&&scope.roots.every(root=>saved.roots.some(parent=>!parent||root===parent||root.startsWith(parent+'/')))));}

export function rememberPushSummary(env,device,row,policyRevision,allowed=true){
  return stmt(env,`INSERT INTO device_sync_summaries(device,state)
    SELECT ?,json_object('scope',json(?),'heads',json(${headsSql}),'policyRevision',?)
    WHERE ? AND EXISTS(SELECT 1 FROM publish_sessions WHERE token=? AND finished=2)
      AND NOT EXISTS(SELECT 1 FROM publish_items p WHERE p.session=? AND NOT EXISTS(SELECT 1 FROM publish_checks c WHERE c.session=p.session AND c.identity=p.identity))
    ON CONFLICT(device) DO UPDATE SET state=excluded.state WHERE device_sync_summaries.state<>excluded.state`,device.id,row.scope,device.user_id,policyRevision,allowed?1:0,row.token,row.token);
}
export function rememberRestoreSummary(env,device,row){
  return stmt(env,`INSERT INTO device_sync_summaries(device,state)
    SELECT ?,json_object('scope',json_remove(scope,'$._heads'),'heads',json_extract(scope,'$._heads'),'policyRevision',json_extract(policy,'$.revision'))
    FROM restore_sessions WHERE token=? AND acknowledged=2 AND json_type(scope,'$._heads')='object'
    ON CONFLICT(device) DO UPDATE SET state=excluded.state WHERE device_sync_summaries.state<>excluded.state`,device.id,row.token);
}

export async function emptyRestore(env,device,{session,operation,fingerprint,scopeHash,scope,policy,now}){
  const selected=JSON.parse(scope),rules=JSON.parse(policy);
  const states=await env.DB.batch([
    stmt(env,'SELECT state FROM sync_heads WHERE owner=?',device.user_id),
    stmt(env,'SELECT b.dirty,b.session,s.scope,s.policy,s.acknowledged FROM restore_baselines b JOIN restore_sessions s ON s.token=b.session WHERE b.device=? AND b.scope_hash=?',device.id,scopeHash),
    stmt(env,'SELECT state FROM device_sync_summaries WHERE device=?',device.id)
  ]);
  const rawHeads=states[0].results[0]?.state??EMPTY_HEADS,current=parse(rawHeads),baseline=states[1].results[0],rawSummary=states[2].results[0]?.state;
  if(!current||baseline?.dirty)return null;
  let condition,values;
  if(baseline?.acknowledged&&(!selected.files||parse(baseline.policy)?.revision===rules.revision)&&unchanged(parse(baseline.scope)?._heads,current,selected)){
    condition='EXISTS(SELECT 1 FROM restore_baselines WHERE device=? AND scope_hash=? AND session=? AND dirty=0)';values=[device.id,scopeHash,baseline.session];
  }else{
    const summary=parse(rawSummary);
    if(!covers(summary?.scope,selected)||!unchanged(summary?.heads,current,selected)||(selected.files&&summary.policyRevision!==rules.revision))return null;
    condition='EXISTS(SELECT 1 FROM device_sync_summaries WHERE device=? AND state=?)';values=[device.id,rawSummary];
  }
  // 与空间状态一起校验，检查和创建空会话之间的并发修改不会被跳过。
  return stmt(env,`INSERT INTO restore_sessions(token,owner,device,request_id,fingerprint,scope_hash,scope,mode,policy,created,expires)
    SELECT ?,?,?,?,?,?,json_set(?,'$._fast',json('true')),'delta',?,?,?
    WHERE ${headsSql}=? AND EXISTS(SELECT 1 FROM sync_settings WHERE id=1 AND revision=?) AND ${condition}
    RETURNING *`,session,device.user_id,device.id,operation,fingerprint,scopeHash,scope,policy,now,now+86400000,device.user_id,rawHeads,rules.revision,...values).first();
}
export const isEmptyRestore=row=>parse(row.scope)?._fast===true;
export async function acknowledgeEmpty(env,device,row){
  const result=await env.DB.batch([
    stmt(env,`UPDATE restore_sessions SET acknowledged=1 WHERE token=? AND seq=${latestRestoreSql}`,row.token),
    stmt(env,"UPDATE devices SET status='下载成功' WHERE id=? AND status<>'下载成功' AND EXISTS(SELECT 1 FROM restore_sessions WHERE token=? AND acknowledged=1)",device.id,row.token)
  ]);
  assert(result[0].meta.changes>0,409,'已有较新的下载任务，请重新开始完整下载',{code:'RESTORE_SUPERSEDED'});
  return json({ok:true});
}
