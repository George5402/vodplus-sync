// 验证长离线、分页上界、公共复制及客户端丢响应后的恢复行为。
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,digest} from './harness.js';
import {SyncClient} from '../examples/sync-client.js';
let h,owner,device;
before(async()=>{h=await createHarness();owner=await h.createUser('边界测试');device=await h.bind(owner,'边界测试');});
after(async()=>h?.dispose());
const commit=patch=>h.request(`/api/admin/spaces/${owner}/commit`,{method:'POST',data:{opId:crypto.randomUUID(),patch}});
test('已初始化管理员不能被覆盖，空 JSON 请求返回明确错误',async()=>{
  assert.equal((await h.request('/api/setup',{method:'POST',data:{username:'new-admin',password:'test-password-1234'}})).status,409);
  assert.equal((await h.request('/api/admin/users',{method:'POST',raw:'null',headers:{'content-type':'application/json'}})).status,400);
});
test('同一绑定码并发领取只有一台设备成功',async()=>{
  const code=(await h.request(`/api/admin/users/${owner}/binding`,{method:'POST',data:{}})).value.code;
  const result=await Promise.all([1,2].map(n=>h.request('/api/bind',{method:'POST',data:{code,username:'边界测试',deviceName:'并发设备'+n}})));
  assert.deepEqual(result.map(r=>r.status).sort(),[201,401]);
});
test('界面历史保留 20 版，但长离线设备仍可下载旧增量内容',async()=>{
  const {patch}=await h.put(owner,'versions.py');
  for(let version=1;version<=22;version++)assert.equal((await commit({...patch,baseVersion:version,enabled:version%2===0})).status,200);
  assert.equal((await h.request(`/api/admin/spaces/${owner}/versions/${patch.id}`)).value.items.length,20);
  const old=await h.request(`/api/sync/files/${patch.id}?version=1`,{token:device.token});assert.equal(old.status,200);assert.equal(old.value,'print("hello")');
});
test('分页有固定上界，后续新增不会混进本轮',async()=>{
  for(let n=0;n<102;n++)assert.equal((await commit({id:crypto.randomUUID(),kind:'directory',path:`page-${n}`,baseVersion:0})).status,200);
  const first=(await h.request('/api/sync/changes?cursor=0',{token:device.token})).value;assert.equal(first.changes.length,100);assert.equal(first.hasMore,true);
  await commit({id:crypto.randomUUID(),kind:'directory',path:'after-page',baseVersion:0});
  const second=(await h.request(`/api/sync/changes?cursor=${first.cursor}&until=${first.until}`,{token:device.token})).value;
  assert.equal(second.hasMore,false);assert.equal(second.cursor,first.until);assert.ok(second.changes.every(c=>c.path!=='after-page'));
  const next=(await h.request(`/api/sync/changes?cursor=${second.cursor}`,{token:device.token})).value;assert.equal(next.changes.at(-1).path,'after-page');
});
test('发布目录按稳定 ID 跟随重命名，外部同名目录不能接管',async()=>{
  const folder=(await commit({id:crypto.randomUUID(),kind:'directory',path:'old-root',baseVersion:0})).value.items[0];await h.put(owner,'old-root/a.py');
  const share=(await h.request('/api/admin/shares',{method:'POST',data:{owner,root:'old-root',name:'稳定发布',password:'password-stable-123'}})).value.id;
  const access=(await h.request(`/api/admin/shares/${share}/token`,{method:'POST',data:{}})).value;
  await commit({...folder,path:'new-root',baseVersion:1});
  const url=new URL(access.url);assert.equal((await h.request(url.pathname+url.search)).value.sites.length,1);
  await commit({...folder,path:'new-root',baseVersion:2,deleted:true});
  await commit({id:crypto.randomUUID(),kind:'directory',path:'old-root',baseVersion:0});
  assert.equal((await h.request(url.pathname+url.search)).status,404);
});
test('公共库复制产生独立文件，重试不会重复创建',async()=>{
  const {patch}=await h.put('public','public.py','print("public")');const data={owner,fileId:patch.id,sourceVersion:1,id:crypto.randomUUID(),opId:crypto.randomUUID(),path:'copied.py'};
  const first=await h.request('/api/admin/copy',{method:'POST',data});assert.equal(first.status,200);
  await h.request('/api/admin/spaces/public/commit',{method:'POST',data:{opId:crypto.randomUUID(),patch:{...patch,baseVersion:1,deleted:true}}});
  assert.deepEqual((await h.request('/api/admin/copy',{method:'POST',data})).value,first.value);
  const content=await h.request(`/api/sync/files/${data.id}`,{token:device.token});assert.equal(content.value,'print("public")');
});
test('参考客户端断网保留队列，丢失提交响应后幂等恢复',async()=>{
  const queue=[];let cursor=0;let applied=[];let lose=true;
  const storage={enqueue:async x=>queue.push(x),pending:async()=>queue.slice(),committed:async(_owner,op)=>{queue.splice(queue.findIndex(q=>q.opId===op),1);},cursor:async()=>cursor,conflict:async()=>{},log:async()=>{},applyRemote:async(_owner,items,next,options)=>{assert.equal(options.suppressWatcher,true);applied=items;cursor=next;}};
  const client=new SyncClient({server:'http://localhost',userId:owner,deviceId:device.deviceId,token:device.token,storage,fetcher:async(url,options)=>{const response=await h.mf.dispatchFetch(url,options);if(url.endsWith('/commit')&&lose){lose=false;throw new Error('模拟响应丢失');}return response;}});
  const id=crypto.randomUUID();await client.enqueue({id,kind:'file',path:'client.py',baseVersion:0},new TextEncoder().encode('print("client")'));
  await assert.rejects(()=>client.sync(),/模拟响应丢失/);assert.equal(queue.length,1);
  await client.sync();assert.equal(queue.length,0);assert.ok(applied.some(x=>x.change.id===id));
  assert.equal((await h.request(`/api/admin/spaces/${owner}/versions/${id}`)).value.items.length,1);
});
test('多线路、JSON 子资源都鉴权，名称不被误写成 URL',async()=>{
  const {patch:script}=await h.put(owner,'root.py');
  const {patch:config}=await h.put(owner,'line.json',JSON.stringify({sites:[{name:'root.py',api:'./root.py'}]}));
  const share=(await h.request('/api/admin/shares',{method:'POST',data:{owner,root:'',name:'多线路',password:'test-multiline-123'}})).value.id;
  const access=(await h.request(`/api/admin/shares/${share}/token`,{method:'POST',data:{}})).value;
  const url=new URL(access.url);const index=(await h.request(url.pathname+url.search)).value;
  assert.ok(index.urls.length>=2);
  for(const entry of index.urls){const link=new URL(entry.url);assert.equal((await h.request(link.pathname)).status,401);assert.equal((await h.request(link.pathname+link.search)).status,200);}
  const configValue=(await h.request(`/share/${share}/files/${config.id}/line.json?token=${access.token}`)).value;
  assert.equal(configValue.sites[0].name,'root.py');assert.ok(configValue.sites[0].api.includes(script.id));
});
test('参考客户端拒绝跨人物待办，下载摘要错误不推进游标',async()=>{
  const wrong=new SyncClient({server:'http://localhost',userId:owner,token:device.token,storage:{pending:async()=>[{owner:'other-user'}]},fetcher:(url,options)=>h.mf.dispatchFetch(url,options)});
  await assert.rejects(()=>wrong.sync(),/队列人物不匹配/);
  let applied=false;
  const client=new SyncClient({server:'http://localhost',userId:owner,token:device.token,storage:{pending:async()=>[],cursor:async()=>0,applyRemote:async()=>{applied=true;}},fetcher:(url,options)=>url.includes('/files/')?new Response('tampered'):h.mf.dispatchFetch(url,options)});
  await assert.rejects(()=>client.sync(),/下载校验失败/);assert.equal(applied,false);
});
