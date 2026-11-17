// 推送成功后按设备项目记录持有状态，跨恢复范围避免重复下载。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.js';
import {SyncClient} from '../examples/sync-v2-client.js';
const uuid=()=>crypto.randomUUID();
const dataScope={namespaces:['app.notes']};const fileScope={namespaces:[],files:true};
async function fixture(){
  const h=await createHarness(),owner=await h.createUser('已持有内容'),a=await h.bind(owner),b=await h.bind(owner);
  const sdk=new SyncClient({server:'http://localhost',token:a.token,fetch:(url,init)=>h.mf.dispatchFetch(url,init)});
  const post=(input,device=a)=>h.request('/api/v2/sync/restore',{method:'POST',token:device.token,data:input});
  const start=async(scope,extra={},device=a)=>(await post({action:'start',requestId:uuid(),scope,...extra},device));
  const items=async session=>{const out=[];let page=session.page;while(page){const r=await post({action:'page',session:session.session,page});assert.equal(r.status,200,JSON.stringify(r.value));out.push(...r.value.items);page=r.value.next;}return out;};
  const ack=s=>post({action:'ack',session:s.session});
  const push=()=>sdk.pushAll({scope:{namespaces:['app.notes'],files:true},records:[{namespace:'app.notes',key:'note',value:{text:'local'}}],files:[{path:'a.py',read:async()=>new TextEncoder().encode('local file')}]});
  return {...h,owner,a,b,sdk,post,start,items,ack,push};
}

test('混合推送后第一次分别恢复数据和文件，不重复下发已持有项目',async()=>{
  const h=await fixture();try{
    await h.push();
    const data=await h.start(dataScope);assert.equal(data.status,200,JSON.stringify(data.value));assert.equal(data.value.mode,'delta');assert.equal(data.value.total,0);await h.ack(data.value);
    const files=await h.start(fileScope);assert.equal(files.status,200,JSON.stringify(files.value));assert.equal(files.value.mode,'delta');assert.equal(files.value.total,0);await h.ack(files.value);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM device_contents WHERE device=?').bind(h.a.deviceId).first()).n,1);assert.equal(Object.keys((await h.fileState(h.a.deviceId)).held).length,1);
    const next=await h.start(fileScope);assert.equal(next.value.total,0);
  }finally{await h.dispose();}
});

test('其他设备在推送后的新增、变更和删除仍正常下发，full 始终完整',async()=>{
  const h=await fixture();try{
    await h.push();
    await h.request('/api/v2/sync/file?path=a.py',{method:'PUT',token:h.b.token,raw:'remote',headers:{'idempotency-key':uuid()}});
    await h.request('/api/v2/sync/file?path=b.py',{method:'PUT',token:h.b.token,raw:'new',headers:{'idempotency-key':uuid()}});
    const first=(await h.start(fileScope)).value;assert.deepEqual((await h.items(first)).map(x=>x.path),['a.py','b.py']);await h.ack(first);
    const full=(await h.start(fileScope,{full:true})).value;assert.equal(full.mode,'full');assert.equal(full.total,2);await h.items(full);await h.ack(full);
    await h.request('/api/v2/sync/file?path=a.py',{method:'DELETE',token:h.b.token,headers:{'idempotency-key':uuid()}});
    const deleted=(await h.start(fileScope)).value;assert.deepEqual((await h.items(deleted)).map(x=>[x.op,x.path]),[['delete','a.py']]);
    assert.equal((await h.start(dataScope,{},h.b)).value.total,1);
  }finally{await h.dispose();}
});

test('推送后尚未恢复的文件被其他设备删除，也能收到删除通知',async()=>{
  const h=await fixture();try{
    await h.push();await h.request('/api/v2/sync/file?path=a.py',{method:'DELETE',token:h.b.token,headers:{'idempotency-key':uuid()}});
    const s=(await h.start(fileScope)).value;assert.deepEqual((await h.items(s)).map(i=>[i.op,i.path]),[['delete','a.py']]);
  }finally{await h.dispose();}
});

test('未完成恢复不会错误保留持有状态，完整推送确认后可重新按需恢复',async()=>{
  const h=await fixture();try{
    await h.push();const interrupted=(await h.start(fileScope)).value;
    assert.equal(interrupted.total,0);
    const emptyRetry=(await h.start(fileScope)).value;assert.equal(emptyRetry.mode,'delta');assert.equal(emptyRetry.total,0);
    await h.start(fileScope,{full:true});
    const retry=(await h.start(fileScope)).value;assert.equal(retry.mode,'full');assert.equal(retry.total,1);
    await h.push();const afterPush=(await h.start(fileScope)).value;assert.equal(afterPush.mode,'delta');assert.equal(afterPush.total,0);
    const explicit=(await h.start(dataScope,{full:true})).value;assert.equal(explicit.mode,'full');assert.equal(explicit.total,1);
  }finally{await h.dispose();}
});

test('重置同时清空设备持有记录',async()=>{
  const h=await fixture();try{
    await h.push();assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM device_contents').first()).n,1);assert.equal(Object.keys((await h.fileState(h.a.deviceId)).held).length,1);
    const r=await h.request('/api/admin/account/reset',{method:'POST',data:{currentPassword:'test-password-1234',confirmation:'RESET'}});assert.equal(r.status,200);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM device_contents').first()).n,0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM json_documents').first()).n,0);
  }finally{await h.dispose();}
});
