// 目录规则只阻止新同步内容，旧元数据及完整增量仍可用于恢复。
import {test,before,after} from 'node:test';import assert from 'node:assert/strict';
import {createHarness,digest} from './harness.js';
import {directoryExcluded,settingsValue,DEFAULT_EXCLUDED_DIRECTORIES} from '../src/sync/settings.js';
let h,owner,device;
before(async()=>{h=await createHarness();owner=await h.createUser('排除目录测试');device=await h.bind(owner);});
after(async()=>h?.dispose());
const get=async()=>(await h.request('/api/sync/settings',{token:device.token})).value;
const update=async patch=>h.request('/api/admin/sync-settings',{method:'PUT',data:{...await get(),...patch}});
const commit=patch=>h.request('/api/sync/commit',{method:'POST',token:device.token,data:{opId:crypto.randomUUID(),patch}});
const directory=path=>commit({id:crypto.randomUUID(),kind:'directory',path,baseVersion:0});
test('迁移默认排除三个缓存名，兼容旧格式读取',async()=>{
  assert.deepEqual((await get()).excludedDirectories,['_cache','__pycache__','pycache']);
  assert.deepEqual(settingsValue({file_extensions:'["py"]',include_extensionless:1,revision:1}).excludedDirectories,DEFAULT_EXCLUDED_DIRECTORIES);
});
test('任意目录层级忽略大小写匹配，普通同名文件不受目录规则影响',()=>{
  const policy={excludedDirectories:DEFAULT_EXCLUDED_DIRECTORIES};
  for(const path of ['_cache/a.py','normal/__PYCACHE__/nested/a.py','a/pycache/file'])assert.equal(directoryExcluded(policy,path),true);
  for(const path of ['pycache','a/_cachex/a.py','a/pycache.py'])assert.equal(directoryExcluded(policy,path),false);
  assert.equal(directoryExcluded(policy,'a/PYCACHE','directory'),true);
});
test('新增排除目录与提前上传均被拒绝，无父目录时也返回策略错误',async()=>{
  assert.equal((await directory('_cache')).value.detail.code,'DIRECTORY_EXCLUDED');
  const hash=digest('cache');
  const upload=await h.request(`/api/sync/blobs/${hash}?path=__pycache__%2Fx.py`,{method:'PUT',token:device.token,raw:'cache'});assert.equal(upload.status,422);
  assert.equal(await h.db.prepare('SELECT hash FROM file_contents WHERE owner=? AND hash=?').bind(owner,hash).first(),null);
  await h.request(`/api/sync/blobs/${hash}`,{method:'PUT',token:device.token,raw:'cache'});
  const result=await commit({id:crypto.randomUUID(),kind:'file',path:'__pycache__/x.py',baseVersion:0,data:{hash,size:5}});assert.equal(result.status,422);assert.equal(result.value.detail.code,'DIRECTORY_EXCLUDED');
  assert.equal((await h.put(owner,'pycache')).result.status,200);
});
test('排除已有目录不删文件、不裁剪增量，旧操作仍可执行，取消排除可继续更新',async()=>{
  await update({excludedDirectories:[]});const dir=(await directory('cache')).value.items[0];const {patch}=await h.put(owner,'cache/a.py','old');
  const before=(await get()).revision;await update({excludedDirectories:['cache']});assert.ok((await get()).revision>before);
  assert.equal((await h.request(`/api/sync/files/${patch.id}`,{token:device.token})).value,'old');
  assert.ok((await h.request('/api/sync/changes?cursor=0',{token:device.token})).value.changes.some(item=>item.id===patch.id));
  assert.equal((await commit({...patch,baseVersion:1,path:'cache/b.py',enabled:false})).status,200);
  const hash=digest('new');await h.request(`/api/sync/blobs/${hash}`,{method:'PUT',token:device.token,raw:'new'});
  assert.equal((await commit({...patch,baseVersion:2,path:'cache/b.py',data:{hash,size:3}})).status,422);
  await update({excludedDirectories:[]});assert.equal((await commit({...patch,baseVersion:2,path:'cache/b.py',data:{hash,size:3}})).status,200);
  assert.equal((await commit({...dir,baseVersion:1,deleted:true})).status,200);
});
test('保存正规化目录名，旧管理端省略字段不清空既有排除规则',async()=>{
  const result=await update({excludedDirectories:['_CACHE','pycache','_cache','.cache']});assert.deepEqual(result.value.excludedDirectories,['_cache','pycache','.cache']);
  const input=await get();delete input.excludedDirectories;input.includeExtensionless=false;
  const saved=await h.request('/api/admin/sync-settings',{method:'PUT',data:input});assert.deepEqual(saved.value.excludedDirectories,['_cache','pycache','.cache']);
  assert.equal((await update({excludedDirectories:['a/b']})).status,400);
});
