// 用真实 D1 事务定点插入竞争写入，避免仅靠偶然并发验证重试与冲突。
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,digest} from './harness.js';
import {commit} from '../src/sync/store.js';
import {getContent} from '../src/storage/content.js';
let h,owner,device;
before(async()=>{h=await createHarness();owner=await h.createUser('竞争测试');device=await h.bind(owner,'竞争测试');});
after(async()=>h?.dispose());
function intercept(db,inject){
  const queries=new WeakMap();
  return {DB:{
    prepare(sql){const prepared=db.prepare(sql);return {bind(...values){const bound=prepared.bind(...values);queries.set(bound,sql);return bound;}};},
    async batch(statements){if(queries.get(statements[0])?.startsWith('INSERT INTO json_documents'))await inject();return db.batch(statements);}
  }};
}
const make=async path=>{const {patch,result}=await h.put(owner,path);assert.equal(result.status,200);return patch;};
test('无关文件变化自动重试，不写入伪冲突',async()=>{
  const patch=await make('retry-different.py');let calls=0;
  const env=intercept(h.db,async()=>{if(calls++===0)await make('other-file.py');});
  const result=await commit(env,owner,'test:retry',{opId:crypto.randomUUID(),patch:{...patch,baseVersion:1,enabled:false}});
  assert.equal(result.items[0].version,2);assert.equal(calls,2);
  assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM conflicts WHERE principal=?').bind('test:retry').first()).n,0);
});
test('持续竞争返回可重试 503，相同 opId 后续仍能成功',async()=>{
  const patch=await make('busy.py');const input={opId:crypto.randomUUID(),patch:{...patch,baseVersion:1,enabled:false}};let calls=0;
  const env=intercept(h.db,async()=>{await make(`busy-other-${calls++}.py`);});
  await assert.rejects(()=>commit(env,owner,'test:busy',input),error=>error.status===503&&error.detail.retryable);
  assert.equal(calls,5);assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM conflicts WHERE principal=?').bind('test:busy').first()).n,0);
  assert.equal((await commit({DB:h.db},owner,'test:busy',input)).items[0].version,2);
});
test('同一文件真正变化仍保留候选，不被自动重试覆盖',async()=>{
  const patch=await make('same-file.py');let injected=false;
  const env=intercept(h.db,async()=>{if(!injected){injected=true;await commit({DB:h.db},owner,'test:other',{opId:crypto.randomUUID(),patch:{...patch,baseVersion:1,path:'renamed-same.py'}});}});
  await assert.rejects(()=>commit(env,owner,'test:same',{opId:crypto.randomUUID(),patch:{...patch,baseVersion:1,enabled:false}}),e=>e.status===409&&!!e.detail.conflictId);
  const row=(await h.files(owner)).find(row=>row.id===patch.id);assert.equal(row.path,'renamed-same.py');assert.equal(row.enabled,1);assert.equal(row.version,2);
});
test('父目录删除与新建子文件竞争不会产生孤儿文件',async()=>{
  const folder={id:crypto.randomUUID(),kind:'directory',path:'parent-race',baseVersion:0};await commit({DB:h.db},owner,'test:parent',{opId:crypto.randomUUID(),patch:folder});
  const raw='print(1)';const hash=digest(raw);await h.request(`/api/admin/spaces/${owner}/blobs/${hash}`,{method:'PUT',raw});let injected=false;
  const env=intercept(h.db,async()=>{if(!injected){injected=true;await commit({DB:h.db},owner,'test:parent',{opId:crypto.randomUUID(),patch:{...folder,baseVersion:1,deleted:true}});}});
  const child={id:crypto.randomUUID(),kind:'file',path:'parent-race/new.py',baseVersion:0,data:{hash,size:raw.length}};
  await assert.rejects(()=>commit(env,owner,'test:child',{opId:crypto.randomUUID(),patch:child}),e=>e.status===409);
  assert.equal((await h.files(owner)).find(row=>row.id===child.id),undefined);
});
test('校验后规则变更不会放行被禁止的新内容',async()=>{
  const patch=await make('policy-race.py');const hash=digest('new-body');await h.request(`/api/admin/spaces/${owner}/blobs/${hash}`,{method:'PUT',raw:'new-body'});let injected=false;
  const env=intercept(h.db,async()=>{if(!injected){injected=true;await h.db.prepare('UPDATE sync_settings SET file_extensions=?,revision=revision+1 WHERE id=1').bind('["txt"]').run();}});
  await assert.rejects(()=>commit(env,owner,'test:policy',{opId:crypto.randomUUID(),patch:{...patch,baseVersion:1,data:{hash,size:8}}}),e=>e.status===422);
  assert.equal((await h.file(owner,'policy-race.py')).version,1);
  await h.db.prepare('UPDATE sync_settings SET file_extensions=?,revision=revision+1 WHERE id=1').bind('["py","txt"]').run();
});
test('普通文件快照不传输用户记录正文，内容下载只做一次数据库查询',async()=>{
  const patch=await make('context.py');const key='record-context';
  await commit({DB:h.db},owner,'test:record',{opId:crypto.randomUUID(),patch:{id:`history_${digest(key)}`,kind:'history',baseVersion:0,data:{key,title:'x'.repeat(12000)}}});
  const listing=await h.request(`/api/admin/spaces/${owner}/entities?kind=files`);assert.ok(listing.value.items.every(row=>row.path));assert.ok(listing.value.items.some(row=>row.id===patch.id));assert.ok(!JSON.stringify(listing.value).includes('record-context'));
  let calls=0;const env={DB:{prepare(sql){calls++;return h.db.prepare(sql);}}};assert.ok(await getContent(env,owner,patch.data.hash));assert.equal(calls,1);
});
test('批量请求不反复写活跃时间，撤销仍即时生效',async()=>{
  const before=(await h.db.prepare('SELECT last_seen FROM devices WHERE id=?').bind(device.deviceId).first()).last_seen;
  await Promise.all([1,2,3,4].map(()=>h.request('/api/sync/settings',{token:device.token})));assert.equal((await h.db.prepare('SELECT last_seen FROM devices WHERE id=?').bind(device.deviceId).first()).last_seen,before);
  await h.request(`/api/admin/devices/${device.deviceId}`,{method:'PATCH',data:{revoked:true}});assert.equal((await h.request('/api/sync/settings',{token:device.token})).status,401);
});
