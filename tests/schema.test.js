// 开发数据重建只执行一次；格式标记和迁移日志共同防止重复清空。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createHarness,digest} from './harness.js';
import {password} from '../src/lib/crypto.js';
import {MIGRATION_NAMES} from '../src/schema/plan.js';
async function ensureModule(){
  const built=await build({entryPoints:['src/schema/ensure.js'],bundle:true,write:false,format:'esm',platform:'browser',loader:{'.sql':'text'}});
  return (await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'))).ensureSchema;
}
async function seedDevelopment(h){
  await h.db.batch([
    h.db.prepare('INSERT INTO administrators VALUES(1,?,?)').bind('development-admin',await password('12345')),
    h.db.prepare('INSERT INTO users VALUES(?,?,1,1)').bind('development-user','开发用户'),
    h.db.prepare('INSERT INTO file_contents VALUES(?,?,?,1)').bind('development-user',digest('content'),7),
    h.db.prepare('INSERT INTO file_chunks VALUES(?,?,0,?)').bind('development-user',digest('content'),Buffer.from('content').toString('base64'))
  ]);
}
test('存储重建清空开发数据，建立 BLOB 与 JSON 文档并重新开放初始化',async()=>{
  const h=await createHarness({setup:false,migrations:12});try{
    await seedDevelopment(h);
    assert.equal((await h.request('/api/status')).value.initialized,false);
    for(const table of ['users','administrators','file_contents','json_documents'])assert.equal((await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n,0);
    assert.equal(await h.db.prepare("SELECT name FROM sqlite_master WHERE name='file_chunks'").first(),null);
    assert.equal((await h.db.prepare('SELECT version FROM storage_format WHERE id=1').first()).version,13);
    assert.equal((await h.db.prepare('PRAGMA table_info(file_contents)').all()).results.find(row=>row.name==='content').type,'BLOB');
    assert.equal((await h.request('/api/setup',{method:'POST',data:{username:'admin',password:'12345'}})).status,200);
    assert.equal((await h.request('/api/status')).value.initialized,true);
  }finally{await h.dispose();}
});
test('空库自动初始化全部当前结构，创建账号后访问不会重复清空',async()=>{
  const h=await createHarness({setup:false,migrations:0});try{
    assert.equal((await h.request('/api/status')).value.initialized,false);
    assert.equal((await h.request('/api/health')).status,200);
    assert.equal((await h.request('/api/setup',{method:'POST',data:{username:'admin',password:'12345'}})).status,200);
    assert.equal((await h.request('/api/status')).value.initialized,true);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM d1_migrations').first()).n,MIGRATION_NAMES.length);
  }finally{await h.dispose();}
});
test('重建中发生异常时连同清空操作整体回滚',async()=>{
  const h=await createHarness({setup:false,migrations:12});try{
    await seedDevelopment(h);
    await h.db.prepare("CREATE TRIGGER prevent_reset BEFORE DELETE ON file_contents BEGIN SELECT RAISE(ABORT,'test rollback'); END;").run();
    assert.equal((await h.request('/api/status')).status,500);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM administrators').first()).n,1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM file_contents').first()).n,1);
    assert.equal(await h.db.prepare("SELECT name FROM sqlite_master WHERE name='storage_format'").first(),null);
    await h.db.prepare('DROP TRIGGER prevent_reset').run();
    assert.equal((await h.request('/api/status')).value.initialized,false);
  }finally{await h.dispose();}
});
test('格式标记存在时补齐迁移记录，不会重复重建',async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('保留用户');await h.put(owner,'keep.py');
    await h.db.prepare("DELETE FROM d1_migrations WHERE name='0013_compact_file_storage.sql'").run();
    const ensure=await ensureModule();await ensure({DB:h.db});
    assert.equal((await h.request('/api/status')).value.initialized,true);assert.ok(await h.file(owner,'keep.py'));
    assert.ok(await h.db.prepare("SELECT name FROM d1_migrations WHERE name='0013_compact_file_storage.sql'").first());
    assert.equal(await h.db.prepare("SELECT name FROM sqlite_master WHERE name='file_chunks'").first(),null);
  }finally{await h.dispose();}
});
test('缺失设备配置表时只补齐该表，文件与管理员保留',async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('保留文件');await h.put(owner,'keep.py');
    await h.db.prepare('DROP TABLE device_config').run();
    await (await ensureModule())({DB:h.db});
    assert.ok(await h.file(owner,'keep.py'));assert.equal((await h.request('/api/status')).value.initialized,true);
    assert.equal((await h.request('/api/health')).status,200);
  }finally{await h.dispose();}
});
test('重置触发器缺失时修复为当前表结构，再原子清空',async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('待清空');await h.put(owner,'a.py');
    await h.db.prepare('DROP TABLE maintenance_actions').run();
    const r=await h.request('/api/admin/account/reset',{method:'POST',data:{currentPassword:'test-password-1234',confirmation:'RESET'}});
    assert.equal(r.status,200,JSON.stringify(r.value));
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM json_documents').first()).n,0);
    assert.equal((await h.db.prepare('SELECT version FROM storage_format').first()).version,13);
  }finally{await h.dispose();}
});
