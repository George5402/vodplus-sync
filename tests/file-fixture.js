// 批量生成隔离测试清单，正文去重为一个 BLOB，避免性能测试耗时于逐个网络上传。
import {digest} from './harness.js';
import {Catalog,readCatalog} from '../src/storage/catalog.js';
import {putContent} from '../src/storage/content.js';
import {primaryDocument,documentCondition} from '../src/storage/documents.js';
export async function seedFiles(db,owner,count){
  const env={DB:db},content=Buffer.from('fixture'),hash=digest(content);await putContent(env,owner,hash,content);
  const document=await readCatalog(env,owner),model=new Catalog(document.value),source='fixture';
  model.set({id:'00000001',kind:'directory',path:'files',version:1,data:{},deleted:0,enabled:1,source,updated:1});
  for(let i=0;i<count;i++)model.set({id:String(i+2).padStart(8,'0'),kind:'file',path:`files/file-${String(i).padStart(4,'0')}.py`,version:1,data:{hash,size:content.length},deleted:0,enabled:1,source,updated:1});
  const condition=documentCondition([document]),primary=primaryDocument(env,document,model.value,condition.sql,condition.values,{count:count+1});
  await db.batch(primary.statements);
  await db.prepare("INSERT INTO sync_heads(owner,state) VALUES(?,json_object('files',1,'data',json('{}'))) ON CONFLICT(owner) DO UPDATE SET state=json_set(state,'$.files',1)").bind(owner).run();
  return {hash,content,model};
}
