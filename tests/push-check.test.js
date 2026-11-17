// 验证摘要一致时不传正文，以及清单确认前的并发变化与删除保护。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.js';
import {SyncClient} from '../examples/sync-v2-client.js';
import {valueDigest,bytesDigest,canonicalValue,valueFingerprint,bytesFingerprint} from '../src/lib/content-digest.js';
import {publication} from '../src/generic/publication.js';
const uuid=()=>crypto.randomUUID();
const scope={namespaces:['app.notes'],files:true};
const encode=value=>new TextEncoder().encode(value);
async function fixture(){
  const h=await createHarness(),owner=await h.createUser('按需上传'),device=await h.bind(owner);
  const post=data=>h.request('/api/v2/sync/push',{method:'POST',token:device.token,data});
  const push=(key,value,session)=>post({requestId:uuid(),namespace:'app.notes',upsert:[{key,value}],...(session?{session}:{})});
  const file=(path,content,session)=>h.request('/api/v2/sync/file?path='+encodeURIComponent(path),{method:'PUT',raw:content,token:device.token,headers:{'idempotency-key':uuid(),...(session?{'x-sync-session':session}:{})}});
  const start=async()=>(await post({action:'start',requestId:uuid(),scope})).value.session;
  const dataItem=async(key,value)=>({type:'data',namespace:'app.notes',key,hash:await valueDigest(value)});
  const fileItem=async(path,value)=>({type:'file',path,size:encode(value).length,hash:await bytesDigest(encode(value))});
  return {...h,owner,device,post,push,file,start,dataItem,fileItem};
}

test('跨语言摘要固定向量、键顺序、零和转义保持稳定',async()=>{
  assert.equal(await valueDigest(null),'1b16b1df538ba12dc3f97edbb85caa7050d46c148134290feba80f8236c83db9');
  assert.equal(await valueDigest('你好🌍'),'fbbe9eb69560fbdb0395c36975c52291ed99ea06b6a813af72c70e0d63943d79');
  assert.equal(await valueDigest({b:2,a:'x'}),'39e144ee963971610cb872fd4a7f10fdce56af3b67cc30d693a61aa6315b2976');
  assert.equal(await valueDigest({a:'x',b:2}),await valueDigest({b:2,a:'x'}));
  assert.equal(await valueDigest(-0),await valueDigest(0));assert.notEqual(await valueDigest('1'),await valueDigest(1));
  assert.equal(canonicalValue(1.5),'d3ff8000000000000');assert.equal(await valueDigest(JSON.parse('"\\u4f60"')),await valueDigest('你'));
  assert.throws(()=>canonicalValue('\ud800'),/Unicode/);assert.throws(()=>canonicalValue(Infinity),/有限值/);
  assert.equal(await valueFingerprint('Hello'),'3698dca7681f48f88f5ad97df04ad2ba');
  assert.equal(await bytesFingerprint(encode('Hello')),'185f8db32271fe25f561a6fc938b2e26');
});

test('一致数据与文件直接计入清单，无内容更新且不会被 finish 删除',async()=>{
  const h=await fixture();try{
    await h.push('note',{b:2,a:'x'});await h.file('a.py','hello');const session=await h.start();
    const before=(await h.db.prepare('SELECT COUNT(*) n FROM changes WHERE owner=?').bind(h.owner).first()).n;
    const items=[await h.dataItem('note',{a:'x',b:2}),await h.fileItem('a.py','hello')];
    const result=await h.post({action:'check',session,items});assert.equal(result.status,200,JSON.stringify(result.value));assert.deepEqual(result.value.items.map(i=>i.status),['unchanged','unchanged']);
    assert.equal((await h.post({action:'check',session,items})).value.items[0].status,'unchanged');
    assert.equal((await h.post({action:'finish',session})).value.ok,true);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM changes WHERE owner=?').bind(h.owner).first()).n,before);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM entities WHERE owner=? AND deleted=0').bind(h.owner).first()).n,1);assert.equal((await h.files(h.owner)).length,1);
  }finally{await h.dispose();}
});

test('需要上传时不提前删除缺失项目，数据和文件上传后才能完成清单',async()=>{
  const h=await fixture();try{
    await h.file('removed.py','keep until finish');const session=await h.start();
    const items=[await h.dataItem('new',null),await h.fileItem('new.py','new')];
    assert.deepEqual((await h.post({action:'check',session,items})).value.items.map(i=>i.status),['upload','upload']);
    const pending=await h.post({action:'finish',session});assert.equal(pending.value.ok,false);assert.equal(pending.value.upload.length,2);
    assert.equal((await h.lookupFile(h.owner,'removed.py')).deleted,0);
    await h.push('new',null,session);await h.file('new.py','new',session);
    assert.equal((await h.post({action:'finish',session})).value.ok,true);
    assert.equal((await h.lookupFile(h.owner,'removed.py')).deleted,1);
  }finally{await h.dispose();}
});

