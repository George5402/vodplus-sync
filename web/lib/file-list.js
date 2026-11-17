// 按层级排序并计算目录可见性；搜索临时展示匹配项和祖先，不改变展开状态。
import {extensionOf} from './file-types.js';
const collator=new Intl.Collator('zh-CN',{numeric:true,sensitivity:'base'});
const title=row=>row.path?.split('/').pop()||row.data?.title||row.data?.key||row.id;
export function compareRows(sort='name'){
  return (a,b)=>{
    const directories=Number(b.kind==='directory')-Number(a.kind==='directory');if(directories)return directories;
    let result=0;
    if(sort==='updated')result=(b.updated||0)-(a.updated||0);
    if(sort==='size')result=(b.data?.size||0)-(a.data?.size||0);
    if(sort==='type')result=collator.compare(extensionOf(a.path),extensionOf(b.path));
    return result||collator.compare(title(a),title(b))*(sort==='name-desc'?-1:1)||String(a.id).localeCompare(String(b.id));
  };
}
export function fileList(rows,{expanded=new Set(),query='',sort='name',deleted=false}={}){
  const selected=rows.filter(row=>row.path&&!!row.deleted===deleted);
  const directories=new Map(selected.filter(row=>row.kind==='directory').map(row=>[row.path,row]));
  const children=new Map();const parents=new Map();
  for(const row of selected){
    let path=row.path.slice(0,row.path.lastIndexOf('/')<0?0:row.path.lastIndexOf('/'));
    // 回收站可能只含子项，挂到最近仍可见的祖先，避免成为不可见孤儿。
    while(path&&!directories.has(path)){const slash=path.lastIndexOf('/');path=slash<0?'':path.slice(0,slash);}
    const parent=directories.get(path)?.id||null;parents.set(row.id,parent);
    if(!children.has(parent))children.set(parent,[]);children.get(parent).push(row);
  }
  for(const siblings of children.values())siblings.sort(compareRows(sort));
  const search=query.trim().toLowerCase();const matches=selected.filter(row=>!search||row.path.toLowerCase().includes(search));const keep=new Set(matches.map(row=>row.id));
  if(search)for(const row of matches){let parent=parents.get(row.id);while(parent){keep.add(parent);parent=parents.get(parent);}}
  const entries=[];
  function walk(parent,depth){for(const row of children.get(parent)||[]){
    if(search&&!keep.has(row.id))continue;
    const open=row.kind==='directory'&&(!!search||expanded.has(row.id));entries.push({row,depth,expanded:open});
    if(open)walk(row.id,depth+1);
  }}
  walk(null,0);
  return {entries,total:selected.length,matches:matches.length,directories:[...directories.values()]};
}
