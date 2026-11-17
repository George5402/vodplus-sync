// 文件目录、正文和同步状态的 JSON/BLOB 结构及原子性验收。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,digest} from './harness.js';
import {Catalog,readCatalog,fileRows} from '../src/storage/catalog.js';
import {getContent} from '../src/storage/content.js';
import {primaryDocument,documentCondition,readDocument} from '../src/storage/documents.js';
import {measuredDatabase} from './query-metrics.js';
import {seedFiles} from './file-fixture.js';
const uuid=()=>crypto.randomUUID();

test('1000 个文件的清单只读一行，所有文件 ID 为稳定整数',async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('千文件');const fixture=await seedFiles(h.db,owner,1000);
    const meter=measuredDatabase(h.db),rows=await fileRows({DB:meter.DB},owner);assert.equal(rows.length,1001);assert.equal(meter.summary().read,1);
    const catalog=await readCatalog({DB:h.db},owner);assert.ok(Object.values(catalog.value.items).every(item=>Number.isSafeInteger(item.id)));assert.equal(catalog.value.nextId,1002);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM json_documents WHERE key=?').bind(`catalog:${owner}`).first()).n,1);
    meter.queries.length=0;assert.deepEqual(Buffer.from((await getContent({DB:meter.DB},owner,fixture.hash)).body),fixture.content);assert.equal(meter.summary().read,1);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM entities WHERE owner=? AND kind IN ('file','directory')").bind(owner).first()).n,0);
  }finally{await h.dispose();}
});

test('目录移动保留数字 ID，删除后创建同名文件不会复用 ID',async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('数字ID'),device=await h.bind(owner);
    const upload=()=>h.request('/api/v2/sync/file?path=dir/a.py',{method:'PUT',token:device.token,raw:'a',headers:{'idempotency-key':uuid()}});
    assert.equal((await upload()).status,200);
    let model=new Catalog((await readCatalog({DB:h.db},owner)).value);const before=model.byPath('dir/a.py').id,folder=model.row(model.byPath('dir'));
    await h.request(`/api/admin/spaces/${owner}/commit`,{method:'POST',data:{opId:uuid(),patch:{...folder,path:'moved',baseVersion:folder.version}}});
    model=new Catalog((await readCatalog({DB:h.db},owner)).value);assert.equal(model.byPath('moved/a.py').id,before);
    await h.request('/api/v2/sync/file?path=moved/a.py',{method:'DELETE',token:device.token,headers:{'idempotency-key':uuid()}});
    await h.request('/api/v2/sync/file?path=moved/a.py',{method:'PUT',token:device.token,raw:'a',headers:{'idempotency-key':uuid()}});
    model=new Catalog((await readCatalog({DB:h.db},owner)).value);assert.notEqual(model.byPath('moved/a.py').id,before);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM file_contents WHERE owner=?').bind(owner).first()).n,1);
  }finally{await h.dispose();}
});

test('并发创建不同文件不会覆盖清单，同文件更新生成连续版本',async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('并发JSON'),device=await h.bind(owner);
    const upload=(path,text)=>h.request('/api/v2/sync/file?path='+path,{method:'PUT',token:device.token,raw:text,headers:{'idempotency-key':uuid()}});
    const created=await Promise.all([upload('a.py','a'),upload('b.py','b')]);assert.ok(created.every(r=>r.status===200));
    const original=(await h.lookupFile(owner,'a.py')).id;
    assert.ok((await Promise.all([upload('a.py','first'),upload('a.py','second')])).every(r=>r.status===200));
    const updated=await h.lookupFile(owner,'a.py');assert.equal(updated.id,original);assert.equal(updated.version,3);assert.equal((await h.files(owner)).length,2);
  }finally{await h.dispose();}
});

