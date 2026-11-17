// 目录文档、发布状态和历史在同一事务内提交；CAS 失败只重读重试，不覆盖并发修改。
import {assert} from '../lib/http.js';
import {one,stmt} from '../lib/db.js';
import {readCatalog,Catalog} from './catalog.js';
import {documentCondition,primaryDocument,writeDocument} from './documents.js';
export async function savedReceipt(env,principal,operation,fingerprint){
  const row=await one(env,'SELECT fingerprint,result FROM receipts WHERE principal=? AND op_id=?',principal,operation);
  if(row)assert(row.fingerprint===fingerprint,409,'同一操作标记不能提交不同内容');return row?JSON.parse(row.result):null;
}
export async function mutateFiles(env,{owner,principal,operation,fingerprint,prepare}){
  const previous=await savedReceipt(env,principal,operation,fingerprint);if(previous)return previous;
  for(let attempt=0;attempt<5;attempt++){
    const document=await readCatalog(env,owner),model=new Catalog(structuredClone(document.value));
    const change=await prepare(model,document);const snapshots=change.snapshots??[];
    assert(model.items().length<=5000,413,'文件空间已达 5000 项');
    const dependencies=[document,...(change.documents??[]).map(item=>item.document)];const check=documentCondition(dependencies);
    const condition=`${check.sql} AND NOT EXISTS(SELECT 1 FROM receipts WHERE principal=? AND op_id=?)${change.condition?' AND '+change.condition:''}`;
    const conditions=[...check.values,principal,operation,...(change.conditionValues??[])];
    const primary=primaryDocument(env,document,model.value,condition,conditions,{count:model.items().length});
    const {guard,values}=primary;const now=Date.now();
    const batch=[...primary.statements,
      stmt(env,`INSERT INTO receipts(principal,op_id,fingerprint,nonce,result,created) SELECT ?,?,?,?,?,? WHERE ${guard}`,principal,operation,fingerprint,values[2],JSON.stringify(change.result),now,...values),
      ...(change.statements?.(guard,values)??[])];
    for(const doc of change.documents??[])batch.push(...writeDocument(env,doc.document,doc.value,guard,values));
    for(const row of snapshots){
      const snapshot=JSON.stringify(row);
      batch.push(stmt(env,`INSERT INTO versions(owner,entity_id,version,snapshot,created) SELECT ?,?,?,?,? WHERE ${guard}`,owner,row.id,row.version,snapshot,now,...values));
      batch.push(stmt(env,`INSERT INTO changes(owner,entity_id,version,snapshot,source,created) SELECT ?,?,?,?,?,? WHERE ${guard}`,owner,row.id,row.version,snapshot,principal,now,...values));
      batch.push(stmt(env,`DELETE FROM versions WHERE owner=? AND entity_id=? AND version<? AND ${guard}`,owner,row.id,row.version-19,...values));
    }
    if(snapshots.length)batch.push(stmt(env,`INSERT INTO sync_heads(owner,state) SELECT ?,json_object('files',1,'data',json('{}')) WHERE ${guard}
      ON CONFLICT(owner) DO UPDATE SET state=json_set(state,'$.files',COALESCE(json_extract(state,'$.files'),0)+1)`,owner,...values));
    const result=await env.DB.batch(batch);
    const saved=await savedReceipt(env,principal,operation,fingerprint);if(saved)return saved;
    assert(!result[0].meta.changes,500,'目录提交缺少回执');
  }
  assert(false,503,'文件清单正在更新，请稍后重试',{retryable:true});
}
