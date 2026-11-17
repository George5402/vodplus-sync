// 上传重名规则：默认避让；同批次重名始终避让，覆盖仅针对已有文件。
function alternative(path,used){
  const slash=path.lastIndexOf('/');const parent=slash<0?'':path.slice(0,slash+1);const name=path.slice(slash+1);const dot=name.lastIndexOf('.');
  const stem=dot>0?name.slice(0,dot):name;const ext=dot>0?name.slice(dot):'';
  for(let i=1;;i++){const result=`${parent}${stem} (${i})${ext}`;if(!used.has(result.toLowerCase()))return result;}
}
export function planUploads(files,rows,directory,mode){
  const existing=new Map(rows.filter(r=>!r.deleted&&r.path).map(r=>[r.path.toLowerCase(),r]));
  const used=new Set(existing.keys());const reserved=new Set();
  return files.map(file=>{
    let path=(directory?directory+'/':'')+file.name;let row=existing.get(path.toLowerCase());
    if(reserved.has(path.toLowerCase())||row?.kind==='directory'||(row&&mode!=='overwrite')){path=alternative(path,used);row=undefined;}
    else if(row)path=row.path;
    used.add(path.toLowerCase());reserved.add(path.toLowerCase());
    return {file,path,existing:row||null,renamed:path.split('/').pop()!==file.name};
  });
}