test('比对后云端发生变化，确认返回补传清单并保留待删除文件',async()=>{
  const h=await fixture();try{
    await h.push('same','local');await h.file('removed.py','x');const session=await h.start();
    await h.post({action:'check',session,items:[await h.dataItem('same','local')]});
    await h.push('same','other device');
    const result=await h.post({action:'finish',session});assert.equal(result.value.ok,false);assert.deepEqual(result.value.upload,[{type:'data',namespace:'app.notes',key:'same'}]);
    assert.equal((await h.lookupFile(h.owner,'removed.py')).deleted,0);
    await h.push('same','local',session);assert.equal((await h.post({action:'finish',session})).value.ok,true);
  }finally{await h.dispose();}
});

test('确认事务开始前发生并发修改，也不能跳过补传检查',async()=>{
  const h=await fixture();try{
    await h.file('a.py','local');const session=await h.start();await h.post({action:'check',session,items:[await h.fileItem('a.py','local')]});
    let changed=false;const db={prepare:sql=>h.db.prepare(sql),batch:async statements=>{if(!changed){changed=true;await h.file('a.py','remote');}return h.db.batch(statements);}};
    const response=await publication({DB:db},{id:h.device.deviceId,user_id:h.owner},{action:'finish',session});
    assert.equal((await response.json()).ok,false);
    await h.file('a.py','local',session);assert.equal((await h.post({action:'finish',session})).value.ok,true);
  }finally{await h.dispose();}
});

test('排除项返回 skipped，不同设备无法借用比对会话，校验失败不登记部分项目',async()=>{
  const h=await fixture();try{
    const session=await h.start();const result=await h.post({action:'check',session,items:[await h.fileItem('_cache/a.py','skip'),await h.fileItem('a.exe','skip')]});
    assert.deepEqual(result.value.items.map(i=>[i.status,i.reason]),[['skipped','DIRECTORY_EXCLUDED'],['skipped','FILE_TYPE_NOT_ALLOWED']]);
    const valid=await h.dataItem('one',1);
    assert.equal((await h.post({action:'check',session,items:[valid,{...valid,key:'two',hash:'bad'}]})).status,400);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM publish_checks WHERE session=?').bind(session).first()).n,0);
    const other=await h.bind(h.owner);
    assert.equal((await h.request('/api/v2/sync/push',{method:'POST',token:other.token,data:{action:'check',session,items:[valid]}})).status,404);
    assert.equal((await h.post({action:'finish',session})).value.ok,true);
  }finally{await h.dispose();}
});

test('SDK 重复推送无正文上传，只修改一项时只传对应数据和文件',async()=>{
  const h=await fixture();try{
    const transfers=[];const progress=[];
    const sdk=new SyncClient({server:'http://localhost',token:h.device.token,onProgress:item=>progress.push(item),fetch:(url,init)=>{
      if(init.method==='PUT')transfers.push(new URL(url).searchParams.get('path'));
      else if(typeof init.body==='string'){const data=JSON.parse(init.body);if(data.upsert)transfers.push(...data.upsert.map(item=>item.key));}
      return h.mf.dispatchFetch(url,init);
    }});
    let value=1;let text='one';
    const payload=()=>({scope,records:[{namespace:'app.notes',key:'a',value},{namespace:'app.notes',key:'b',value:2}],files:[{path:'a.py',read:async()=>encode(text)},{path:'b.py',read:async()=>encode('two')}]});
    await sdk.pushAll(payload());assert.equal(transfers.length,4);transfers.length=0;
    await sdk.pushAll(payload());assert.deepEqual(transfers,[]);assert.equal(progress.at(-1).unchanged,4);
    value=3;text='three';await sdk.pushAll(payload());assert.deepEqual(transfers,['a','a.py']);
  }finally{await h.dispose();}
});

test('服务重置清空比对记录，确认接口不能绕过已过期会话',async()=>{
  const h=await fixture();try{
    const session=await h.start();await h.post({action:'check',session,items:[await h.dataItem('one',1)]});
    await h.db.prepare('UPDATE publish_sessions SET expires=1 WHERE token=?').bind(session).run();
    assert.equal((await h.post({action:'check',session,items:[await h.dataItem('one',1)]})).status,410);
    assert.equal((await h.post({action:'finish',session})).status,410);
    await h.request('/api/admin/account/reset',{method:'POST',data:{currentPassword:'test-password-1234',confirmation:'RESET'}});
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM publish_checks').first()).n,0);
  }finally{await h.dispose();}
});
