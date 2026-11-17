// 首次 API 访问自动补齐漏跑的迁移；完成后缓存，同库并发请求共用一次检查。
import initial from '../../migrations/0001_initial.sql';
import files from '../../migrations/0002_d1_files.sql';
import shares from '../../migrations/0003_permanent_shares.sql';
import lookup from '../../migrations/0004_sync_lookup.sql';
import settings from '../../migrations/0005_sync_settings.sql';
import devices from '../../migrations/0006_device_config.sql';
import excluded from '../../migrations/0007_excluded_directories.sql';
import reset from '../../migrations/0008_factory_reset.sql';
import generic from '../../migrations/0009_generic_sync.sql';
import checks from '../../migrations/0010_publish_checks.sql';
import indexes from '../../migrations/0011_query_indexes.sql';
import summaries from '../../migrations/0012_sync_summaries.sql';
import compactFiles from '../../migrations/0013_compact_file_storage.sql';
import {MIGRATION_NAMES,repairPlan} from './plan.js';

const migrations=[initial,files,shares,lookup,settings,devices,excluded,reset,generic,checks,indexes,summaries,compactFiles].map((sql,index)=>({name:MIGRATION_NAMES[index],sql}));
const readiness=new WeakMap();

async function inspect(db){
  const results=await db.batch([
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')"),
    db.prepare('PRAGMA table_info(sync_settings)')
  ]);
  const names=new Set(results[0].results.map(row=>row.name));
  const columns=new Set(results[1].results.map(row=>row.name));
  const applied=names.has('d1_migrations')?new Set((await db.prepare('SELECT name FROM d1_migrations').all()).results.map(row=>row.name)):new Set();
  const hasSettings=names.has('sync_settings')&&!!await db.prepare('SELECT id FROM sync_settings WHERE id=1').first();
  const storageVersion=names.has('storage_format')?(await db.prepare('SELECT version FROM storage_format WHERE id=1').first())?.version:0;
  return {names,columns,applied,hasSettings,storageVersion};
}

async function repair(db){
  for(let attempt=0;attempt<3;attempt++){
    const state=await inspect(db);const plan=repairPlan(migrations,state);
    if(!plan.length)return true;
    try{
      // DDL、默认行及迁移记录一起提交，失败时整体回滚，不留下半升级结构。
      // D1 batch 作为一次调用执行；清空、重建和迁移记录必须一起提交。
      await db.batch(plan.map(sql=>db.prepare(sql)));return true;
    }catch(error){
      // 不同 Worker 实例可能同时补列；另一实例已完成时重新检查即可。
      if(attempt===2||!/duplicate column name|already exists/i.test(String(error?.message)))throw error;
    }
  }
}

export function ensureSchema(env,{force=false}={}){
  const previous=readiness.get(env.DB);
  if(previous&&!force)return previous;
  const task=(async()=>{if(previous)await previous;return repair(env.DB);})();
  readiness.set(env.DB,task);
  task.then(complete=>{if(!complete&&readiness.get(env.DB)===task)readiness.delete(env.DB);},()=>{});
  task.catch(()=>{if(readiness.get(env.DB)===task)readiness.delete(env.DB);});
  return task;
}
