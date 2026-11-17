// 文件清单在内存中比较，只有结构化记录按主键查询；比对结果集中保存为 JSON。
import {assert,json,relativePath,Fault} from '../lib/http.js';
import {digest} from '../lib/crypto.js';
import {valueDigest} from '../lib/content-digest.js';
import {all,stmt} from '../lib/db.js';
import {namespace,dataKey} from './input.js';
import {publishing,publicationGuard} from './publication.js';
import {syncSettings,assertFileAllowed} from '../sync/settings.js';
import {allowedFile,policyValues} from './snapshot.js';
import {Catalog,readCatalog} from '../storage/catalog.js';
import {documentCondition,primaryDocument} from '../storage/documents.js';
import {filePublication,setEntry,visibleFiles,verifyFingerprint} from '../storage/file-sync.js';

export const matchingCheck=`EXISTS(SELECT 1 FROM entities e WHERE e.owner=? AND e.id=c.entity_id AND e.version=c.version AND e.deleted=0 AND e.enabled=1)`;
export const pendingChecks=`SELECT c.* FROM publish_checks c WHERE c.session=? AND (c.type='data' OR (${allowedFile('c.path')})) AND NOT ${matchingCheck}`;
export const pendingValues=(session,scope,policy,owner)=>[session,...policyValues(scope,policy),owner];
export const checkIdentity=item=>item.type==='data'?{type:'data',namespace:item.namespace,key:item.key}:{type:'file',path:item.path};

export async function checkPush(env,device,input,attempt=0){
  assert(typeof input.session==='string',400,'缺少发布会话');
  const scope=await publishing(env,device,input.session),policy=await syncSettings(env);
  assert(Array.isArray(input.items)&&input.items.length>0&&input.items.length<=1000,400,'一次比对需要 1–1000 项');
  assert(input.items.filter(item=>item?.type==='data').length<=100,400,'一次最多比对 100 条数据记录');
  const identities=new Set(),items=[];
  for(const raw of input.items){
    assert(raw&&['data','file'].includes(raw.type),400,'清单项目类型无效');const hash=verifyFingerprint(raw.hash);let item;
    if(raw.type==='data'){
      const ns=namespace(raw.namespace),key=dataKey(raw.key);assert(scope.namespaces.includes(ns)&&!ns.startsWith('legacy.'),400,'数据分区不在本次推送范围内');
      item={type:'data',namespace:ns,key,hash,id:'record_'+await digest(JSON.stringify([ns,key])),identity:JSON.stringify(['data',ns,key])};
    }else{
      const path=relativePath(raw.path);assert(scope.files&&scope.roots.some(root=>!root||path===root||path.startsWith(root+'/')),400,'文件不在本次推送范围内');
      item={type:'file',path,hash,size:raw.size,identity:JSON.stringify(['file',path])};
      try{assertFileAllowed(policy,path);}catch(error){if(error instanceof Fault&&error.status===422)item.reason=error.detail.code;else throw error;}
      assert(Number.isSafeInteger(raw.size)&&raw.size>=0&&(item.reason||raw.size<=1572864),413,'文件大小无效或超过 1.5 MiB');
    }
    assert(!identities.has(item.identity),400,'比对清单不能重复包含同一项目');identities.add(item.identity);items.push(item);
  }
  const records=items.filter(item=>item.type==='data'),files=items.filter(item=>item.type==='file');
  if(records.length){
    const current=await all(env,`SELECT j.key position,e.* FROM json_each(?) j LEFT JOIN entities e ON e.owner=? AND e.deleted=0 AND e.id=json_extract(j.value,'$.id')`,JSON.stringify(records),device.user_id);
    for(const row of current){const item=records[Number(row.position)];if(row.id&&row.enabled&&(await valueDigest(JSON.parse(row.data).value)).slice(0,32)===item.hash){item.entity_id=row.id;item.version=row.version;}}
  }
  const session=input.session,encoded=JSON.stringify(records);
  let guard=publicationGuard+' AND EXISTS(SELECT 1 FROM sync_settings WHERE id=1 AND revision=?)',guardValues=[session,device.id,Date.now(),policy.revision];
  let primary=null;
  if(files.length){
    const catalog=await readCatalog(env,device.user_id),model=new Catalog(catalog.value),document=await filePublication(env,session),value=structuredClone(document.value);
    value.policy??=policy;
    const visible=new Map(visibleFiles(model,scope,policy).map(item=>[model.path(item),item]));
    for(const item of files){
      const current=visible.get(item.path);item.same=!!current&&current.tag===item.hash&&current.size===item.size;
      setEntry(value.items,item.path,{tag:item.hash,size:item.size,excluded:!!item.reason});
    }
    const condition=documentCondition([catalog,document]);
    primary=primaryDocument(env,document,value,condition.sql+' AND '+guard,[...condition.values,...guardValues]);
    guard=primary.guard;guardValues=primary.values;
  }
  const batch=primary?[...primary.statements]:[];
  if(records.length)batch.push(
    stmt(env,`INSERT INTO publish_checks(session,identity,type,namespace,key,hash,entity_id,version)
      SELECT ?,json_extract(j.value,'$.identity'),'data',json_extract(j.value,'$.namespace'),json_extract(j.value,'$.key'),json_extract(j.value,'$.hash'),json_extract(j.value,'$.entity_id'),json_extract(j.value,'$.version')
      FROM json_each(?) j WHERE ${guard}
      ON CONFLICT(session,identity) DO UPDATE SET hash=excluded.hash,entity_id=excluded.entity_id,version=excluded.version`,session,encoded,...guardValues),
    stmt(env,`INSERT OR IGNORE INTO publish_items(session,identity) SELECT c.session,c.identity FROM publish_checks c WHERE c.session=? AND c.identity IN(SELECT json_extract(value,'$.identity') FROM json_each(?)) AND ${matchingCheck} AND ${guard}`,session,encoded,device.user_id,...guardValues)
  );
  batch.push(stmt(env,'SELECT revision FROM sync_settings WHERE id=1'));
  const result=await env.DB.batch(batch);await publishing(env,device,session);
  if((primary&&!result[0].meta.changes)||result.at(-1).results[0].revision!==policy.revision){assert(attempt<4,503,'清单正在更新，请重试比对',{retryable:true});return checkPush(env,device,input,attempt+1);}
  const matched=records.length?await all(env,`SELECT c.identity FROM publish_checks c WHERE c.session=? AND c.identity IN(SELECT json_extract(value,'$.identity') FROM json_each(?)) AND ${matchingCheck}`,session,encoded,device.user_id):[];
  const unchanged=new Set(matched.map(row=>row.identity));
  return json({items:items.map(item=>({...checkIdentity(item),status:item.reason?'skipped':(item.type==='file'?item.same:unchanged.has(item.identity))?'unchanged':'upload',...(item.reason?{reason:item.reason}:{})}))});
}
