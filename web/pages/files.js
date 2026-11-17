// 文件列表保留目录层级；行内操作、窄屏菜单和拖放上传共用接口。
import {$,api,send,esc,time,badge,on,form,toast,ownerOptions,empty,onPageLeave} from '../ui.js';
import {icon} from '../icons.js';
import {fileType} from '../lib/file-types.js';
import {fileList,compareRows} from '../lib/file-list.js';
import {openEditor} from './file-editor.js';
import {actionsFor,fileAction} from './file-actions.js';
import {putFile} from '../lib/files-api.js';
import {showUploads} from './uploads.js';
import {showSyncSettings} from './sync-settings.js';
import {showConflicts} from './revisions.js';

export async function filesPage({data}){
  const owners=ownerOptions(data.users);const requested=new URLSearchParams(location.hash.split('?')[1]).get('owner');
  let owner=owners.some(o=>o.value===requested)?requested:(data.users[0]?.id||'public');let rows=[],view='files',deleted=false,filter='',sort='name',refreshSequence=0,disposed=false;const expandedByOwner=new Map();
  const expanded=()=>{if(!expandedByOwner.has(owner))expandedByOwner.set(owner,new Set());return expandedByOwner.get(owner);};
  const typeIcon=(row,open=false)=>{const type=fileType(row,open);return `<img class="file-type-icon" src="${type.src}" alt="" title="${type.label}" aria-hidden="true">`;};
  $('#page').innerHTML=`<div class="page-heading"><div><div class="eyebrow">LIBRARY</div><h1>爬虫与本地资源</h1><p>点击文件名编辑，拖入文件可批量上传。</p></div><select id="owner" aria-label="选择空间">${owners.map(o=>`<option value="${o.value}" ${o.value===owner?'selected':''}>${esc(o.label)}</option>`).join('')}</select></div><div class="library-tabs"><button id="files-tab" class="active">文件资源</button><button id="records-tab">用户记录</button><button id="conflicts">冲突候选</button><button id="sync-settings">同步规则</button><label class="check"><input id="trash" type="checkbox">回收站</label></div><section class="panel resource-panel"><div class="resource-toolbar"><div class="resource-filter-tools"><input id="filter" placeholder="筛选文件名或路径…" aria-label="筛选文件"><select id="sort" aria-label="排序方式"><option value="name">名称升序 · 目录优先</option><option value="name-desc">名称降序 · 目录优先</option><option value="updated">最近修改 · 目录优先</option><option value="size">文件大小 · 目录优先</option><option value="type">文件类型 · 目录优先</option></select></div><div><button id="expand-all">全部展开</button><button id="collapse-all">全部收起</button><button id="new-file">${icon('plus')}文件</button><button id="new-dir">${typeIcon({kind:'directory'})}目录</button><button id="upload" class="primary">上传文件</button></div></div><div id="resource-list"></div><div class="resource-footer" id="resource-count"></div></section><input type="file" id="upload-input" multiple hidden><div id="drop-hint" class="drop-hint" hidden>松开文件，选择上传目录</div>`;
  const base=()=>`/api/admin/spaces/${owner}`;
  async function refresh(){const sequence=++refreshSequence,activeOwner=owner,activeView=view;const result=await api(`${base()}/entities?kind=${activeView}`);if(disposed||sequence!==refreshSequence||owner!==activeOwner||view!==activeView)return;rows=result.items;render();}
  async function edit(row){if(await openEditor({row,base:base()}))await refresh();}
  function control(row,action,label){return action==='download'?`<a class="button" href="${base()}/files/${row.id}" download="${esc(row.path.split('/').pop())}">${label}</a>`:`<button data-id="${row.id}" data-action="${action}" class="${action==='delete'?'danger':''}">${label}</button>`;}
  function render(){
    const tree=fileList(rows,{expanded:expanded(),query:filter,sort,deleted});
    const records=rows.filter(row=>!row.path&&!!row.deleted===deleted&&String(row.data.title||row.data.key).toLowerCase().includes(filter.trim().toLowerCase())).sort(compareRows(sort));
    const visible=view==='files'?tree.entries:records.map(row=>({row,depth:0,expanded:false}));
    const searching=!!filter.trim();
    $('#expand-all').hidden=$('#collapse-all').hidden=view!=='files';
    $('#expand-all').disabled=searching||!tree.directories.some(row=>!expanded().has(row.id));
    $('#collapse-all').disabled=searching||!tree.directories.some(row=>expanded().has(row.id));
    $('#expand-all').title=$('#collapse-all').title=searching?'搜索时临时展开匹配目录，清空搜索后可操作':'';
    $('#resource-list').innerHTML=visible.length?`<div class="resource-table-wrap"><table class="resource-table"><colgroup><col class="name-col"><col class="size-col"><col class="date-col"><col class="state-col"><col class="action-col"></colgroup><thead><tr><th>名称</th><th class="size-cell">版本 / 大小</th><th class="date-cell">更新时间</th><th class="state-cell">状态</th><th>操作</th></tr></thead><tbody>${visible.map(({row,depth,expanded:open})=>{
      const title=row.path?.split('/').pop()||row.data.title||row.data.key;const directory=row.kind==='directory';const actions=actionsFor(row,owner);
      return `<tr><td><div class="resource-name depth-${Math.min(depth,5)}">${row.path?typeIcon(row,open):icon('clock')}<button class="resource-title" data-id="${row.id}" data-action="edit" title="${esc(row.path||title)}">${esc(title)}</button>${directory?`<button class="resource-toggle" data-toggle="${row.id}" aria-expanded="${open}" ${searching?'disabled':''} aria-label="${open?'收起':'展开'} ${esc(title)}">${open?'−':'＋'}</button>`:''}</div><small class="row-summary">v${row.version}${row.kind==='file'?' · '+(row.data.size/1024).toFixed(1)+' KB':''} · ${row.deleted?'已删除':row.enabled?'启用':'停用'}</small></td><td class="size-cell">v${row.version}<small>${row.kind==='file'?(row.data.size/1024).toFixed(1)+' KB':directory?'目录':row.kind}</small></td><td class="date-cell">${time(row.updated)}</td><td class="state-cell">${badge(row.deleted?'已删除':row.enabled?'启用':'停用',row.enabled&&!row.deleted?'green':'')}</td><td><div class="row-actions">${actions.map(([a,l])=>control(row,a,l)).join('')}</div><details class="resource-menu"><summary>操作 ▾</summary><div class="resource-menu-list">${actions.map(([a,l])=>control(row,a,l)).join('')}</div></details></td></tr>`;
    }).join('')}</tbody></table></div>`:empty(deleted?'回收站为空':'没有匹配的内容',view==='files'?'拖入文件，或点击上传文件。':'记录同步后会显示在这里。');
    $('#resource-count').textContent=`${view==='files'?(searching?`${tree.matches} 项匹配`:`共 ${tree.total} 项，当前显示 ${visible.length} 项`):`${records.length} 项`} · ${owners.find(o=>o.value===owner).label}`;
    $('#resource-list').querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',async()=>{try{button.closest('details')?.removeAttribute('open');const row=rows.find(r=>r.id===button.dataset.id);await fileAction(button.dataset.action,{row,base:base(),users:data.users,refresh,edit});}catch(e){toast(e.message,true);}}));
    $('#resource-list').querySelectorAll('[data-toggle]').forEach(button=>button.addEventListener('click',()=>{const key=button.dataset.toggle;if(expanded().has(key))expanded().delete(key);else expanded().add(key);render();}));
  }
  on('#sort','change',e=>{sort=e.target.value;render();});
  on('#expand-all','click',()=>{for(const row of rows.filter(r=>r.kind==='directory'&&!!r.deleted===deleted))expanded().add(row.id);render();});
  on('#collapse-all','click',()=>{expanded().clear();render();});
  on('#owner','change',async e=>{owner=e.target.value;rows=[];render();await refresh();});on('#filter','input',e=>{filter=e.target.value;render();});on('#trash','change',e=>{deleted=e.target.checked;render();});
  for(const [button,kind] of [['#files-tab','files'],['#records-tab','records']])on(button,'click',async()=>{view=kind;$('#files-tab').classList.toggle('active',kind==='files');$('#records-tab').classList.toggle('active',kind==='records');await refresh();});
  async function create(kind){const result=await form(kind==='directory'?'新建目录':'新建文件',[{name:'path',label:'相对路径',hint:'父目录需要先创建，例如 影视/示例.py。'}],'创建',{submit:async input=>{const payload=kind==='file'?await putFile(base(),new Uint8Array(),input.path):{};return send(`${base()}/commit`,{opId:crypto.randomUUID(),patch:{id:crypto.randomUUID(),kind,path:input.path,baseVersion:0,data:payload}});}});if(result)await refresh();}
  const upload=async files=>{const activeOwner=owner,url=base();const targets=view==='files'?rows:(await api(`${url}/entities?kind=files`)).items;if(disposed||owner!==activeOwner)return;if(await showUploads({files,rows:targets,base:url}))await refresh();};
  on('#new-file','click',()=>create('file'));on('#new-dir','click',()=>create('directory'));on('#upload','click',()=>$('#upload-input').click());on('#upload-input','change',async e=>{await upload([...e.target.files]);e.target.value='';});
  on('#sync-settings','click',showSyncSettings);on('#conflicts','click',async()=>showConflicts(base(),(await api(`${base()}/entities`)).items,refresh));
  const controller=new AbortController();let dragDepth=0;
  const fileDrag=e=>[...(e.dataTransfer?.types||[])].includes('Files');
  document.addEventListener('dragenter',e=>{if(fileDrag(e)){e.preventDefault();dragDepth++;if(!$('#modal').open)$('#drop-hint').hidden=false;}},{signal:controller.signal});
  document.addEventListener('dragover',e=>{if(fileDrag(e))e.preventDefault();},{signal:controller.signal});
  document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('#drop-hint').hidden=true;}},{signal:controller.signal});
  document.addEventListener('drop',async e=>{if(!fileDrag(e))return;e.preventDefault();dragDepth=0;$('#drop-hint').hidden=true;if($('#modal').open){toast('请先关闭当前弹窗，再拖入文件');return;}try{await upload([...e.dataTransfer.files]);}catch(error){toast(error.message,true);}},{signal:controller.signal});
  onPageLeave(()=>{disposed=true;controller.abort();});await refresh();
}
