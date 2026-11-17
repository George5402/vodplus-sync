// 大文件空间的清单查询与比对按 JSON 文档计费，不随文件数逐项扫描数据库。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './harness.js';
import {restore} from '../src/generic/restore.js';
import {checkPush} from '../src/generic/check.js';
import {publication} from '../src/generic/publication.js';
import {fileRows} from '../src/storage/catalog.js';
import {measuredDatabase} from './query-metrics.js';
import {seedFiles} from './file-fixture.js';

for(const count of [500,1000])test(`${count} 文件清单与比对保持常量读取，变化恢复使用 JSON 快照`,async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('文件用量'),bound=await h.bind(owner),device={id:bound.deviceId,user_id:owner};
    const fixture=await seedFiles(h.db,owner,count),meter=measuredDatabase(h.db),env={DB:meter.DB},scope={namespaces:[],files:true};
    assert.equal((await fileRows(env,owner)).length,count+1);const listing=meter.summary();assert.equal(listing.read,1);
    const publish=await (await publication(env,device,{action:'start',requestId:crypto.randomUUID(),scope})).json();meter.queries.length=0;
    const inputs=Array.from({length:count},(_,i)=>({type:'file',path:`files/file-${String(i).padStart(4,'0')}.py`,size:fixture.content.length,hash:fixture.hash.slice(0,32)}));
    const checked=await (await checkPush(env,device,{action:'check',session:publish.session,items:inputs})).json();assert.ok(checked.items.every(item=>item.status==='unchanged'));
    const comparison=meter.summary();assert.ok(comparison.read<30,JSON.stringify(comparison));assert.ok(comparison.written<10);
    meter.queries.length=0;assert.equal((await (await publication(env,device,{action:'finish',session:publish.session})).json()).ok,true);
    const finish=meter.summary();assert.ok(finish.read<80,JSON.stringify(finish));assert.ok(finish.written<20,JSON.stringify(finish));
    meter.queries.length=0;
    const session=await (await restore(env,device,{action:'start',requestId:crypto.randomUUID(),scope,full:true})).json();
    let page=session.page;while(page){const result=await (await restore(env,device,{action:'page',session:session.session,page})).json();page=result.next;}
    await restore(env,device,{action:'ack',session:session.session});const first=meter.summary();assert.ok(first.read<count,JSON.stringify(first));assert.ok(first.written<count);
    meter.queries.length=0;
    const repeated=await (await restore(env,device,{action:'start',requestId:crypto.randomUUID(),scope})).json();assert.equal(repeated.total,0);
    await restore(env,device,{action:'ack',session:repeated.session});const unchanged=meter.summary();assert.ok(unchanged.read<=30);assert.ok(unchanged.written<=10);
    console.log(JSON.stringify({files:count,listing,comparison,finish,restoreMetadata:first,unchanged}));
  }finally{await h.dispose();}
});
