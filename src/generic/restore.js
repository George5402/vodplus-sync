// 数据记录与文件 JSON 快照共同组成恢复会话，应用成功后原子确认。
import {assert,json} from '../lib/http.js';
import {digest,token} from '../lib/crypto.js';
import {one,all,stmt} from '../lib/db.js';
import {syncSettings} from '../sync/settings.js';
import {requestId,scopeValue} from './input.js';
import {snapshotStatements,differenceStatement} from './snapshot.js';
import {heldScope,heldScopeValues,rememberRestored} from './held.js';
import {headsSql,emptyRestore,isEmptyRestore,acknowledgeEmpty,rememberRestoreSummary,latestRestoreSql,invalidateOverlappingBaselines} from './summary.js';
import {prepareFileRestore,fileRestorePage,fileRestoreContent,prepareFileAcknowledgement} from './file-restore.js';

async function sessionInfo(env,row){
  const total=row.data_count+row.file_count;
  const page=isEmptyRestore(row)?null:row.data_count?(await one(env,'SELECT marker FROM restore_items WHERE session=? ORDER BY position LIMIT 1',row.token))?.marker??null:row.file_page;
  return {session:row.token,mode:row.mode,page,total,expiresAt:row.expires,policy:JSON.parse(row.policy)};
}
async function start(env,device,input,attempt=0){
  const operation=requestId(input.requestId),selection=scopeValue(input.scope),scope=JSON.stringify(selection);
  assert(input.full===undefined||typeof input.full==='boolean',400,'full 必须是布尔值');
  const fingerprint=await digest(JSON.stringify([scope,input.full===true]));
  const find=()=>one(env,'SELECT * FROM restore_sessions WHERE device=? AND request_id=?',device.id,operation);
  const previous=await find();
  if(previous){assert(previous.fingerprint===fingerprint,409,'恢复范围变化，请开始新的下载');assert(previous.expires>Date.now(),410,'下载会话已过期，请重新开始');return json(await sessionInfo(env,previous));}
  const scopeHash=await digest(scope),session=token(),rules=await syncSettings(env),policy=JSON.stringify(rules),now=Date.now();
  try{
    if(!input.full){const empty=await emptyRestore(env,device,{session,operation,fingerprint,scopeHash,scope,policy,now});if(empty)return json(await sessionInfo(env,empty));}
    const files=await prepareFileRestore(env,device,{session,scope:selection,scopeHash,policy:rules,full:input.full});
    const started='EXISTS(SELECT 1 FROM restore_sessions WHERE token=?)',data=selection.namespaces.length>0;
    const batch=[
      stmt(env,`INSERT INTO restore_sessions(token,owner,device,request_id,fingerprint,scope_hash,scope,mode,policy,created,expires)
        SELECT ?,?,?,?,?,?,json_set(?,'$._heads',json(${headsSql})),CASE WHEN ? OR EXISTS(SELECT 1 FROM restore_baselines WHERE device=? AND scope_hash=? AND dirty=1) THEN 'full'
          WHEN EXISTS(SELECT 1 FROM restore_baselines WHERE device=? AND scope_hash=? AND dirty=0) OR EXISTS(SELECT 1 FROM device_contents h WHERE h.device=? AND ${heldScope()}) OR ? THEN 'delta' ELSE 'full' END,?,?,?
        WHERE ${files?files.condition.sql:'1'} AND EXISTS(SELECT 1 FROM sync_settings WHERE id=1 AND revision=?)`,
        session,device.user_id,device.id,operation,fingerprint,scopeHash,scope,device.user_id,(input.full||files?.forced)?1:0,device.id,scopeHash,device.id,scopeHash,device.id,...heldScopeValues(scope),files?.hasHeld?1:0,policy,now,now+86400000,...(files?.condition.values??[]),rules.revision),
      stmt(env,`DELETE FROM device_sync_summaries WHERE device=? AND ${started}`,device.id,session),
      invalidateOverlappingBaselines(env,device,scopeHash,scope,started,[session])
    ];
    if(data)batch.push(
      ...snapshotStatements(env,device,session,scope,policy),
      stmt(env,`INSERT OR IGNORE INTO restore_known(device,scope_hash,identity,type,namespace,key,path) SELECT ?,?,h.identity,h.type,h.namespace,h.key,h.path FROM device_contents h WHERE h.device=? AND ${heldScope()} AND ${started}`,device.id,scopeHash,device.id,...heldScopeValues(scope),session),
      differenceStatement(env,device,session,scopeHash,scope,policy),
      stmt(env,`DELETE FROM device_contents AS h WHERE h.device=? AND ${heldScope()} AND ${started}`,device.id,...heldScopeValues(scope),session),
      stmt(env,`INSERT OR IGNORE INTO restore_known(device,scope_hash,identity,type,namespace,key,path) SELECT ?,?,identity,type,namespace,key,path FROM restore_snapshots WHERE session=? AND ${started}`,device.id,scopeHash,session,session)
    );
    batch.push(
      ...(files?.statements()??[]),
      stmt(env,`INSERT INTO restore_baselines(device,scope_hash,session,seq,dirty) SELECT ?,?,'',0,1 WHERE ${started} ON CONFLICT(device,scope_hash) DO UPDATE SET dirty=1`,device.id,scopeHash,session),
      stmt(env,'UPDATE restore_sessions SET data_count=(SELECT COUNT(*) FROM restore_items WHERE session=?),file_count=?,file_page=? WHERE token=?',session,files?.total??0,files?.page??null,session)
    );
    const result=await env.DB.batch(batch);
    if(!result[0].meta.changes){assert(attempt<4,503,'同步清单正在更新，请重试下载',{retryable:true});return start(env,device,input,attempt+1);}
  }catch(error){
    const raced=await find();if(!raced)throw error;
    assert(raced.fingerprint===fingerprint,409,'恢复范围变化，请开始新的下载');return json(await sessionInfo(env,raced));
  }
  return json(await sessionInfo(env,await find()));
}
async function acknowledge(env,device,row,attempt=0){
  assert(row.delivered>=row.data_count+row.file_count,409,'恢复包尚未全部获取，请继续下载');
  const files=await prepareFileAcknowledgement(env,device,row),data=JSON.parse(row.scope).namespaces.length>0;
  const guard='EXISTS(SELECT 1 FROM restore_sessions WHERE token=? AND acknowledged=2)';
  const batch=[stmt(env,`UPDATE restore_sessions SET acknowledged=2 WHERE token=? AND acknowledged=0 AND seq=${latestRestoreSql}${files?' AND '+files.condition.sql:''}`,row.token,...(files?.condition.values??[])),
    stmt(env,`UPDATE restore_baselines SET session=?,seq=?,dirty=0 WHERE device=? AND scope_hash=? AND ${guard}`,row.token,row.seq,device.id,row.scope_hash,row.token),
    invalidateOverlappingBaselines(env,device,row.scope_hash,row.scope,guard,[row.token])];
  if(data)batch.push(
    stmt(env,`DELETE FROM restore_known WHERE device=? AND scope_hash=? AND NOT EXISTS(SELECT 1 FROM restore_snapshots n WHERE n.session=? AND n.identity=restore_known.identity) AND ${guard}`,device.id,row.scope_hash,row.token,row.token),
    stmt(env,`INSERT OR IGNORE INTO restore_known(device,scope_hash,identity,type,namespace,key,path) SELECT ?,?,identity,type,namespace,key,path FROM restore_snapshots WHERE session=? AND ${guard}`,device.id,row.scope_hash,row.token,row.token),
    rememberRestored(env,device,row)
  );
  batch.push(...(files?.statements()??[]),
    stmt(env,`UPDATE devices SET status='下载成功' WHERE id=? AND ${guard}`,device.id,row.token),
    rememberRestoreSummary(env,device,row),
    stmt(env,'UPDATE restore_sessions SET acknowledged=1 WHERE token=? AND acknowledged=2',row.token));
  const result=await env.DB.batch(batch);
  if(!result[0].meta.changes){
    const current=await one(env,'SELECT * FROM restore_sessions WHERE token=?',row.token);if(current?.acknowledged)return json({ok:true});
    const latest=await one(env,'SELECT MAX(seq) seq FROM restore_sessions WHERE device=? AND scope_hash=?',device.id,row.scope_hash);
    assert(latest.seq===row.seq,409,'已有较新的下载任务，请重新开始完整下载',{code:'RESTORE_SUPERSEDED'});
    assert(attempt<4,503,'设备状态正在更新，请重试确认',{retryable:true});return acknowledge(env,device,current,attempt+1);
  }
  return json({ok:true});
}
export async function restore(env,device,input){
  if(input.action==='start')return start(env,device,input);
  assert(typeof input.session==='string',400,'缺少下载会话');
  const row=await one(env,'SELECT * FROM restore_sessions WHERE token=? AND device=? AND owner=?',input.session,device.id,device.user_id);
  assert(row,404,'下载会话不存在');
  if(input.action==='ack'&&row.acknowledged)return json({ok:true});
  assert(row.expires>Date.now(),410,'下载会话已过期，请重新开始');
  if(isEmptyRestore(row)){assert(input.action==='ack',404,'恢复包不存在');return acknowledgeEmpty(env,device,row);}
  if(input.action==='page'){
    assert(typeof input.page==='string',400,'缺少恢复包标记');
    const first=await one(env,'SELECT position FROM restore_items WHERE session=? AND marker=?',row.token,input.page);
    if(!first&&row.file_count)return fileRestorePage(env,row,input.page);assert(first,404,'恢复包不存在');
    const rows=await all(env,'SELECT * FROM restore_items WHERE session=? AND position>=? ORDER BY position LIMIT 26',row.token,first.position);
    const page=rows.slice(0,25),last=page.at(-1).position;
    await stmt(env,'UPDATE restore_sessions SET delivered=MAX(delivered,?) WHERE token=? AND delivered>=?',last,row.token,first.position-1).run();
    const items=page.map(item=>({type:'data',op:item.op,namespace:item.namespace,key:item.key,...(item.op==='put'?{value:JSON.parse(item.value)}:{})}));
    const next=rows[25]?.marker??row.file_page;return json({items,next,done:!next});
  }
  if(input.action==='content'){assert(typeof input.content==='string',400,'缺少文件内容标记');return fileRestoreContent(env,device,row,input.content);}
  if(input.action==='ack')return acknowledge(env,device,row);
  assert(false,400,'不支持的恢复操作');
}
