// 紧凑 JSON 状态只加速确实无变化的请求，不能跳过并发变化、规则变更或完整恢复。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createHarness} from './harness.js';
import {restore} from '../src/generic/restore.js';
import {measuredDatabase} from './query-metrics.js';

async function fixture(){
  const h=await createHarness(),owner=await h.createUser('紧凑状态'),binding=await h.bind(owner),device={id:binding.deviceId,user_id:owner};
  const post=data=>h.request('/api/v2/sync/restore',{method:'POST',token:binding.token,data});
  const start=(scope,extra={})=>post({action:'start',requestId:crypto.randomUUID(),scope,...extra});
  const complete=async result=>{let page=result.page;while(page){const r=await post({action:'page',session:result.session,page});page=r.value.next;}return post({action:'ack',session:result.session});};
  const data=(ns,value)=>h.request('/api/v2/sync/push',{method:'POST',token:binding.token,data:{requestId:crypto.randomUUID(),namespace:ns,upsert:[{key:'one',value}]}});
  const file=text=>h.request('/api/v2/sync/file?path=a.py',{method:'PUT',token:binding.token,raw:text,headers:{'idempotency-key':crypto.randomUUID()}});
  return {...h,device,binding,owner,post,start,complete,data,file};
}
const files={namespaces:[],files:true};const notes={namespaces:['app.notes']};

test('分区变化互不干扰，数据变化不触发文件快照复制',async()=>{
  const h=await fixture();try{
    await h.file('a');await h.data('app.notes',{value:1});
    await h.complete((await h.start(files)).value);await h.complete((await h.start(notes)).value);
    await h.data('app.notes',{value:2});
    const sameFiles=(await h.start(files)).value;assert.equal(sameFiles.total,0);
    assert.equal(JSON.parse((await h.db.prepare('SELECT scope FROM restore_sessions WHERE token=?').bind(sameFiles.session).first()).scope)._fast,true);
    const changed=(await h.start(notes)).value;assert.equal(changed.total,1);
    const page=await h.post({action:'page',session:changed.session,page:changed.page});assert.deepEqual(page.value.items[0].value,{value:2});
  }finally{await h.dispose();}
});

test('检查摘要后发生并发变化时，原子校验转入正常恢复',async()=>{
  const h=await fixture();try{
    await h.file('before');await h.complete((await h.start(files)).value);
    let changed=false;
    const wrapNative=(raw,sql)=>({raw,bind(...values){return wrapNative(raw.bind(...values),sql);},all:()=>raw.all(),run:()=>raw.run(),async first(){if(!changed&&sql.includes("'$._fast'")){changed=true;await h.file('after');}return raw.first();}});
    const env={DB:{prepare:sql=>wrapNative(h.db.prepare(sql),sql),batch:statements=>h.db.batch(statements.map(statement=>statement.raw))}};
    const result=await (await restore(env,h.device,{action:'start',requestId:crypto.randomUUID(),scope:files})).json();
    assert.ok(changed);assert.equal(result.total,1);
  }finally{await h.dispose();}
});

test('空会话可以重试和重复确认，full 与文件规则变化不会走空路径',async()=>{
  const h=await fixture();try{
    await h.file('a');await h.complete((await h.start(files)).value);
    const input={action:'start',requestId:crypto.randomUUID(),scope:files};
    const first=(await h.post(input)).value,again=(await h.post(input)).value;assert.equal(first.session,again.session);
    assert.equal((await h.complete(first)).status,200);assert.equal((await h.complete(first)).status,200);
    const full=(await h.start(files,{full:true})).value;assert.equal(full.mode,'full');assert.equal(full.total,1);await h.complete(full);
    const settings=(await h.request('/api/admin/sync-settings')).value;
    await h.request('/api/admin/sync-settings',{method:'PUT',data:{...settings,fileExtensions:['json']}});
    const filtered=(await h.start(files)).value;
    assert.equal(JSON.parse((await h.db.prepare('SELECT scope FROM restore_sessions WHERE token=?').bind(filtered.session).first()).scope)._fast,undefined);
    assert.equal(filtered.total,0);
  }finally{await h.dispose();}
});

test('实体修改和空间 JSON 修订同事务更新，重置清空摘要',async()=>{
  const h=await fixture();try{
    await h.file('a');await h.data('app.notes',1);await h.complete((await h.start(files)).value);
    const state=JSON.parse((await h.db.prepare('SELECT state FROM sync_heads WHERE owner=?').bind(h.owner).first()).state);assert.equal(state.files,1);assert.equal(state.data['app.notes'],1);
    await h.file('b');assert.equal(JSON.parse((await h.db.prepare('SELECT state FROM sync_heads WHERE owner=?').bind(h.owner).first()).state).files,2);
    await h.request('/api/admin/account/reset',{method:'POST',data:{currentPassword:'test-password-1234',confirmation:'RESET'}});
    for(const table of ['sync_heads','device_sync_summaries'])assert.equal((await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n,0);
  }finally{await h.dispose();}
});

test('未经摘要比对的发布不能把他人并发写入标记为本机已持有',async()=>{
  const h=await fixture();try{
    const post=data=>h.request('/api/v2/sync/push',{method:'POST',token:h.binding.token,data});
    const session=(await post({action:'start',requestId:crypto.randomUUID(),scope:notes})).value.session;
    await post({requestId:crypto.randomUUID(),session,namespace:'app.notes',upsert:[{key:'one',value:'local'}]});
    await h.data('app.notes','concurrent');await post({action:'finish',session});
    assert.equal(await h.db.prepare('SELECT state FROM device_sync_summaries WHERE device=?').bind(h.device.id).first(),null);
    const result=(await h.start(notes)).value;assert.equal(result.total,1);
    assert.equal((await h.post({action:'page',session:result.session,page:result.page})).value.items[0].value,'concurrent');
  }finally{await h.dispose();}
});

test('重叠范围确认不同快照后，不会复用过时的空恢复结果',async()=>{
  const h=await fixture();try{
    const single={namespaces:[],files:true,roots:['a.py']};
    await h.file('before');await h.complete((await h.start(single)).value);
    const earlier=(await h.start(files,{full:true})).value;
    await h.file('after');await h.complete((await h.start(single)).value);
    await h.complete(earlier);
    const repair=(await h.start(single)).value;assert.equal(repair.total,1);
    const page=(await h.post({action:'page',session:repair.session,page:repair.page})).value;
    assert.equal((await h.post({action:'content',session:repair.session,content:page.items[0].content})).value,'after');
  }finally{await h.dispose();}
});

test('空库使用一个事务完成重建，重复检查不再清空数据',async()=>{
  const h=await createHarness({setup:false,migrations:0});try{
    const built=await build({entryPoints:['src/schema/ensure.js'],bundle:true,write:false,format:'esm',platform:'browser',loader:{'.sql':'text'}});
    const {ensureSchema}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
    const meter=measuredDatabase(h.db),env={DB:meter.DB};
    assert.equal(await ensureSchema(env),true);
    meter.queries.length=0;assert.equal(await ensureSchema(env),true);assert.equal(meter.queries.length,0);
    assert.ok(await h.db.prepare("SELECT name FROM sqlite_master WHERE name='device_sync_summaries'").first());
  }finally{await h.dispose();}
});
