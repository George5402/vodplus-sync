// 仅检查公开的表结构版本，不返回用户、凭证或请求参数。
import {json} from './lib/http.js';
const required=[
 ['administrators','0001_initial.sql'],['devices','0001_initial.sql'],['entities','0001_initial.sql'],
 ['file_contents','0013_compact_file_storage.sql'],['json_documents','0013_compact_file_storage.sql'],['storage_format','0013_compact_file_storage.sql'],['reject_row_file_insert','0013_compact_file_storage.sql'],['reject_row_file_update','0013_compact_file_storage.sql'],
 ['sync_settings','0005_sync_settings.sql'],['device_config','0006_device_config.sql'],
 ['maintenance_actions','0008_factory_reset.sql'],
 ['restore_sessions','0009_generic_sync.sql'],['restore_snapshots','0009_generic_sync.sql'],
 ['restore_items','0009_generic_sync.sql'],['restore_baselines','0009_generic_sync.sql'],['restore_known','0009_generic_sync.sql'],
 ['publish_sessions','0009_generic_sync.sql'],['publish_items','0009_generic_sync.sql'],['publish_checks','0010_publish_checks.sql'],['device_contents','0010_publish_checks.sql'],
 ['entity_record_lookup','0011_query_indexes.sql'],
 ['sync_heads','0012_sync_summaries.sql'],['device_sync_summaries','0012_sync_summaries.sql'],['sync_head_insert','0012_sync_summaries.sql'],['sync_head_update','0012_sync_summaries.sql'],['reset_sync_summaries','0012_sync_summaries.sql']
];
export async function health(env){
  try{
    const results=await env.DB.batch([env.DB.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')"),env.DB.prepare('PRAGMA table_info(sync_settings)')]);
    const names=new Set(results[0].results.map(row=>row.name));const missing=new Set(required.filter(([name])=>!names.has(name)).map(([,migration])=>migration));
    if(!results[1].results.some(row=>row.name==='excluded_directories'))missing.add('0007_excluded_directories.sql');
    if(!names.has('factory_reset'))missing.add('0008_factory_reset.sql');
    if(!names.has('reset_generic_sync'))missing.add('0009_generic_sync.sql');
    if(!names.has('reset_publish_checks'))missing.add('0010_publish_checks.sql');
    return json({ok:missing.size===0,requiredSchema:13,syncApi:2,capabilities:['push-check','device-held-content','compact-sync-state','json-file-catalog','blob-files','fingerprint-128'],automaticMigration:true,code:missing.size?'SCHEMA_NOT_READY':'OK',missingMigrations:[...missing]},missing.size?503:200);
  }catch(error){const detail=failureDetail(error);return json({ok:false,requiredSchema:13,...(detail.code==='DATABASE_LIMIT'?detail:{code:'DATABASE_UNAVAILABLE'})},503);}
}
export function failureCode(error){
  const message=errorText(error);
  if(/no such (table|column)|has no column named/i.test(message))return 'SCHEMA_NOT_READY';
  if(/D1.*(limit|quota)|exceeded.*(read|write|storage)|database.*(full|size limit)|too many (?:D1 |API )?(?:queries|requests)/i.test(message))return 'DATABASE_LIMIT';
  return 'INTERNAL_ERROR';
}
function errorText(error){return [error?.message||error,error?.cause?.message].filter(Boolean).join(' ');}
export function failureDetail(error){
  const code=failureCode(error);if(code!=='DATABASE_LIMIT')return {code};
  const message=errorText(error);
  const limitType=/storage|database.*(?:full|size)|disk.*full/i.test(message)?'storage':/\bread|reading|rows_read/i.test(message)?'read':/written|write|writing/i.test(message)?'write':/queries|requests|subrequest/i.test(message)?'queries':'unknown';
  return {code,limitType};
}
export function failureMessage(detail){
  if(detail.code==='SCHEMA_NOT_READY')return '服务数据准备失败，请稍后重试';
  if(detail.code!=='DATABASE_LIMIT')return '服务暂时不可用';
  return {read:'数据库今日读取额度已用完，免费额度在北京时间 08:00 重置',write:'数据库今日写入额度已用完，免费额度在北京时间 08:00 重置',storage:'数据库存储容量已达上限',queries:'单次请求的数据库查询次数已达上限',unknown:'数据库额度或容量已达限制'}[detail.limitType];
}