test('正文写入失败时清单、回执和发布状态整体回滚',async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('原子写入'),device=await h.bind(owner),operation=uuid();
    const session=(await h.request('/api/v2/sync/push',{method:'POST',token:device.token,data:{action:'start',requestId:uuid(),scope:{namespaces:[],files:true}}})).value.session;
    await h.db.prepare("CREATE TRIGGER block_blob BEFORE INSERT ON file_contents BEGIN SELECT RAISE(ABORT,'test blob failure'); END;").run();
    const request=()=>h.request('/api/v2/sync/file?path=a.py',{method:'PUT',token:device.token,raw:'body',headers:{'idempotency-key':operation,'x-sync-session':session}});
    assert.equal((await request()).status,500);assert.equal((await h.files(owner)).length,0);
    assert.equal(await h.db.prepare('SELECT op_id FROM receipts WHERE principal=? AND op_id=?').bind(`v2:${device.deviceId}`,operation).first(),null);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM file_contents').first()).n,0);
    await h.db.prepare('DROP TRIGGER block_blob').run();assert.equal((await request()).status,200);assert.equal(new Catalog((await readCatalog({DB:h.db},owner)).value).byPath('a.py').id,1);
  }finally{await h.dispose();}
});

test('大 JSON 自动按 UTF-8 边界分片，缩小时清理多余片段',async()=>{
  const h=await createHarness();try{
    const env={DB:h.db};let document=await readDocument(env,'test-document',{});const large={text:'中文🌍'.repeat(300000)};
    let condition=documentCondition([document]),transaction=primaryDocument(env,document,large,condition.sql,condition.values);await h.db.batch(transaction.statements);
    document=await readDocument(env,'test-document',{});assert.deepEqual(document.value,large);
    const meta=await h.db.prepare('SELECT COUNT(*) n,MAX(length(CAST(value AS BLOB))) largest FROM json_documents WHERE key=?').bind('test-document').first();assert.ok(meta.n>1);assert.ok(meta.largest<2000000);
    condition=documentCondition([document]);transaction=primaryDocument(env,document,{text:'small'},condition.sql,condition.values);await h.db.batch(transaction.statements);
    assert.deepEqual((await readDocument(env,'test-document',{})).value,{text:'small'});assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM json_documents WHERE key=?').bind('test-document').first()).n,1);
  }finally{await h.dispose();}
});

test('后台记录页可以编辑通用 JSON 记录，不混入文件清单',async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('记录编辑'),device=await h.bind(owner);
    await h.request('/api/v2/sync/push',{method:'POST',token:device.token,data:{requestId:uuid(),namespace:'app.notes',upsert:[{key:'one',value:{title:'before'}}]}});
    const row=(await h.request(`/api/admin/spaces/${owner}/entities?kind=records`)).value.items[0];
    const update=await h.request(`/api/admin/spaces/${owner}/commit`,{method:'POST',data:{opId:uuid(),patch:{...row,baseVersion:row.version,data:{...row.data,value:{title:'after'}}}}});
    assert.equal(update.status,200,JSON.stringify(update.value));assert.equal(update.value.items[0].data.value.title,'after');
    assert.deepEqual((await h.request(`/api/admin/spaces/${owner}/entities?kind=files`)).value.items,[]);
  }finally{await h.dispose();}
});

test('连续中断及重命名后，恢复仍能清理可能已应用的全部路径',async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('中断重命名'),writer=await h.bind(owner),reader=await h.bind(owner);
    await h.request('/api/v2/sync/file?path=a.py',{method:'PUT',token:writer.token,raw:'a',headers:{'idempotency-key':uuid()}});
    const start=async()=>(await h.request('/api/v2/sync/restore',{method:'POST',token:reader.token,data:{action:'start',requestId:uuid(),scope:{namespaces:[],files:true}}})).value;
    const page=async session=>(await h.request('/api/v2/sync/restore',{method:'POST',token:reader.token,data:{action:'page',session:session.session,page:session.page}})).value.items;
    await page(await start());
    const file=await h.lookupFile(owner,'a.py');
    await h.request(`/api/admin/spaces/${owner}/commit`,{method:'POST',data:{opId:uuid(),patch:{...file,path:'b.py',baseVersion:file.version}}});
    await page(await start());
    await h.request('/api/v2/sync/file?path=b.py',{method:'DELETE',token:writer.token,headers:{'idempotency-key':uuid()}});
    const deleted=await page(await start());assert.deepEqual(deleted.filter(item=>item.op==='delete').map(item=>item.path).sort(),['a.py','b.py']);
  }finally{await h.dispose();}
});
