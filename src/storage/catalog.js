// 每个空间一份目录 JSON，稳定数字 ID 与父目录关系独立于路径及显示顺序。
import {assert,relativePath} from '../lib/http.js';
import {readDocument} from './documents.js';
export const catalogKey=owner=>`catalog:${owner}`;
export const emptyCatalog=()=>({nextId:1,items:{}});
export const readCatalog=(env,owner)=>readDocument(env,catalogKey(owner),emptyCatalog);
export const apiId=item=>item.key||String(item.id).padStart(8,'0');
export class Catalog {
  constructor(value){this.value=value;this.paths=new Map();}
  items(){return Object.values(this.value.items);}
  path(item){
    if(this.paths.has(item.id))return this.paths.get(item.id);
    const chain=new Set();let current=item;const names=[];
    while(current){assert(!chain.has(current.id),500,'目录关系循环');chain.add(current.id);names.unshift(current.name);const parent=current.parent?this.value.items[current.parent]:null;assert(!current.parent||parent?.kind==='directory',500,'目录引用不存在');current=parent;}
    const path=names.join('/');this.paths.set(item.id,path);return path;
  }
  byId(key){return this.items().find(item=>apiId(item)===String(key));}
  byPath(path,deleted=false){return this.items().find(item=>!!item.deleted===deleted&&this.path(item).toLowerCase()===path.toLowerCase());}
  row(item){return {id:apiId(item),kind:item.kind,path:this.path(item),version:item.version,data:item.kind==='file'?{hash:item.hash,size:item.size}:{},deleted:item.deleted,enabled:item.enabled,source:item.source,updated:item.updated};}
  rows(){return this.items().map(item=>this.row(item));}
  set(row){
    const path=relativePath(row.path);let item=this.byId(row.id);
    if(!item){const id=this.value.nextId++;assert(Number.isSafeInteger(id),413,'文件编号超出范围');item={id,key:row.id};this.value.items[id]=item;}
    const split=path.lastIndexOf('/'),parentPath=split<0?'':path.slice(0,split);
    const parent=parentPath?(this.byPath(parentPath)||((row.deleted||item.deleted)&&this.byPath(parentPath,true))):null;
    assert(!parentPath||parent?.kind==='directory',409,'父目录不存在');
    assert(!parent||this.path(parent)===parentPath,409,'父目录大小写与现有目录不一致');
    Object.assign(item,{parent:parent?.id??0,name:path.slice(split+1),kind:row.kind,version:row.version,deleted:row.deleted?1:0,enabled:row.enabled?1:0,source:row.source,updated:row.updated});
    if(row.kind==='file')Object.assign(item,{hash:row.data.hash,tag:row.data.hash.slice(0,32),size:row.data.size});
    this.paths.clear();return item;
  }
}
export async function fileRows(env,owner){return new Catalog((await readCatalog(env,owner)).value).rows();}
export async function fileRow(env,owner,key){const model=new Catalog((await readCatalog(env,owner)).value);const item=model.byId(key);return item?model.row(item):null;}
