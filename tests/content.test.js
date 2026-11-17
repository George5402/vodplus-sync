// 单行 BLOB 验证：完整二进制、Unicode、空文件、去重和空间隔离。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createHarness, digest } from './harness.js';
let h,owner,device;
before(async()=>{h=await createHarness();owner=await h.createUser('D1文件测试');device=await h.bind(owner,'D1文件测试');});
after(async()=>h?.dispose());
async function roundtrip(bytes,path){
  const hash=digest(bytes);const fileId=crypto.randomUUID();
  const upload=await h.request(`/api/sync/blobs/${hash}`,{method:'PUT',token:device.token,raw:bytes});assert.equal(upload.status,200);
  const result=await h.request('/api/sync/commit',{method:'POST',token:device.token,data:{opId:crypto.randomUUID(),patch:{id:fileId,kind:'file',path,baseVersion:0,data:{hash,size:bytes.length}}}});assert.equal(result.status,200);
  const response=await h.mf.dispatchFetch(`http://localhost/api/sync/files/${fileId}`,{headers:{authorization:`Bearer ${device.token}`}});
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  return {hash,fileId};
}
test('完整上传并下载 1.5 MiB 随机二进制，正文只占一行 BLOB',async()=>{
  const {hash}=await roundtrip(randomBytes(1572864),'binary.jar');
  const result=await h.db.prepare('SELECT COUNT(*) parts,MAX(length(content)) largest,typeof(content) type FROM file_contents WHERE owner=? AND hash=?').bind(owner,hash).first();
  assert.equal(result.parts,1);assert.equal(result.largest,1572864);assert.equal(result.type,'blob');
  assert.equal(await h.db.prepare("SELECT name FROM sqlite_master WHERE name='file_chunks'").first(),null);
});
test('中文 UTF-8 与空文件保持逐字节一致',async()=>{
  await roundtrip(Buffer.from('中文配置与爬虫🧩\n'.repeat(15000)),'unicode.txt');await roundtrip(Buffer.alloc(0),'empty.txt');
});
test('重复上传只存一份，同摘要不能借用另一人物的内容',async()=>{
  const bytes=Buffer.from('repeated-content');const {hash}=await roundtrip(bytes,'original.txt');
  for(let n=0;n<2;n++)assert.equal((await h.request(`/api/sync/blobs/${hash}`,{method:'PUT',token:device.token,raw:bytes})).status,200);
  assert.equal((await h.db.prepare('SELECT COUNT(*) count FROM file_contents WHERE owner=? AND hash=?').bind(owner,hash).first()).count,1);
  const other=await h.createUser('另一个人物');const binding=await h.bind(other,'另一个人物');
  const result=await h.request('/api/sync/commit',{method:'POST',token:binding.token,data:{opId:crypto.randomUUID(),patch:{id:crypto.randomUUID(),kind:'file',path:'other.txt',baseVersion:0,data:{hash,size:bytes.length}}}});assert.equal(result.status,400);
});
