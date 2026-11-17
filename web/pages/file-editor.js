// 弹窗编辑文本或替换二进制文件，保存仍走原版本校验。
import {$,api,esc,form,toast,setUnsaved} from '../ui.js';
import {putFile,saveFile} from '../lib/files-api.js';
export async function openEditor({row,base}){
  if(row.kind==='directory')return !!await form('目录信息',[{name:'path',label:'目录路径',value:row.path}],'保存',{submit:input=>saveFile(base,row,{path:input.path})});
  const modal=$('#modal');modal.classList.add('editor-modal');
  modal.innerHTML=`<div class="dialog-heading"><h2>${esc(row.path||row.data.title||row.data.key)}</h2><button class="icon-button" id="close-editor" aria-label="关闭">×</button></div><div class="editor-meta"><span>v${row.version} · ${row.kind==='file'?(row.data.size/1024).toFixed(1)+' KB':row.kind}</span>${row.kind==='file'&&!row.deleted?'<label class="button">替换文件<input id="replace-file" type="file" hidden disabled></label>':''}</div><div class="dialog-body" id="editor-body"><div class="loading">读取内容…</div></div><p class="dialog-error" id="editor-error" hidden role="alert"></p><div class="dialog-footer"><button id="cancel-editor">关闭</button><button id="save-editor" class="primary" disabled>保存修改</button></div>`;
  let dirty=false,busy=false,changed=false,textMode=false,binary=null,closed=false,loaded=false;
  const error=message=>{if(closed)return;const box=$('#editor-error');box.textContent=message;box.hidden=false;};
  const close=()=>{if(busy)return;if(dirty&&!window.confirm('放弃尚未保存的修改？'))return;modal.close();};
  const cancel=e=>{e.preventDefault();close();};modal.addEventListener('cancel',cancel);
  $('#close-editor').onclick=close;$('#cancel-editor').onclick=close;modal.showModal();
  const done=new Promise(resolve=>modal.addEventListener('close',()=>{closed=true;modal.removeEventListener('cancel',cancel);modal.classList.remove('editor-modal');setUnsaved(false);modal.replaceChildren();resolve(changed);},{once:true}));
  function display(bytes){
    if(closed)return;
    let text='';try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);textMode=!text.includes('\0');}catch{textMode=false;}
    binary=bytes;
    $('#editor-body').innerHTML=textMode?`<textarea class="code" id="edit-content" aria-label="文件内容" spellcheck="false" ${row.deleted?'readonly':''}>${esc(text)}</textarea>`:'<div class="empty"><strong>二进制文件</strong><p>点击“替换文件”上传新版本，原版本仍会保留。</p></div>';
    if(textMode)$('#edit-content').oninput=()=>{dirty=true;setUnsaved(true);};
  }
  try{
    if(row.kind==='file')display(new Uint8Array(await (await api(`${base}/files/${row.id}`)).arrayBuffer()));
    else display(new TextEncoder().encode(JSON.stringify(row.data,null,2)));
    loaded=true;
  }catch(e){error(e.message);if(!closed)$('#save-editor').disabled=true;}
  if(closed)return done;
  $('#save-editor').disabled=!loaded||!!row.deleted;if($('#replace-file'))$('#replace-file').disabled=!loaded;
  if($('#replace-file'))$('#replace-file').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>1572864)throw new Error('文件不能超过 1.5 MiB');const bytes=new Uint8Array(await file.arrayBuffer());if(closed)return;display(bytes);dirty=true;setUnsaved(true);}catch(e){error(e.message);}};
  $('#save-editor').onclick=async()=>{
    if(busy)return;busy=true;modal.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=true);$('#editor-error').hidden=true;
    try{let data;if(row.kind==='file'){const bytes=textMode?new TextEncoder().encode($('#edit-content').value):binary;data=await putFile(base,bytes,row.path);}else data=JSON.parse($('#edit-content').value);
      await saveFile(base,row,{data});dirty=false;changed=true;setUnsaved(false);modal.close();toast('文件已更新');
    }catch(e){error(e.message);}finally{busy=false;if(!closed)modal.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=false);}
  };
  return done;
}
