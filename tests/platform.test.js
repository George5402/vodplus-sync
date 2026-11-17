// 覆盖隔离、并发、重试、回收站及分享子资源权限等跨模块行为。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, digest } from './harness.js';
let h,alice,bob,a,b;
before(async()=>{h=await createHarness();alice=await h.createUser('家人甲');bob=await h.createUser('家人乙');a=await h.bind(alice,'家人甲');b=await h.bind(bob,'家人乙');});
after(async()=>{await h?.dispose();});
const adminCommit=(owner,patch,extra={})=>h.request(`/api/admin/spaces/${owner}/commit`,{method:'POST',data:{opId:crypto.randomUUID(),patch,...extra}});
const dir=async(owner,path)=>(await adminCommit(owner,{id:crypto.randomUUID(),kind:'directory',path,baseVersion:0})).value.items[0];

test('匿名不能读取管理接口，初始化不可重复且拒绝跨站',async()=>{
  assert.equal((await h.request('/api/admin/overview',{admin:false})).status,401);
  assert.equal((await h.request('/api/setup',{method:'POST',data:{username:'a',password:'test-password-1234'}})).status,409);
  assert.equal((await h.request('/api/admin/users',{method:'POST',headers:{origin:'https://evil.test'},data:{name:'攻击'}})).status,403);
});
test('绑定码仅消费一次，用户名不是授权凭证',async()=>{
  const code=(await h.request(`/api/admin/users/${alice}/binding`,{method:'POST',data:{}})).value.code;
  const data={code,username:'家人甲',deviceName:'电视'};
  assert.equal((await h.request('/api/bind',{method:'POST',data})).status,201);
  assert.equal((await h.request('/api/bind',{method:'POST',data})).status,401);
  assert.equal((await h.request('/api/bind',{method:'POST',data:{...data,code:'x',username:'新用户'}})).status,401);
});
test('完整上传检查大小、摘要及路径，不接受绝对目录',async()=>{
  assert.equal((await h.request(`/api/sync/blobs/${digest('ok')}`,{method:'PUT',token:a.token,raw:'bad'})).status,422);
  assert.equal((await h.request(`/api/sync/blobs/${digest('large')}`,{method:'PUT',token:a.token,raw:new Uint8Array(1572865)})).status,413);
  for(const path of ['/storage/test.py','../test.py','a\\test.py','CON.py','a/%2e%2e/file']){
    assert.equal((await adminCommit(alice,{id:crypto.randomUUID(),kind:'directory',path,baseVersion:0})).status,400);
  }
});
test('用户文件与变更流严格隔离，设备不能指定另一个 owner',async()=>{
  const {patch,result}=await h.put(alice,'private.py');assert.equal(result.status,200);
  assert.equal((await h.request(`/api/sync/files/${patch.id}`,{token:b.token})).status,404);
  const feed=await h.request('/api/sync/changes?cursor=0&owner='+alice,{token:b.token});assert.deepEqual(feed.value.changes,[]);
  assert.equal((await h.request('/api/admin/overview',{token:a.token,admin:false})).status,401);
});
test('重试返回相同回执，不重复增加版本；复用 opId 改内容被拒绝',async()=>{
  const {patch}=await h.put(alice,'retry.py');const opId=crypto.randomUUID();const data={opId,patch:{...patch,baseVersion:1,enabled:false}};
  const first=await h.request('/api/sync/commit',{token:a.token,method:'POST',data});
  const retry=await h.request('/api/sync/commit',{token:a.token,method:'POST',data});
  assert.equal(first.status,200);assert.deepEqual(first.value,retry.value);
  const altered=await h.request('/api/sync/commit',{token:a.token,method:'POST',data:{...data,patch:{...data.patch,enabled:true}}});assert.equal(altered.status,409);
  const versions=(await h.request(`/api/admin/spaces/${alice}/versions/${patch.id}`)).value.items;assert.equal(versions.length,2);
});
test('并发修改只有一方成功，失败内容被保留为冲突',async()=>{
  const {patch}=await h.put(alice,'race.py');
  const results=await Promise.all([false,true].map(enabled=>h.request('/api/sync/commit',{token:a.token,method:'POST',data:{opId:crypto.randomUUID(),patch:{...patch,baseVersion:1,enabled}}})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.ok(results.find(r=>r.status===409).value.detail.conflictId);
});
test('目录移动保留子文件身份，删除记录阻止离线复活',async()=>{
  const folder=await dir(alice,'线路A');const {patch}=await h.put(alice,'线路A/spider.py');
  const moved=await adminCommit(alice,{...folder,path:'线路B',baseVersion:folder.version});assert.equal(moved.status,200);
  const file=moved.value.items.find(i=>i.id===patch.id);assert.equal(file.path,'线路B/spider.py');assert.equal(file.version,2);
  const deleted=await adminCommit(alice,{...file,deleted:true,baseVersion:2});assert.equal(deleted.status,200);
  assert.equal((await adminCommit(alice,{...file,baseVersion:2})).status,409);
  assert.equal((await adminCommit(alice,{...file,baseVersion:3},{restore:true})).status,200);
});
test('播放进度允许回看，但旧会话和旧序号不能覆盖',async()=>{
  const key=JSON.stringify(['source-key','video-key','episode-key']);const id=`progress_${digest(key)}`;
  const patch={id,kind:'progress',baseVersion:0,data:{key,sessionId:'session-a',sequence:1,position:300}};
  assert.equal((await adminCommit(alice,patch)).status,200);
  assert.equal((await adminCommit(alice,{...patch,baseVersion:1,data:{...patch.data,sequence:2,position:60}})).status,200);
  assert.equal((await adminCommit(alice,{...patch,baseVersion:2,data:{...patch.data,sessionId:'session-b',sequence:0,position:20}})).status,200);
  assert.equal((await adminCommit(alice,{...patch,baseVersion:2,data:{...patch.data,sequence:3,position:900}})).status,409);
});
test('密码分享的配置、子线路、脚本均受保护，停用目录立即生效',async()=>{
  const folder=await dir(alice,'分享');const {patch}=await h.put(alice,'分享/sample.py');
  const creation=await h.request('/api/admin/shares',{method:'POST',data:{name:'只读配置',owner:alice,root:'分享',password:'sharing-password-123'}});assert.equal(creation.status,201);const share=creation.value.id;
  assert.equal((await h.request(`/share/${share}/index.json`,{admin:false})).status,401);
  assert.equal((await h.request(`/share/${share}/auth`,{method:'POST',data:{password:'wrong'}})).status,401);
  const auth=await h.request(`/share/${share}/auth`,{method:'POST',data:{password:'sharing-password-123'}});assert.equal(auth.status,200);
  const url=new URL(auth.value.url);const config=await h.request(url.pathname+url.search);assert.equal(config.status,200);assert.equal(config.value.sites.length,1);
  const script=new URL(config.value.sites[0].api);assert.equal((await h.request(script.pathname+script.search)).status,200);assert.equal((await h.request(script.pathname)).status,401);
  assert.equal((await h.request('/api/sync/changes',{admin:false,token:auth.value.token})).status,401);
  assert.equal((await h.request(`/share/${share}/files/fake-id/file.py${url.search}`)).status,404);
  await adminCommit(alice,{...folder,baseVersion:1,enabled:false});assert.equal((await h.request(script.pathname+script.search)).status,404);
  await adminCommit(alice,{...folder,baseVersion:2,enabled:true});
  await h.request(`/api/admin/shares/${share}`,{method:'PATCH',data:{password:'new-password-12345'}});assert.equal((await h.request(url.pathname+url.search)).status,401);
});
test('配置中本地相对引用继承凭证，不能越过发布目录',async()=>{
  await dir(bob,'发布');const {patch:script}=await h.put(bob,'发布/a.py');const {patch:config}=await h.put(bob,'发布/config.json',JSON.stringify({sites:[{api:'./a.py'}]}));
  const id=(await h.request('/api/admin/shares',{method:'POST',data:{name:'嵌套',owner:bob,root:'发布',password:'sharing-password-123'}})).value.id;
  const auth=(await h.request(`/api/admin/shares/${id}/token`,{method:'POST',data:{}})).value;
  const result=await h.request(`/share/${id}/files/${config.id}/config.json?token=${auth.token}`);assert.match(result.value.sites[0].api,/token=/);assert.match(result.value.sites[0].api,new RegExp(script.id));
});
test('撤销设备与停用人物即时阻止访问',async()=>{
  await h.request(`/api/admin/devices/${a.deviceId}`,{method:'PATCH',data:{revoked:true}});assert.equal((await h.request('/api/sync/changes',{token:a.token})).status,401);
  await h.request(`/api/admin/users/${bob}`,{method:'PATCH',data:{enabled:false}});assert.equal((await h.request('/api/sync/changes',{token:b.token})).status,401);
});
