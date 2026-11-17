// 可运行的同步传输参考；宿主实现持久化队列、临时文件及原子应用适配器。
import { relativePath } from '../src/lib/http.js';
const sha256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
export async function recordId(kind,key) { return `${kind}_${await sha256(new TextEncoder().encode(key))}`; }
export class SyncClient {
  constructor({server,userId,deviceId,token,storage,fetcher=fetch}) {
    const url=new URL(server);if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('同步服务器必须使用 HTTPS');
    // 实例绑定人物，不提供改 userId 的方法。切换用户创建另一实例与独立队列。
    this.identity=Object.freeze({server:url.origin,userId,deviceId,token});this.storage=storage;this.fetcher=fetcher;this.running=null;
  }
  async request(path,options={}) {
    const response=await this.fetcher(this.identity.server+path,{...options,headers:{authorization:`Bearer ${this.identity.token}`,...options.headers}});
    if(!response.ok){const body=await response.json().catch(()=>({}));const error=new Error(body.error||`HTTP ${response.status}`);error.status=response.status;error.detail=body.detail;throw error;}return response;
  }
  post(path,data){return this.request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});}
  async enqueue(patch,bytes) {
    if(patch.path)relativePath(patch.path);
    if(bytes){if(bytes.byteLength>1572864)throw new Error('文件超过 1.5 MiB');patch={...patch,data:{hash:await sha256(bytes),size:bytes.byteLength}};}
    const item={owner:this.identity.userId,opId:crypto.randomUUID(),patch,bytes};
    await this.storage.enqueue(item);return item.opId;
  }
  sync(){if(!this.running)this.running=this.perform().finally(()=>this.running=null);return this.running;}
  async perform(){
    const owner=this.identity.userId;
    for(const item of await this.storage.pending(owner)){
      if(item.owner!==owner)throw new Error('队列人物不匹配');
      try{
        if(item.bytes)await this.request(`/api/sync/blobs/${item.patch.data.hash}?path=${encodeURIComponent(item.patch.path)}`,{method:'PUT',body:item.bytes});
        const result=await (await this.post('/api/sync/commit',{opId:item.opId,patch:item.patch})).json();
        await this.storage.committed(owner,item.opId,result.items);
      }catch(error){
        if(error.status===409){await this.storage.conflict(owner,item,error.detail);continue;}
        await this.storage.log(owner,{action:'上传失败',error:error.message});throw error;
      }
    }
    let cursor=await this.storage.cursor(owner);let until;const latest=new Map();
    // 收完本轮上界以内的所有页，再成组应用，目录移动不会在分页边界露出半完成状态。
    while(true){
      const page=await (await this.request(`/api/sync/changes?cursor=${cursor}${until===undefined?'':`&until=${until}`}`)).json();
      until=page.until;for(const change of page.changes)latest.set(change.id,change);cursor=page.cursor;if(!page.hasMore)break;
    }
    const staged=[];
    for(const change of latest.values()){
      if(change.path)relativePath(change.path);
      let bytes;
      if(change.kind==='file'&&!change.deleted){
        bytes=new Uint8Array(await (await this.request(`/api/sync/files/${change.id}?version=${change.version}`)).arrayBuffer());
        if(bytes.length!==change.data.size||await sha256(bytes)!==change.data.hash)throw new Error('下载校验失败，原文件保留');
      }
      staged.push({change,bytes});
    }
    // 宿主必须先暂存文件，再原子写入元数据和游标；有本地待办的实体保留冲突副本。
    await this.storage.applyRemote(owner,staged,cursor,{origin:'remote',suppressWatcher:true});
    await this.post('/api/sync/ack',{cursor,ok:true});
    await this.storage.log(owner,{action:'同步成功',count:staged.length,time:Date.now()});return {cursor,count:staged.length};
  }
}
