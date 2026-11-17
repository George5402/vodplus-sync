// 使用真实 workerd 和 D1 SQLite，不配置 R2，验证纯 D1 部署也能完整运行。
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FILE_ICON_ASSETS } from '../web/lib/file-types.js';
import {MIGRATION_NAMES,statements} from '../src/schema/plan.js';
import {Catalog,readCatalog,fileRows} from '../src/storage/catalog.js';
import {fileDeviceState} from '../src/storage/file-sync.js';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export async function createHarness({assets=false,setup=true,migrations=MIGRATION_NAMES.length}={}){
  const bundle=await build({entryPoints:['src/worker.js'],bundle:true,write:false,format:'esm',platform:'browser',loader:{'.sql':'text'}});
  const staticFiles=new Map();
  if(assets){
    const files=['index.html','styles.css','app.js','ui.js','icons.js','share.html','share.js','deploy.html','deploy.js','lib/binding-links.js','lib/files-api.js','lib/upload-plan.js','pages/binding.js','pages/sync-settings.js','pages/overview.js','pages/shares.js','pages/people.js','pages/device-config.js','pages/files.js','pages/file-editor.js','pages/file-actions.js','pages/uploads.js','pages/revisions.js'];
    files.push('lib/file-types.js','lib/file-list.js','pages/account.js','pages/service-reset.js',...FILE_ICON_ASSETS);
    for(const file of files)staticFiles.set('/'+file,await readFile(new URL('../web/'+file,import.meta.url)));
  }
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',d1Databases:['DB'],serviceBindings:{ASSETS:request=>{
    const path=new URL(request.url).pathname;const file=path==='/'?'/index.html':path;
    return staticFiles.has(file)?new Response(staticFiles.get(file),{headers:{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8'}}):new Response('Not found',{status:404});
  }}});
  try{
  const db=await mf.getD1Database('DB');
  for(const name of MIGRATION_NAMES.slice(0,migrations)){
    const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
    for(const statement of statements(sql))await db.prepare(statement).run();
  }
  if(migrations>0){
    await db.prepare('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)').run();
    await db.batch(MIGRATION_NAMES.slice(0,migrations).map(name=>db.prepare('INSERT OR IGNORE INTO d1_migrations(name) VALUES(?)').bind(name)));
  }
  let cookie='';
  const request=async(path,{method='GET',data,token,admin=true,raw,headers={}}={})=>{
    const response=await mf.dispatchFetch('http://localhost'+path,{method,headers:{...(admin&&cookie?{cookie}:{}),...(token?{authorization:`Bearer ${token}`} : {}),...(data?{'content-type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):raw});
    const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
    return {status:response.status,value,headers:response.headers};
  };
  if(setup){
    const response=await request('/api/setup',{method:'POST',data:{username:'admin',password:'test-password-1234'}});
    if(response.status!==200)throw new Error(JSON.stringify(response.value));cookie=response.headers.get('set-cookie').split(';')[0];
  }
  const createUser=async name=>(await request('/api/admin/users',{method:'POST',data:{name}})).value.id;
  const bind=async userId=>{const code=(await request(`/api/admin/users/${userId}/binding`,{method:'POST',data:{}})).value.code;return (await request('/api/bind',{method:'POST',admin:false,data:{code,deviceName:'测试设备'}})).value;};
  const put=async(owner,path,text='print("hello")',extra={})=>{
    const hash=digest(text);await request(`/api/admin/spaces/${owner}/blobs/${hash}`,{method:'PUT',raw:text});
    const patch={id:crypto.randomUUID(),kind:'file',path,baseVersion:0,data:{hash,size:Buffer.byteLength(text)},...extra};
    return {patch,result:await request(`/api/admin/spaces/${owner}/commit`,{method:'POST',data:{opId:crypto.randomUUID(),patch}})};
  };
  const file=async(owner,path)=>{const model=new Catalog((await readCatalog({DB:db},owner)).value);const item=model.byPath(path)||model.byPath(path,true);return item?model.row(item):null;};
  return {mf,db,request,createUser,bind,put,file,lookupFile:file,files:owner=>fileRows({DB:db},owner),fileState:async device=>(await fileDeviceState({DB:db},device)).value,dispose:()=>mf.dispose()};
  }catch(error){await mf.dispose();throw error;}
}
