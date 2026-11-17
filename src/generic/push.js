// 通用记录以 namespace/key 定位，服务端生成 ID；事务回执保障重试不会重复发布。
import {assert,json} from '../lib/http.js';
import {digest} from '../lib/crypto.js';
import {one,stmt} from '../lib/db.js';
import {namespace,dataKey,requestId} from './input.js';
import {publishing,publicationGuard} from './publication.js';
import {valueDigest} from '../lib/content-digest.js';

export async function receipt(env,device,operation,fingerprint){
  const row=await one(env,'SELECT fingerprint,result FROM receipts WHERE principal=? AND op_id=?',`v2:${device.id}`,operation);
  if(row)assert(row.fingerprint===fingerprint,409,'重试内容已变化，请开始新的推送');
  return row?JSON.parse(row.result):null;
}
export function receiptStatement(env,device,operation,fingerprint,nonce,result,condition='1',values=[]){
  return stmt(env,`INSERT OR IGNORE INTO receipts(principal,op_id,fingerprint,nonce,result,created) SELECT ?,?,?,?,?,? WHERE ${condition}`,
    `v2:${device.id}`,operation,fingerprint,nonce,JSON.stringify(result),Date.now(),...values);
}
export const receiptGuard='EXISTS(SELECT 1 FROM receipts WHERE principal=? AND op_id=? AND nonce=?)';
export const receiptValues=(device,operation,nonce)=>[`v2:${device.id}`,operation,nonce];

export async function pushData(env,device,input){
  const operation=requestId(input.requestId);const space=namespace(input.namespace);
  assert(!space.startsWith('legacy.'),400,'旧数据分区为只读，请写入自己的数据分区');
  const upsert=input.upsert??[];const remove=input.delete??[];
  assert(Array.isArray(upsert)&&Array.isArray(remove)&&upsert.length+remove.length>0&&upsert.length+remove.length<=50,400,'一次推送需要 1–50 条记录');
  const keys=new Set();const rows=[];
  for(const item of [...upsert.map(item=>({...item,deleted:0})),...remove.map(key=>({key,deleted:1}))]){
    const key=dataKey(item.key);assert(!keys.has(key),400,'同一批次不能重复修改同一记录');keys.add(key);
    assert(item.deleted||item.value!==undefined,400,'缺少记录内容');
    const value=JSON.stringify({namespace:space,key,value:item.deleted?null:item.value});
    assert(new TextEncoder().encode(value).length<=16384,413,'单条记录超过 16 KiB');
    let hash=null;if(!item.deleted&&input.session){try{hash=(await valueDigest(item.value)).slice(0,32);}catch{assert(false,400,'JSON 内容不能生成有效摘要');}}
    rows.push({id:'record_'+await digest(JSON.stringify([space,key])),key,data:value,hash,deleted:item.deleted});
  }
  const fingerprint=await digest(JSON.stringify(['data',input]));
  const previous=await receipt(env,device,operation,fingerprint);if(previous)return json(previous);
  const scope=await publishing(env,device,input.session);
  assert(!scope||scope.namespaces.includes(space),400,'数据分区不在本次推送范围内');
  const nonce=crypto.randomUUID(),result={ok:true},encoded=JSON.stringify(rows),owner=device.user_id,now=Date.now();
  const batch=[
    receiptStatement(env,device,operation,fingerprint,nonce,result,`(SELECT COUNT(*) FROM entities WHERE owner=?)+(SELECT COUNT(*) FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM entities WHERE owner=? AND id=json_extract(j.value,'$.id')))<=5000${scope?' AND '+publicationGuard:''}`,[owner,encoded,owner,...(scope?[input.session,device.id,Date.now()]:[])]),
    stmt(env,`INSERT INTO entities(owner,id,kind,path,version,data,deleted,enabled,source,updated)
      SELECT ?,json_extract(j.value,'$.id'),'record',NULL,1,json_extract(j.value,'$.data'),json_extract(j.value,'$.deleted'),1,?,?
      FROM json_each(?) j WHERE ${receiptGuard}
      ON CONFLICT(owner,id) DO UPDATE SET version=entities.version+1,data=excluded.data,deleted=excluded.deleted,enabled=1,source=excluded.source,updated=excluded.updated
      WHERE entities.data<>excluded.data OR entities.deleted<>excluded.deleted OR entities.enabled<>1`,owner,`device:${device.id}`,now,encoded,...receiptValues(device,operation,nonce))
  ];
  if(scope)batch.push(stmt(env,`INSERT OR IGNORE INTO publish_items(session,identity) SELECT ?,json_array('data',?,json_extract(j.value,'$.key')) FROM json_each(?) j WHERE ${receiptGuard}`,input.session,space,JSON.stringify(upsert),...receiptValues(device,operation,nonce)));
  if(scope)batch.push(
    stmt(env,`INSERT INTO publish_checks(session,identity,type,namespace,key,hash,entity_id,version)
      SELECT ?,json_array('data',?,json_extract(j.value,'$.key')),'data',?,json_extract(j.value,'$.key'),json_extract(j.value,'$.hash'),e.id,e.version
      FROM json_each(?) j JOIN entities e ON e.owner=? AND e.id=json_extract(j.value,'$.id')
      WHERE json_extract(j.value,'$.deleted')=0 AND EXISTS(SELECT 1 FROM publish_checks c WHERE c.session=? AND c.identity=json_array('data',?,json_extract(j.value,'$.key'))) AND ${receiptGuard}
      ON CONFLICT(session,identity) DO UPDATE SET hash=excluded.hash,entity_id=excluded.entity_id,version=excluded.version`,input.session,space,space,encoded,owner,input.session,space,...receiptValues(device,operation,nonce)),
    stmt(env,`DELETE FROM publish_checks WHERE session=? AND identity IN(SELECT json_array('data',?,value) FROM json_each(?)) AND ${receiptGuard}`,input.session,space,JSON.stringify(remove),...receiptValues(device,operation,nonce))
  );
  await env.DB.batch(batch);
  if(scope)await publishing(env,device,input.session);
  const saved=await receipt(env,device,operation,fingerprint);assert(saved,413,'用户空间已达记录容量上限');return json(saved);
}
