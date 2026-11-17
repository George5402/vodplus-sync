// 管理端文件操作保留公开参数，内部使用目录文档中的稳定数字 ID。
import {assert,id,inside} from '../lib/http.js';
import {digest} from '../lib/crypto.js';
import {one,stmt} from '../lib/db.js';
import {mutateFiles} from './file-transaction.js';
import {syncSettings,assertFileAllowed} from '../sync/settings.js';
export async function commitFile(env,owner,principal,input,validate){
  id(input.opId);const patch=input.patch;id(patch.id);assert(Number.isSafeInteger(patch.baseVersion)&&patch.baseVersion>=0,400,'缺少有效基础版本');
  const fingerprint=await digest(JSON.stringify(input));
  return mutateFiles(env,{owner,principal,operation:input.opId,fingerprint,prepare:async model=>{
    const rows=model.rows(),current=rows.find(row=>row.id===patch.id);
    if((current?.version??0)!==patch.baseVersion){
      const conflictId=crypto.randomUUID();await stmt(env,'INSERT OR IGNORE INTO conflicts(id,owner,principal,op_id,proposed,created) VALUES(?,?,?,?,?,?)',conflictId,owner,principal,input.opId,JSON.stringify(input),Date.now()).run();
      const saved=await one(env,'SELECT id FROM conflicts WHERE principal=? AND op_id=?',principal,input.opId);assert(false,409,'版本已变化，候选内容已保留',{conflictId:saved.id,current});
    }
    const conflict=await one(env,'SELECT id FROM conflicts WHERE principal=? AND op_id=?',principal,input.opId);assert(!conflict,409,'此操作已产生冲突，请使用新的操作标记',{conflictId:conflict?.id});
    const policy=owner==='public'?null:await syncSettings(env);
    const checkPolicy=policy&&!patch.deleted&&(!current||(patch.kind==='file'&&current.data.hash!==patch.data?.hash));
    if(checkPolicy)assertFileAllowed(policy,patch.path,patch.kind);
    const proposed=await validate(env,owner,patch,current,rows);
    assert(!current?.deleted||proposed.deleted||input.restore===true,409,'恢复已删除项目需要确认');
    let patches=[{...proposed,version:patch.baseVersion+1}];
    if(current?.kind==='directory'&&!current.deleted){
      assert(!inside(proposed.path,current.path)||proposed.path===current.path,400,'不能把目录移入自身');
      if(proposed.path!==current.path||proposed.deleted)patches.push(...rows.filter(row=>row.id!==current.id&&!row.deleted&&inside(row.path,current.path)).map(row=>({...row,path:proposed.path+row.path.slice(current.path.length),deleted:proposed.deleted,version:row.version+1})));
      assert(patches.length<=80,413,'一次目录操作最多处理 80 项');
    }
    for(const row of patches.filter(row=>!row.deleted))assert(!rows.some(other=>!other.deleted&&other.path.toLowerCase()===row.path.toLowerCase()&&!patches.some(p=>p.id===other.id)),409,'目标路径已有文件');
    patches=patches.map(row=>({...row,source:principal,updated:Date.now()})).sort((a,b)=>a.path.split('/').length-b.path.split('/').length);
    for(const row of patches)model.set(row);
    return {snapshots:patches,result:{items:patches},...(checkPolicy?{condition:'EXISTS(SELECT 1 FROM sync_settings WHERE id=1 AND revision=?)',conditionValues:[policy.revision]}:{})};
  }});
}
