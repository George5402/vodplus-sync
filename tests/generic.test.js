// v2 在真实 D1 验证普通数据、文件、固定快照和成功确认，不操作生产服务。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.js';
import {SyncClient} from '../examples/sync-v2-client.js';
import {maintenance} from '../src/maintenance.js';
import {publication} from '../src/generic/publication.js';
const uuid=()=>crypto.randomUUID();
async function fixture(){
  const h=await createHarness(),owner=await h.createUser('通用用户'),a=await h.bind(owner),b=await h.bind(owner);
  const post=(path,data,device=a)=>h.request('/api/v2/sync/'+path,{method:'POST',token:device.token,data});
  const push=(namespace,upsert,extra={})=>post('push',{requestId:uuid(),namespace,upsert,...extra});
  const file=(path,text,extra={})=>h.request('/api/v2/sync/file?path='+encodeURIComponent(path),{method:'PUT',token:a.token,raw:text,headers:{'idempotency-key':uuid(),...extra}});
  const start=(scope,extra={},device=b)=>post('restore',{action:'start',requestId:uuid(),scope,...extra},device);
  const pages=async(session,device=b)=>{
    const items=[];let page=session.page;
    while(page){const r=await post('restore',{action:'page',session:session.session,page},device);assert.equal(r.status,200,JSON.stringify(r.value));items.push(...r.value.items);page=r.value.next;}
    return items;
  };
  const ack=(s,device=b)=>post('restore',{action:'ack',session:s.session},device);
  return {...h,owner,a,b,post,push,file,start,pages,ack};
}
const scope={namespaces:['example.notes','example.ext'],files:true};

test('清单确认与排除规则并发变化时重读规则，不误删刚排除的目录',async()=>{
  const h=await fixture();try{
    await h.file('cache/a.py','keep');
    const session=(await h.post('push',{action:'start',requestId:uuid(),scope})).value.session;
    let changed=false;
    const db={prepare:sql=>h.db.prepare(sql),batch:async statements=>{
      if(!changed){changed=true;await h.db.prepare('UPDATE sync_settings SET excluded_directories=?,revision=revision+1').bind('["cache"]').run();}
      return h.db.batch(statements);
    }};
    const response=await publication({DB:db},{id:h.a.deviceId,user_id:h.owner},{action:'finish',session});
    assert.equal(response.status,200);assert.equal((await h.lookupFile(h.owner,'cache/a.py')).deleted,0);
  }finally{await h.dispose();}
});

test('v2 普通键和 JSON 标量不需要业务 ID，命名空间隔离且重试幂等',async()=>{
  const h=await fixture();try{
    const input={requestId:uuid(),namespace:'example.notes',upsert:[{key:'plain name',value:'文字'},{key:'scalar',value:false}]};
    assert.equal((await h.post('push',input)).status,200);assert.equal((await h.post('push',input)).status,200);
    assert.equal((await h.post('push',{...input,upsert:[{key:'plain name',value:3}]})).status,409);
    await h.push('example.ext',[{key:'unknown',value:{future:true}}]);await h.push('example.notes',[{key:'scalar',value:42}]);
    const s=await h.start(scope);assert.equal(s.status,200,JSON.stringify(s.value));
    const items=await h.pages(s.value);assert.equal(items.length,3);assert.ok(items.some(x=>x.value===42));assert.ok(items.some(x=>x.value==='文字'));
    assert.equal((await h.ack(s.value)).status,200);assert.equal((await h.ack(s.value)).status,200);
    const next=await h.start(scope);assert.equal(next.value.mode,'delta');assert.equal(next.value.total,0);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM changes WHERE owner=?").bind(h.owner).first()).n,4);
  }finally{await h.dispose();}
});

test('文件直接发布和父目录创建，恢复内容固定在开始时且跨设备标记无效',async()=>{
  const h=await fixture();try{
    assert.equal((await h.file('dir/a.py','first')).status,200);
    const s=(await h.start(scope)).value;const items=await h.pages(s);assert.equal(items.length,1);assert.equal(items[0].path,'dir/a.py');
    await h.file('dir/a.py','second');
    const req={action:'content',session:s.session,content:items[0].content};
    assert.equal((await h.post('restore',req,h.b)).value,'first');assert.equal((await h.post('restore',req,h.a)).status,404);
    await h.ack(s);const next=(await h.start(scope)).value;assert.equal(next.mode,'delta');assert.equal(next.total,1);
    assert.equal((await h.post('restore',{action:'content',session:next.session,content:(await h.pages(next))[0].content},h.b)).value,'second');
    const entities=(await h.request(`/api/admin/spaces/${h.owner}/entities`)).value.items;assert.ok(entities.some(x=>x.kind==='directory'&&x.path==='dir'));
  }finally{await h.dispose();}
});

