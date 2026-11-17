// 文件请求共用入口，上传字节与版本提交分离。
import {api,send} from '../ui.js';
export const hashBytes=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
export async function putFile(base,bytes,path,signal){
  const hash=await hashBytes(bytes);
  await api(`${base}/blobs/${hash}?path=${encodeURIComponent(path)}`,{method:'PUT',body:bytes,signal});
  return {hash,size:bytes.byteLength};
}
export const saveFile=(base,row,patch={})=>send(`${base}/commit`,{opId:crypto.randomUUID(),restore:!!row.deleted,patch:{...row,baseVersion:row.version,...patch}});
