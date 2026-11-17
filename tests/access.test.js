// 验证无密钥初始化、5 位密码、公开资源与永久授权的完整访问路径。
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.js';
import {maintenance} from '../src/maintenance.js';
import {readFile} from 'node:fs/promises';
let h;
before(async()=>{h=await createHarness();await h.put('public','a.py','print("public")');await h.put('public','config.json',JSON.stringify({sites:[{api:'./a.py'}]}));});
after(async()=>h?.dispose());
const create=password=>h.request('/api/admin/shares',{method:'POST',data:{name:'配置',owner:'public',root:'',password}});
test('首次无 Secret 可创建 5 位密码管理员，4 位拒绝，已有账号不能覆盖',async()=>{
  const fresh=await createHarness({setup:false});
  try{
    assert.deepEqual((await fresh.request('/api/status')).value,{initialized:false});
    assert.equal((await fresh.request('/api/setup',{method:'POST',data:{username:'admin',password:'1234'}})).status,400);
    assert.equal((await fresh.request('/api/setup',{method:'POST',data:{username:'admin',password:'abcde'}})).status,200);
    assert.equal((await fresh.request('/api/login',{method:'POST',data:{username:'admin',password:'abcde'}})).status,200);
    assert.equal((await fresh.request('/api/setup',{method:'POST',data:{username:'other',password:'other'}})).status,409);
    assert.equal((await fresh.request('/api/status')).value.initialized,true);
  }finally{await fresh.dispose();}
});
test('并发首次初始化只允许一个管理员成功',async()=>{
  const fresh=await createHarness({setup:false});
  try{const results=await Promise.all(['first','second'].map(username=>fresh.request('/api/setup',{method:'POST',data:{username,password:'abcde'}})));assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await fresh.db.prepare('SELECT count(*) n FROM administrators').first()).n,1);}
  finally{await fresh.dispose();}
});
test('空密码和省略密码均可创建公开接口，1–4 位拒绝，5 位通过',async()=>{
  for(const password of ['',undefined,'abcde'])assert.equal((await create(password)).status,201);
  for(const password of ['a','abcd'])assert.equal((await create(password)).status,400);
});
test('公开接口、嵌套 JSON、脚本都不要求凭证，不公开同步 API',async()=>{
  const id=(await create('')).value.id;
  const info=(await h.request(`/share/${id}/info`,{admin:false})).value;assert.equal(info.passwordRequired,false);
  const index=(await h.request(`/share/${id}/index.json`,{admin:false})).value;
  for(const entry of index.urls){const url=new URL(entry.url);assert.equal(url.search,'');const value=await h.request(url.pathname,{admin:false});assert.equal(value.status,200);for(const site of value.value.sites){const script=new URL(site.api);assert.equal(script.search,'');assert.equal((await h.request(script.pathname,{admin:false})).status,200);}}
  assert.equal((await h.request('/api/sync/changes',{admin:false})).status,401);
  assert.equal((await h.request('/api/admin/overview',{admin:false})).status,401);
});
test('密码授权永久有效，清理任务与重命名不撤销链接',async()=>{
  const id=(await create('abcde')).value.id;
  assert.equal((await h.request(`/share/${id}/index.json`,{admin:false})).status,401);
  const result=(await h.request(`/share/${id}/auth`,{method:'POST',data:{password:'abcde'}})).value;assert.equal(result.expires,null);
  assert.equal((await h.db.prepare('SELECT expires FROM share_tokens WHERE share_id=?').bind(id).first()).expires,0);
  await maintenance({DB:h.db});await h.request(`/api/admin/shares/${id}`,{method:'PATCH',data:{name:'新名字'}});
  const url=new URL(result.url);assert.equal((await h.request(url.pathname+url.search,{admin:false})).status,200);
  await h.request(`/api/admin/shares/${id}`,{method:'PATCH',data:{password:'fghij'}});
  assert.equal((await h.request(url.pathname+url.search,{admin:false})).status,401);
});
test('公开和密码访问可切换，停用仍阻止读取',async()=>{
  const id=(await create('')).value.id;
  await h.request(`/api/admin/shares/${id}`,{method:'PATCH',data:{password:'abcde'}});assert.equal((await h.request(`/share/${id}/index.json`,{admin:false})).status,401);
  await h.request(`/api/admin/shares/${id}`,{method:'PATCH',data:{password:''}});assert.equal((await h.request(`/share/${id}/index.json`,{admin:false})).status,200);
  await h.request(`/api/admin/shares/${id}`,{method:'PATCH',data:{enabled:false}});assert.equal((await h.request(`/share/${id}/index.json`,{admin:false})).status,404);
});
test('升级迁移使保留下来的旧链接永久有效',async()=>{
  const id=(await create('abcde')).value.id;
  const result=(await h.request(`/api/admin/shares/${id}/token`,{method:'POST',data:{}})).value;
  await h.db.prepare('UPDATE share_tokens SET expires=1 WHERE share_id=?').bind(id).run();
  const url=new URL(result.url);assert.equal((await h.request(url.pathname+url.search,{admin:false})).status,401);
  const sql=(await readFile(new URL('../migrations/0003_permanent_shares.sql',import.meta.url),'utf8')).replace(/^--.*$/gm,'');
  await h.db.prepare(sql).run();await maintenance({DB:h.db});
  assert.equal((await h.request(url.pathname+url.search,{admin:false})).status,200);
});
