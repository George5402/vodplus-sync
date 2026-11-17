// 在数据库内固定恢复快照和差异，Worker 不读取整库文件或构造超大 JSON。
import {stmt} from '../lib/db.js';

// 参数顺序：scope JSON、policy JSON；目录排除匹配完整路径段，不匹配普通同名文件。
export function allowedFile(path){
  const filename=`substr(${path},length(rtrim(${path},replace(${path},'/','')))+1)`;
  return `EXISTS(SELECT 1 FROM json_each(?,'$.roots') r WHERE r.value='' OR ${path}=r.value OR substr(${path},1,length(r.value)+1)=r.value||'/')
    AND NOT EXISTS(SELECT 1 FROM json_each(?,'$.excludedDirectories') x WHERE instr('/'||lower(${path}), '/'||lower(x.value)||'/')>0)
    AND (EXISTS(SELECT 1 FROM json_each(?,'$.fileExtensions') x WHERE substr(lower(${filename}),-length(x.value)-1)='.'||lower(x.value) AND length(${filename})>length(x.value)+1)
      OR (json_extract(?,'$.includeExtensionless')=1 AND instr(substr(${filename},2),'.')=0))`;
}
export const policyValues=(scope,policy)=>[scope,policy,policy,policy];

export function snapshotStatements(env,device,session,scope,policy){
  const owner=device.user_id;
  const ns="CASE WHEN e.kind='record' THEN json_extract(e.data,'$.namespace') ELSE 'legacy.'||e.kind END";
  const key="CASE WHEN e.kind='record' THEN json_extract(e.data,'$.key') ELSE e.id END";
  // JSON 的标量和对象都保留类型，避免 SQLite 提取字符串时丢失引号。
  const value="CASE WHEN e.kind='record' THEN e.data->'$.value' ELSE e.data END";
  return [
    stmt(env,`INSERT INTO restore_snapshots(session,identity,type,namespace,key,value,version)
      SELECT ?,json_array('data',${ns},${key}),'data',${ns},${key},${value},e.version FROM entities e
      WHERE e.owner=? AND e.path IS NULL AND e.deleted=0 AND e.enabled=1 AND ${ns} IN (SELECT value FROM json_each(?,'$.namespaces'))
      AND EXISTS(SELECT 1 FROM restore_sessions WHERE token=?)`,session,owner,scope,session)
  ];
}

export function differenceStatement(env,device,session,scopeHash,scope,policy){
  return stmt(env,`INSERT INTO restore_items(session,position,marker,type,op,namespace,key,path,value,hash,size)
    WITH base AS (SELECT s.* FROM restore_snapshots s JOIN restore_baselines b ON b.session=s.session WHERE b.device=? AND b.scope_hash=?),
    difference AS (
      SELECT n.identity,n.type,n.namespace,n.key,n.path,n.value,n.hash,n.size, 'put' op FROM restore_snapshots n LEFT JOIN base b ON b.identity=n.identity
      WHERE n.session=? AND ((SELECT mode FROM restore_sessions WHERE token=?)='full' OR b.identity IS NULL OR n.version<>b.version OR n.value IS NOT b.value OR n.hash IS NOT b.hash)
      AND ((SELECT mode FROM restore_sessions WHERE token=?)='full' OR NOT EXISTS(
        SELECT 1 FROM device_contents h JOIN entities e ON e.owner=? AND e.id=h.entity_id AND e.version=h.version AND e.deleted=0 AND e.enabled=1
        WHERE h.device=? AND h.identity=n.identity AND h.version=n.version AND e.path IS n.path))
      UNION ALL
      SELECT b.identity,b.type,b.namespace,b.key,b.path,NULL,NULL,NULL, 'delete' op FROM restore_known b WHERE b.device=? AND b.scope_hash=? AND NOT EXISTS(SELECT 1 FROM restore_snapshots n WHERE n.session=? AND n.identity=b.identity)
      AND (b.type='data' OR (${allowedFile('b.path')}))
    ) SELECT ?,row_number() OVER(ORDER BY type,identity),lower(hex(randomblob(16))),type,op,namespace,key,path,value,hash,size FROM difference WHERE EXISTS(SELECT 1 FROM restore_sessions WHERE token=?)`,
    device.id,scopeHash,session,session,session,device.user_id,device.id,device.id,scopeHash,session,...policyValues(scope,policy),session,session);
}
