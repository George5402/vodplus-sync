// 按设备保存待应用指令与实际回报；新旧回报不可互相覆盖。
import {assert,id} from '../lib/http.js';
import {one,run,stmt} from '../lib/db.js';
import {digest} from '../lib/crypto.js';

const fields=['vod','live','theme','wallpaper'];
function values(input,complete=false){
  assert(input&&typeof input==='object'&&!Array.isArray(input),400,'配置 values 必须是对象');
  assert(Object.keys(input).length>0&&Object.keys(input).every(key=>fields.includes(key)),400,'配置仅支持 vod/live/theme/wallpaper');
  if(complete)assert(fields.every(key=>Object.hasOwn(input,key)),400,'需要上报四项当前配置');
  return Object.fromEntries(fields.filter(key=>Object.hasOwn(input,key)).map(key=>{const value=input[key];
    assert(typeof value==='string'&&value.length<=4096&&!/[\x00-\x1f]/.test(value),400,'配置值需为不超过 4096 字符的文本');
    return [key,value.trim()];
  }));
}
export async function ensureDeviceConfig(env,deviceId){
  const device=await one(env,'SELECT id FROM devices WHERE id=?',deviceId);assert(device,404,'设备不存在');
  await run(env,'INSERT OR IGNORE INTO device_config(device_id) VALUES(?)',deviceId);
}
function view(row){return {
  revision:row.revision,desired:JSON.parse(row.desired),appliedRevision:row.applied_revision,
  current:row.reported===null?null:JSON.parse(row.reported),reportedAt:row.reported_at,reportSeq:row.report_seq,
  refreshRevision:row.refresh_revision,reportedRefreshRevision:row.reported_refresh_revision,
  requestedAt:row.requested_at,error:row.error
};}
export async function readDeviceConfig(env,deviceId){
  let row=await one(env,'SELECT * FROM device_config WHERE device_id=?',deviceId);
  if(!row){await ensureDeviceConfig(env,deviceId);row=await one(env,'SELECT * FROM device_config WHERE device_id=?',deviceId);}
  return view(row);
}
export async function saveDeviceConfig(env,deviceId,input){
  id(input.opId);assert(Number.isSafeInteger(input.baseRevision)&&input.baseRevision>=0,400,'缺少配置基础版本');
  const patch=values(input.values);await ensureDeviceConfig(env,deviceId);
  const principal=`device-config:${deviceId}`;const fingerprint=await digest(JSON.stringify(input));const nonce=crypto.randomUUID();const now=Date.now();
  await env.DB.batch([
    stmt(env,`INSERT OR IGNORE INTO receipts(principal,op_id,fingerprint,nonce,result,created)
      SELECT ?,?,?,?,json_object('revision',revision+1),? FROM device_config WHERE device_id=? AND revision=?`,principal,input.opId,fingerprint,nonce,now,deviceId,input.baseRevision),
    // 已确认过的旧指令不再合并，避免本机后续修改被无关的新指令覆盖。
    stmt(env,`UPDATE device_config SET desired=json_patch(CASE WHEN applied_revision<revision THEN desired ELSE '{}' END,?),
      revision=revision+1,requested_at=?,error='' WHERE device_id=? AND revision=?
      AND EXISTS(SELECT 1 FROM receipts WHERE principal=? AND op_id=? AND nonce=?)`,JSON.stringify(patch),now,deviceId,input.baseRevision,principal,input.opId,nonce)
  ]);
  const receipt=await one(env,'SELECT fingerprint,result FROM receipts WHERE principal=? AND op_id=?',principal,input.opId);
  assert(receipt,409,'设备配置已更新，请重新读取后再保存');assert(receipt.fingerprint===fingerprint,409,'同一 opId 不能提交不同配置');
  return JSON.parse(receipt.result);
}
export async function requestDeviceConfig(env,deviceId){
  await ensureDeviceConfig(env,deviceId);
  return env.DB.prepare('UPDATE device_config SET refresh_revision=refresh_revision+1 WHERE device_id=? RETURNING refresh_revision AS refreshRevision').bind(deviceId).first();
}
export async function reportDeviceConfig(env,deviceId,input){
  const actual=values(input.values,true);await ensureDeviceConfig(env,deviceId);
  for(const key of ['sequence','appliedRevision','refreshRevision'])assert(Number.isSafeInteger(input[key])&&input[key]>=(key==='sequence'?1:0),400,`无效的 ${key}`);
  assert(input.error===undefined||(typeof input.error==='string'&&input.error.length<=500),400,'错误信息最多 500 字符');
  const error=input.error||'';const fingerprint=await digest(JSON.stringify({values:actual,appliedRevision:input.appliedRevision,refreshRevision:input.refreshRevision,error}));
  const current=await one(env,'SELECT * FROM device_config WHERE device_id=?',deviceId);
  if(input.sequence===current.report_seq){assert(current.report_hash===fingerprint,409,'同一回报序号不能更改内容');return {ok:true};}
  assert(input.sequence>current.report_seq&&input.appliedRevision>=current.applied_revision&&input.appliedRevision<=current.revision&&input.refreshRevision>=current.reported_refresh_revision&&input.refreshRevision<=current.refresh_revision,409,'回报已过时或超出已下发版本，请读取新状态后重新采集');
  assert(!error||input.appliedRevision===current.applied_revision,400,'加载失败不能确认新配置已生效');
  if(!error&&input.appliedRevision>current.applied_revision&&input.appliedRevision===current.revision){
    assert(Object.entries(JSON.parse(current.desired)).every(([key,value])=>actual[key]===value),422,'实际配置与待确认指令不一致');
  }
  const result=await run(env,`UPDATE device_config SET reported=?,reported_at=?,report_seq=?,report_hash=?,applied_revision=?,reported_refresh_revision=?,error=?
    WHERE device_id=? AND report_seq=? AND revision=? AND applied_revision=?`,JSON.stringify(actual),Date.now(),input.sequence,fingerprint,input.appliedRevision,input.refreshRevision,error,deviceId,current.report_seq,current.revision,current.applied_revision);
  if(result.meta.changes!==1){const latest=await one(env,'SELECT report_seq,report_hash FROM device_config WHERE device_id=?',deviceId);assert(latest.report_seq===input.sequence&&latest.report_hash===fingerprint,409,'配置状态已变化，请重新读取并采集');}
  return {ok:true};
}
