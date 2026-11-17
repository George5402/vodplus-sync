// 策略更新不裁剪增量，不删除历史文件；元数据操作继续兼容。
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,digest} from './harness.js';
import {fileExtension} from '../src/sync/settings.js';
let h,owner,device;
before(async()=>{h=await createHarness();owner=await h.createUser('策略人物');device=await h.bind(owner,'策略人物');});
after(async()=>h?.dispose());
const settings=async()=>(await h.request('/api/sync/settings',{token:device.token})).value;
const update=async(values)=>h.request('/api/admin/sync-settings',{method:'PUT',data:{...await settings(),...values}});
test('设备读取准确的全局默认策略，匿名不能读取或修改',async()=>{
  assert.deepEqual(await settings(),{fileExtensions:['py','js','txt','json','m3u8','jar','php','html'],includeExtensionless:true,excludedDirectories:['_cache','__pycache__','pycache'],revision:1});
  assert.equal((await h.put(owner,'page.HTML')).result.status,200);
  assert.equal((await h.request('/api/sync/settings',{admin:false})).status,401);
  assert.equal((await h.request('/api/admin/sync-settings',{admin:false,token:device.token})).status,401);
});
test('后缀按最后一个点且忽略大小写，单点隐藏文件属于无后缀',()=>{
  for(const [name,ext] of [['a.PY','py'],['dir/foo.tar.GZ','gz'],['data',''],['.hide',''],['.hide.JSON','json'],['dir.with.dot/file','']])assert.equal(fileExtension(name),ext);
});
test('规则正规化与版本持久化，过时设置不能覆盖新设置',async()=>{
  const original=await settings();const result=await update({fileExtensions:['.PY',' TXT ','py'],includeExtensionless:false});
  assert.deepEqual(result.value,{fileExtensions:['py','txt'],includeExtensionless:false,excludedDirectories:['_cache','__pycache__','pycache'],revision:original.revision+1});
  assert.equal((await h.request('/api/admin/sync-settings',{method:'PUT',data:original})).status,409);
  assert.deepEqual(await settings(),result.value);
});
test('带 path 的上传提前拒绝，旧上传协议仍在新内容提交时强制校验',async()=>{
  const hash=digest('not-a-file-type');const raw='not-a-file-type';
  assert.equal((await h.request(`/api/sync/blobs/${hash}?path=a.exe`,{method:'PUT',token:device.token,raw})).status,422);
  assert.equal((await h.request(`/api/sync/blobs/${hash}`,{method:'PUT',token:device.token,raw})).status,200);
  const result=await h.request('/api/sync/commit',{method:'POST',token:device.token,data:{opId:crypto.randomUUID(),patch:{id:crypto.randomUUID(),kind:'file',path:'a.exe',baseVersion:0,data:{hash,size:raw.length}}}});
  assert.equal(result.status,422);assert.equal(result.value.detail.code,'FILE_TYPE_NOT_ALLOWED');
});
test('目录与无后缀策略独立；公共发布库不受人物同步规则限制',async()=>{
  const directory=await h.request(`/api/admin/spaces/${owner}/commit`,{method:'POST',data:{opId:crypto.randomUUID(),patch:{id:crypto.randomUUID(),kind:'directory',path:'资源',baseVersion:0}}});assert.equal(directory.status,200);
  assert.equal((await h.put(owner,'资源/.hide')).result.status,422);await update({includeExtensionless:true});assert.equal((await h.put(owner,'资源/.hide')).result.status,200);
  assert.equal((await h.put('public','cover.png')).result.status,200);
});
test('排除已有类型后不删旧文件，不过滤变更，可移动停用删除和历史读取',async()=>{
  const {patch}=await h.put(owner,'keep.py','old');await update({fileExtensions:['txt']});
  const commit=async p=>h.request('/api/sync/commit',{method:'POST',token:device.token,data:{opId:crypto.randomUUID(),patch:p}});
  assert.equal((await commit({...patch,baseVersion:1,path:'moved.py',enabled:false})).status,200);
  const hash=digest('changed');await h.request(`/api/sync/blobs/${hash}`,{method:'PUT',token:device.token,raw:'changed'});
  assert.equal((await commit({...patch,path:'moved.py',baseVersion:2,data:{hash,size:7}})).status,422);
  const feed=(await h.request('/api/sync/changes?cursor=0',{token:device.token})).value;assert.ok(feed.changes.some(c=>c.id===patch.id));
  assert.equal((await h.request(`/api/sync/files/${patch.id}?version=1`,{token:device.token})).value,'old');
  assert.equal((await commit({...patch,path:'moved.py',baseVersion:2,deleted:true})).status,200);
});
