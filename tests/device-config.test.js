// 设备实际回报与下发指令分开，覆盖隔离、重试、过时回报和刷新请求。
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.js';
let h,a,b;const actual={vod:'https://example.com/vod.json',live:'',theme:'',wallpaper:''};
before(async()=>{h=await createHarness();const owner=await h.createUser('设备配置用户');a=await h.bind(owner);b=await h.bind(owner);});
after(async()=>h?.dispose());
const state=async()=> (await h.request(`/api/admin/devices/${a.deviceId}/config`)).value;
const poll=token=>h.request('/api/sync/device-config',{token});
const report=data=>h.request('/api/sync/device-config/report',{method:'POST',token:a.token,data});
const save=data=>h.request(`/api/admin/devices/${a.deviceId}/config`,{method:'PUT',data});
test('初始状态是未知，不伪装空值为设备实时值',async()=>{
  assert.equal((await state()).current,null);assert.equal((await poll(a.token)).value.reportSeq,0);
  assert.equal((await h.request('/api/sync/device-config',{admin:false})).status,401);
  assert.equal((await h.request(`/api/admin/devices/${a.deviceId}/config`,{admin:false,token:b.token})).status,401);
});
test('实时请求等待对应刷新回报，重复上报不会伪造更新时间',async()=>{
  const refresh=(await h.request(`/api/admin/devices/${a.deviceId}/config/refresh`,{method:'POST',data:{}})).value.refreshRevision;
  assert.equal((await poll(a.token)).value.refreshRevision,refresh);
  const input={sequence:1,appliedRevision:0,refreshRevision:refresh,values:actual};assert.equal((await report(input)).status,200);
  const before=await state();assert.deepEqual(before.current,actual);assert.equal(before.reportedRefreshRevision,refresh);
  assert.equal((await report(input)).status,200);assert.equal((await state()).reportedAt,before.reportedAt);
});
test('配置只下发选中设备，同 opId 重试只生成一个版本',async()=>{
  const input={baseRevision:0,opId:crypto.randomUUID(),values:{vod:'https://example.com/new.json',theme:'dark'}};
  assert.equal((await save(input)).value.revision,1);assert.equal((await save(input)).value.revision,1);
  assert.equal((await save({...input,values:{theme:'light'}})).status,409);
  assert.deepEqual((await poll(b.token)).value.values,{});assert.equal((await poll(a.token)).value.values.theme,'dark');
  assert.equal((await state()).appliedRevision,0);
});
test('应用失败保留待办，只有实际值匹配后才能确认当前版本',async()=>{
  assert.equal((await report({sequence:2,appliedRevision:0,refreshRevision:1,values:actual,error:'配置加载失败'})).status,200);
  assert.equal((await state()).error,'配置加载失败');assert.equal((await state()).appliedRevision,0);
  assert.equal((await report({sequence:3,appliedRevision:1,refreshRevision:1,values:actual})).status,422);
  const loaded={...actual,vod:'https://example.com/new.json',theme:'dark'};
  assert.equal((await report({sequence:3,appliedRevision:1,refreshRevision:1,values:loaded})).status,200);
  assert.deepEqual((await poll(a.token)).value.values,{});
});
test('已确认旧指令不覆盖本机后续修改，新指令只含编辑字段',async()=>{
  assert.equal((await report({sequence:4,appliedRevision:1,refreshRevision:1,values:{...actual,vod:'https://example.com/local.json',theme:'dark'}})).status,200);
  const result=await save({baseRevision:1,opId:crypto.randomUUID(),values:{wallpaper:'https://example.com/bg.jpg'}});assert.equal(result.status,200);
  assert.deepEqual((await poll(a.token)).value.values,{wallpaper:'https://example.com/bg.jpg'});
  assert.equal((await report({sequence:2,appliedRevision:0,refreshRevision:1,values:actual})).status,409);
});
test('未确认指令合并，新旧回报不丢新指令，清空值保留',async()=>{
  assert.equal((await save({baseRevision:2,opId:crypto.randomUUID(),values:{live:''}})).status,200);
  assert.deepEqual((await poll(a.token)).value.values,{wallpaper:'https://example.com/bg.jpg',live:''});
  assert.equal((await report({sequence:5,appliedRevision:2,refreshRevision:1,values:{...actual,wallpaper:'https://example.com/bg.jpg'}})).status,200);
  assert.equal((await state()).revision,3);assert.equal((await state()).appliedRevision,2);
  assert.equal((await save({baseRevision:1,opId:crypto.randomUUID(),values:{theme:'old'}})).status,409);
});
test('并发相同回报仍幂等，刷新版本和确认版本不能倒退或越界',async()=>{
  const values={...actual,wallpaper:'https://example.com/bg.jpg'};const input={sequence:6,appliedRevision:3,refreshRevision:1,values};
  const responses=await Promise.all([report(input),report({...input,values:{wallpaper:values.wallpaper,theme:values.theme,live:values.live,vod:values.vod}})]);assert.deepEqual(responses.map(r=>r.status),[200,200]);
  assert.equal((await report({...input,sequence:7,refreshRevision:0})).status,409);
  assert.equal((await report({...input,sequence:7,appliedRevision:99})).status,409);assert.equal((await state()).reportSeq,6);
});
test('撤销设备后不能再读取或上报，管理员仍可查看最后回报',async()=>{
  await h.request(`/api/admin/devices/${a.deviceId}`,{method:'PATCH',data:{revoked:true}});assert.equal((await poll(a.token)).status,401);
  assert.equal((await report({sequence:6,appliedRevision:3,refreshRevision:1,values:actual})).status,401);assert.ok((await state()).current);
});