test('分页不得提前确认，未确认重启强制全量并处理云端改回旧值',async()=>{
  const h=await fixture();try{
    await h.push('example.notes',Array.from({length:50},(_,i)=>({key:String(i),value:i})));
    const s=(await h.start(scope)).value;assert.equal(s.total,50);assert.equal((await h.ack(s)).status,409);
    const first=await h.post('restore',{action:'page',session:s.session,page:s.page},h.b);assert.equal(first.value.items.length,25);assert.equal((await h.ack(s)).status,409);
    await h.pages(s);await h.ack(s);
    await h.push('example.notes',[{key:'0',value:'temporary'},{key:'partial',value:1}]);
    const interrupted=(await h.start(scope)).value;await h.pages(interrupted);
    await h.push('example.notes',[{key:'0',value:0}],{delete:['partial']});
    const retry=(await h.start(scope)).value;assert.equal(retry.mode,'full');const items=await h.pages(retry);
    assert.ok(items.some(i=>i.key==='0'&&i.value===0));assert.ok(items.some(i=>i.key==='partial'&&i.op==='delete'));
    assert.equal((await h.ack(interrupted)).status,409);assert.equal((await h.ack(retry)).status,200);
  }finally{await h.dispose();}
});

test('显式删除下发，规则排除和 scope 切换不会产生错误删除',async()=>{
  const h=await fixture();try{
    await h.file('dir/a.py','a');await h.file('b.py','b');
    const s=(await h.start(scope)).value;await h.pages(s);await h.ack(s);
    const settings=(await h.request('/api/admin/sync-settings')).value;
    await h.request('/api/admin/sync-settings',{method:'PUT',data:{...settings,excludedDirectories:['dir']}});
    await h.request('/api/v2/sync/file?path=b.py',{method:'DELETE',token:h.a.token,headers:{'idempotency-key':uuid()}});
    const next=(await h.start(scope)).value;const items=await h.pages(next);assert.deepEqual(items.map(x=>[x.op,x.path]),[['delete','b.py']]);
    assert.equal((await h.file('dir/a.py','new')).value.skipped,true);
    assert.equal((await h.start({namespaces:['example.notes']})).value.mode,'full');
  }finally{await h.dispose();}
});

test('完整发布只在 finish 后删除缺失项，保留扩展分区和排除目录',async()=>{
  const h=await fixture();try{
    await h.push('example.notes',[{key:'keep',value:1},{key:'remove',value:2}]);await h.push('example.ext',[{key:'other',value:3}]);
    await h.file('a.py','a');await h.file('b.py','b');await h.file('cache/c.py','c');
    const settings=(await h.request('/api/admin/sync-settings')).value;
    await h.request('/api/admin/sync-settings',{method:'PUT',data:{...settings,excludedDirectories:['cache']}});
    const pub=await h.post('push',{action:'start',requestId:uuid(),scope:{namespaces:['example.notes'],files:true}});assert.equal(pub.status,200,JSON.stringify(pub.value));
    const session=pub.value.session;
    assert.equal((await h.push('example.notes',[{key:'keep',value:9}],{session})).status,200);
    assert.equal((await h.file('a.py','A',{'x-sync-session':session})).status,200);
    assert.equal((await h.lookupFile(h.owner,'b.py')).deleted,0);
    assert.equal((await h.post('push',{action:'finish',session})).status,200);assert.equal((await h.post('push',{action:'finish',session})).status,200);
    assert.equal((await h.lookupFile(h.owner,'b.py')).deleted,1);
    assert.equal((await h.lookupFile(h.owner,'cache/c.py')).deleted,0);
    const s=(await h.start(scope)).value;const items=await h.pages(s);assert.ok(items.some(i=>i.key==='other'));assert.ok(!items.some(i=>i.key==='remove'));
  }finally{await h.dispose();}
});

