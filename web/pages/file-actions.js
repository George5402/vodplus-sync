// 文件行操作集中处理，桌面按钮与小屏菜单共用相同逻辑。
import {send,form,confirm,toast} from '../ui.js';
import {saveFile} from '../lib/files-api.js';
import {showVersions} from './revisions.js';
export function actionsFor(row,owner){
  if(row.deleted)return [['edit','查看'],['restore','恢复'],['versions','历史版本']];
  return [['edit',row.kind==='directory'?'目录信息':'编辑'],...(row.path?[['rename','重命名 / 移动']]:[]),['toggle',row.enabled?'停用':'启用'],['versions','历史版本'],...(row.kind==='file'?[['download','下载']]:[]),...(owner==='public'&&row.kind==='file'?[['copy','复制给用户']]:[]),['delete','删除']];
}
export async function fileAction(action,{row,base,users,refresh,edit}){
  if(action==='edit')return edit(row);
  if(action==='versions')return showVersions(base,row,refresh);
  if(action==='rename'){
    const result=await form('重命名 / 移动',[{name:'path',label:'相对路径',value:row.path,hint:'目录移动会同时更新子项，目标父目录需已存在。'}],'保存',{submit:input=>saveFile(base,row,{path:input.path})});
    if(result)await refresh();return;
  }
  if(action==='copy'){
    if(!users.length)throw new Error('请先创建用户');
    const result=await form('复制给用户',[{name:'owner',label:'目标用户',type:'select',options:users.map(u=>({value:u.id,label:u.name}))},{name:'path',label:'目标路径',value:row.path.split('/').pop()}],'复制',{submit:input=>send('/api/admin/copy',{...input,fileId:row.id,sourceVersion:row.version,id:crypto.randomUUID(),opId:crypto.randomUUID()})});
    if(result)toast('已复制到用户空间');return;
  }
  if(action==='toggle')await saveFile(base,row,{enabled:!row.enabled});
  if(action==='delete'||action==='restore'){
    if(!await confirm(action==='delete'?'移入回收站':'恢复文件',action==='delete'?'目录下的内容会一并移入回收站，历史版本会保留。':'恢复会生成新版本；已删除的父目录需要先恢复。'))return;
    await saveFile(base,row,{deleted:action==='delete'});
  }
  await refresh();
}
