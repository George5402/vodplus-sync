// 模拟 Cloudflare 资源状态，验证首次部署、失败重试和迁移顺序；不访问真实账户。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployProject } from '../scripts/deploy.mjs';
import { provisionDatabase } from '../scripts/deploy/database.mjs';

const config = { name:'vodplus-sync', main:'src/worker.js', assets:{directory:'./web'}, d1_databases:[{binding:'DB',database_name:'vodplus-sync',migrations_dir:'migrations'}] };
const existing = {uuid:'8c648588-9402-4e37-88f8-e11b75c072d1',name:'vodplus-sync'};
async function withProject(value, action) {
  const root = await mkdtemp(join(tmpdir(),'vodplus-deploy-'));
  const path = join(root,'wrangler.jsonc');
  await writeFile(path,'// 测试项目\n'+JSON.stringify(value));
  try { await action(root); } finally { await unlink(path); await rmdir(root); }
}
test('新账户先创建 D1，迁移和部署使用同一真实 ID，临时配置清理',async()=>{
  await withProject({...config,r2_buckets:[{binding:'BUCKET',bucket_name:'legacy'}]},async root=>{
    let rows=[];const calls=[];let temporary;
    await deployProject({root,log:()=>{},runner:async(args,options)=>{
      calls.push(args.join(' '));temporary=options.configPath;
      if(args[1]==='list')return JSON.stringify(rows);
      if(args[1]==='create'){rows=[existing];return '';}
      const resolved=JSON.parse(await readFile(temporary,'utf8'));
      assert.equal(resolved.d1_databases[0].database_id,existing.uuid);
      assert.equal(resolved.r2_buckets,undefined);assert.equal(resolved.assets.directory,'./web');
      return '';
    }});
    assert.deepEqual(calls,['d1 list --json','d1 create vodplus-sync --update-config=false','d1 list --json','d1 migrations apply DB --remote','deploy']);
    await assert.rejects(()=>stat(temporary),{code:'ENOENT'});
    assert.ok((await readFile(join(root,'wrangler.jsonc'),'utf8')).includes('legacy'));
  });
});
test('已有 D1 的失败部署可重试，不重复建库，也不创建 R2',async()=>{
  const calls=[];
  await withProject(config,root=>deployProject({root,log:()=>{},runner:async args=>{calls.push(args.join(' '));return args[1]==='list'?JSON.stringify([existing]):'';}}));
  assert.deepEqual(calls,['d1 list --json','d1 migrations apply DB --remote','deploy']);
});
test('迁移失败时不发布，仍清理临时配置',async()=>{
  await withProject(config,async root=>{
    let temporary;let published=false;
    await assert.rejects(()=>deployProject({root,log:()=>{},runner:async(args,options)=>{
      temporary=options.configPath;
      if(args[1]==='list')return JSON.stringify([existing]);
      if(args[1]==='migrations')throw new Error('migration failed');published=true;
    }}),/migration failed/);
    assert.equal(published,false);await assert.rejects(()=>stat(temporary),{code:'ENOENT'});
  });
});
test('列表权限错误或绑定 ID 不存在时不创建替代数据库',async()=>{
  const calls=[];
  await assert.rejects(()=>provisionDatabase(config,async args=>{calls.push(args);throw new Error('denied');},()=>{}),/denied/);
  assert.equal(calls.length,1);
  const pinned=structuredClone(config);pinned.d1_databases[0].database_id='another-id';
  await assert.rejects(()=>provisionDatabase(pinned,async()=>JSON.stringify([existing]),()=>{}),/不会创建替代/);
});
test('数据库被并发创建后重新查询并复用',async()=>{
  let listCount=0;
  const result=await provisionDatabase(config,async args=>{
    if(args[1]==='list')return JSON.stringify(++listCount===1?[]:[existing]);
    throw new Error('already exists');
  },()=>{});
  assert.equal(result.d1_databases[0].database_id,existing.uuid);
});
test('尊重部署页面选择的数据库 ID，而不是默认名称',async()=>{
  const selected={uuid:'selected-id',name:'custom-database'};const input=structuredClone(config);input.d1_databases[0].database_id=selected.uuid;
  const result=await provisionDatabase(input,async()=>JSON.stringify([existing,selected]),()=>{});
  assert.equal(result.d1_databases[0].database_name,'custom-database');
});
