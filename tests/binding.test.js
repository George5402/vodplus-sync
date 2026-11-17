// 设备码唯一决定人物；测试中的码现场生成，不使用用户提供的私密材料。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, digest } from './harness.js';
import { bindingLinks } from '../web/lib/binding-links.js';
let h, owner;
before(async()=>{h=await createHarness();owner=await h.createUser('绑定人物');});
after(async()=>h?.dispose());
const newCode=async()=>(await h.request(`/api/admin/users/${owner}/binding`,{method:'POST',data:{}})).value.code;
const bind=code=>h.request('/api/bind',{method:'POST',admin:false,data:{code,deviceName:'测试手机'}});
test('只提交设备码即可绑定，并返回服务器当前用户名',async()=>{
  const code=await newCode();await h.request(`/api/admin/users/${owner}`,{method:'PATCH',data:{name:'重命名人物'}});
  const result=await bind(code);assert.equal(result.status,201);assert.equal(result.value.userId,owner);assert.equal(result.value.username,'重命名人物');assert.ok(result.value.deviceId&&result.value.token);
});
test('旧客户端携带其他用户名也不能改变设备码所属人物',async()=>{
  const result=await h.request('/api/bind',{method:'POST',data:{code:await newCode(),deviceName:'旧客户端',username:'不是此人物'}});
  assert.equal(result.status,201);assert.equal(result.value.userId,owner);assert.equal(result.value.username,'重命名人物');
});
test('失效、已消费、停用人物与无效设备名称都不产生越权绑定',async()=>{
  const expired=await newCode();await h.db.prepare('UPDATE bindings SET expires=0 WHERE hash=?').bind(digest(expired)).run();assert.equal((await bind(expired)).status,401);
  const used=await newCode();assert.equal((await bind(used)).status,201);assert.equal((await bind(used)).status,401);
  const invalid=await newCode();assert.equal((await h.request('/api/bind',{method:'POST',data:{code:invalid,deviceName:''}})).status,400);assert.equal((await bind(invalid)).status,201);
  const disabled=await newCode();await h.request(`/api/admin/users/${owner}`,{method:'PATCH',data:{enabled:false}});assert.equal((await bind(disabled)).status,401);await h.request(`/api/admin/users/${owner}`,{method:'PATCH',data:{enabled:true}});
});
test('并发消费同一无用户名绑定请求仍只能成功一次',async()=>{
  const code=await newCode();const responses=await Promise.all([bind(code),bind(code)]);assert.deepEqual(responses.map(r=>r.status).sort(),[201,401]);
});
test('expectedUserId 不匹配返回 409，既不消费码也不创建设备',async()=>{
  const code=await newCode();const before=(await h.db.prepare('SELECT COUNT(*) n FROM devices').first()).n;
  const mismatch=await h.request('/api/bind',{method:'POST',data:{code,deviceName:'已有安装',expectedUserId:crypto.randomUUID()}});
  assert.equal(mismatch.status,409);assert.equal(mismatch.value.detail.code,'USER_MISMATCH');assert.equal((await h.db.prepare('SELECT consumed FROM bindings WHERE hash=?').bind(digest(code)).first()).consumed,0);assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM devices').first()).n,before);
  const correct=await h.request('/api/bind',{method:'POST',data:{code,deviceName:'已有安装',expectedUserId:owner}});assert.equal(correct.status,201);assert.equal(correct.value.userId,owner);
});
test('唤起链接严格遵守共同契约，只带 server 和 code',()=>{
  const code='0'.repeat(64);const links=bindingLinks('https://sync.example.com:8443/',code);const url=new URL(links.direct);
  assert.equal(url.protocol,'vodplus:');assert.equal(url.hostname,'sync');assert.equal(url.pathname,'/bind');assert.deepEqual([...url.searchParams.keys()],['server','code']);assert.equal(url.searchParams.get('server'),'https://sync.example.com:8443');assert.equal(url.searchParams.get('code'),code);
  assert.equal(links.android,`intent://sync/bind?${url.searchParams.toString()}#Intent;scheme=vodplus;package=com.fongmi.vodplus;end`);
  for(const server of ['http://example.com','javascript:alert(1)','https://user:pass@example.com','https://example.com/path','https://example.com?code=bad'])assert.throws(()=>bindingLinks(server,code));
});
