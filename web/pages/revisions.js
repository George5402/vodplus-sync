// 版本回滚和冲突解决始终显式生成新版本，不绕过并发检查。
import { api, send, form, confirm, toast, esc } from '../ui.js';
export async function showVersions(base,row,refresh){
  const versions=(await api(`${base}/versions/${row.id}`)).items;
  const input=await form('历史版本',[{name:'version',label:'选择版本',type:'select',options:versions.map(v=>({value:v.version,label:`v${v.version} · ${new Date(v.updated).toLocaleString()} · ${v.deleted?'删除':v.path||v.kind}`}))},{html:'<p>保留最近 20 版。恢复生成一个新版本，当前内容仍可在历史中找到。目录回滚仅处理目录本身及当前存活的子项。</p>'}],'恢复为新版本');
  if(!input)return;const chosen=versions.find(v=>v.version===Number(input.version));
  await send(`${base}/commit`,{opId:crypto.randomUUID(),restore:true,patch:{...chosen,baseVersion:row.version}});await refresh();toast('已生成恢复版本');
}
export async function showConflicts(base,rows,refresh){
  const conflicts=(await api(`${base}/conflicts`)).items;
  if(!conflicts.length){toast('当前空间没有待处理冲突');return;}
  const input=await form('处理冲突候选',[{name:'id',label:'冲突内容',type:'select',options:conflicts.map(c=>({value:c.id,label:`${c.proposed.patch.path||c.proposed.patch.kind} · 基于 v${c.proposed.patch.baseVersion}`}))},{name:'action',label:'处理方式',type:'select',options:[{value:'keep',label:'保留当前版本，关闭候选'},{value:'apply',label:'采用候选，生成新版本'}]},{html:'<p>候选内容已在云端保留。采用前会显示候选元数据及文本；如期间又有更新，服务端会再次提示冲突。</p>'}],'下一步');
  if(!input)return;const selected=conflicts.find(c=>c.id===input.id);const patch=selected.proposed.patch;
  if(input.action==='apply'){
    let preview=JSON.stringify(patch,null,2);
    if(patch.kind==='file'){const r=await api(`${base}/conflict-file/${selected.id}`);preview=await r.text();}
    const reviewed=await form('确认候选内容',[{html:`<p>采用后会替换当前版本，旧内容仍保留在历史版本中。下方显示前 12000 字符。</p><textarea readonly rows="12" aria-label="候选预览">${esc(preview.slice(0,12000))}</textarea>${patch.kind==='file'?`<a href="${base}/conflict-file/${selected.id}" download="conflict-candidate.txt">下载完整候选内容</a>`:''}`}], '采用候选');
    if(!reviewed)return;
    await send(`${base}/commit`,{...selected.proposed,opId:crypto.randomUUID(),restore:true,patch:{...patch,baseVersion:rows.find(r=>r.id===patch.id)?.version||0}});
  }
  await send(`${base}/resolve/${selected.id}`);await refresh();toast('冲突已处理');
}