test('旧数据以不透明 legacy 分区读取，v2 不要求其业务字段且恢复会话可被重置清空',async()=>{
  const h=await fixture();try{
    await h.db.prepare("INSERT INTO entities VALUES(?,?,'custom-kind',NULL,1,?,0,1,'test',1)").bind(h.owner,'old-record','{"unknown":"preserved"}').run();
    const s=(await h.start({namespaces:['legacy.custom-kind']})).value;
    assert.deepEqual((await h.pages(s))[0],{type:'data',op:'put',namespace:'legacy.custom-kind',key:'old-record',value:{unknown:'preserved'}});
    await h.post('push',{action:'start',requestId:uuid(),scope});
    assert.equal((await h.request('/api/admin/account/reset',{method:'POST',data:{currentPassword:'test-password-1234',confirmation:'RESET'}})).status,200);
    for(const table of ['restore_sessions','restore_snapshots','restore_items','restore_known','restore_baselines','publish_sessions','publish_items'])assert.equal((await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n,0);
  }finally{await h.dispose();}
});

test('通用接口沿用设备授权，不同用户的数据和会话完全隔离',async()=>{
  const h=await fixture();try{
    const other=await h.bind(await h.createUser('其他用户'));
    await h.push('example.notes',[{key:'private',value:1}]);
    const mine=(await h.start(scope)).value;
    assert.equal((await h.start(scope,{},other)).value.total,0);
    assert.equal((await h.post('restore',{action:'page',session:mine.session,page:mine.page},other)).status,404);
    assert.equal((await h.request('/api/v2/sync/push',{method:'POST',admin:false,data:{}})).status,401);
    const pub=(await h.post('push',{action:'start',requestId:uuid(),scope})).value;
    assert.equal((await h.post('push',{action:'finish',session:pub.session},other)).status,404);
  }finally{await h.dispose();}
});

test('过期会话清理后仍保留未完成恢复的已知删除和完整恢复要求',async()=>{
  const h=await fixture();try{
    await h.file('temporary.py','x');const interrupted=(await h.start(scope)).value;await h.pages(interrupted);
    await h.request('/api/v2/sync/file?path=temporary.py',{method:'DELETE',token:h.a.token,headers:{'idempotency-key':uuid()}});
    await h.db.prepare('UPDATE restore_sessions SET expires=1 WHERE token=?').bind(interrupted.session).run();
    assert.equal((await h.ack(interrupted)).status,410);
    await maintenance({DB:h.db});
    const retry=(await h.start(scope)).value;assert.equal(retry.mode,'full');assert.deepEqual((await h.pages(retry)).map(i=>[i.op,i.path]),[['delete','temporary.py']]);
    await h.ack(retry);assert.equal((await h.start(scope)).value.total,0);
  }finally{await h.dispose();}
});

test('SDK 可完整推送与下载，覆盖本机修改，真实 I/O 失败不确认基线',async()=>{
  const h=await fixture();try{
    const progress=[];const transport=(url,init)=>h.mf.dispatchFetch(url,init);
    const sender=new SyncClient({server:'http://localhost',token:h.a.token,fetch:transport});
    await sender.pushAll({scope,records:[{namespace:'example.notes',key:'message',value:{text:'cloud'}}],files:[{path:'dir/x.py',read:async()=>new TextEncoder().encode('cloud file')}]});
    const receiver=new SyncClient({server:'http://localhost',token:h.b.token,fetch:transport,onProgress:item=>progress.push(item)});
    const data=new Map([['message','unsent local']]),files=new Map();
    const options={scope,beginFull:async()=>data.clear(),putData:async(ns,key,value)=>data.set(key,value),deleteData:async(ns,key)=>data.delete(key),putFile:async(path,bytes)=>files.set(path,new TextDecoder().decode(bytes)),deleteFile:async path=>files.delete(path)};
    await receiver.download(options);assert.equal(data.get('message').text,'cloud');assert.equal(files.get('dir/x.py'),'cloud file');assert.equal(progress.at(-1).done,true);
    await sender.pushFile('dir/x.py',new TextEncoder().encode('updated'));
    await assert.rejects(receiver.download({...options,putFile:async()=>{throw new Error('disk full');}}),/disk full/);
    assert.equal((await h.db.prepare('SELECT dirty FROM restore_baselines WHERE device=?').bind(h.b.deviceId).first()).dirty,1);
    await receiver.download(options);assert.equal(files.get('dir/x.py'),'updated');
  }finally{await h.dispose();}
});
