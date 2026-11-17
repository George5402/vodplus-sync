// 每份不可变文件内容使用一行原始 BLOB，按空间和校验值去重。
import {one,stmt} from '../lib/db.js';
import {assert} from '../lib/http.js';
export const contentInfo=(env,owner,hash)=>one(env,'SELECT id,size FROM file_contents WHERE owner=? AND hash=?',owner,hash);
export async function putContent(env,owner,hash,input){
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input);assert(bytes.length<=1572864,413,'文件超过 1.5 MiB');
  const existing=await contentInfo(env,owner,hash);if(existing){assert(existing.size===bytes.length,409,'已有内容大小不一致');return existing;}
  await stmt(env,'INSERT OR IGNORE INTO file_contents(owner,hash,size,content,created) VALUES(?,?,?,?,?)',owner,hash,bytes.length,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),Date.now()).run();
  return contentInfo(env,owner,hash);
}
export async function getContent(env,owner,hash){
  const row=await one(env,'SELECT id,size,content FROM file_contents WHERE owner=? AND hash=?',owner,hash);if(!row)return null;
  const body=new Uint8Array(row.content);assert(body.length===row.size,500,'文件内容不完整');
  return {id:row.id,size:row.size,body,text:async()=>new TextDecoder().decode(body)};
}
export async function getContentById(env,owner,id){
  const row=await one(env,'SELECT size,content FROM file_contents WHERE owner=? AND id=?',owner,id);if(!row)return null;
  const body=new Uint8Array(row.content);assert(body.length===row.size,500,'文件内容不完整');return {size:row.size,body};
}
export async function copyContent(env,source,target,hash){
  assert(await contentInfo(env,source,hash),404,'源文件内容不存在');
  await stmt(env,'INSERT OR IGNORE INTO file_contents(owner,hash,size,content,created) SELECT ?,hash,size,content,? FROM file_contents WHERE owner=? AND hash=?',target,Date.now(),source,hash).run();
}
