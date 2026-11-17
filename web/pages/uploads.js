// 拖放与普通上传共用预览；字节最多三路并发，元数据始终有序提交。
import {$,send,esc} from '../ui.js';
import {putFile} from '../lib/files-api.js';
import {planUploads} from '../lib/upload-plan.js';
export async function showUploads({files,rows,base,directory=''}){
  if(!files.length)return false;const modal=$('#modal');modal.classList.add('upload-modal');
  const dirs=rows.filter(r=>r.kind==='directory'&&!r.deleted);
  modal.innerHTML=`<div class="dialog-heading"><h2>上传 ${files.length} 个文件</h2><button class="icon-button" id="close-upload" aria-label="关闭">×</button></div><div class="dialog-body"><label>上传目录<select id="upload-directory"><option value="">根目录</option>${dirs.map(r=>`<option value="${esc(r.path)}" ${r.path===directory?'selected':''}>${esc(r.path)}</option>`).join('')}</select></label><label>同文件名处理<select id="upload-mode"><option value="rename">自动重命名避让，保留源文件</option><option value="overwrite">覆盖已有文件，保留历史版本</option></select></label><small>同批次重名文件始终自动避让。单文件最多 1.5 MiB，目录中的规则同样适用。</small><div class="upload-list" id="upload-list"></div><progress class="upload-progress" id="upload-progress" max="${files.length}" value="0"></progress><p id="upload-status" role="status">确认目标目录后开始上传。</p></div><div class="dialog-footer"><button id="stop-upload" hidden>停止后续上传</button><button id="cancel-upload">关闭</button><button id="start-upload" class="primary">开始上传</button></div>`;
  let jobs=[],busy=false,changed=false,controller;
  function plan(){jobs=planUploads(files,rows,$('#upload-directory').value,$('#upload-mode').value).map(item=>({...item,status:'等待上传',error:'',data:null,input:null}));render();}
  function render(){
    $('#upload-list').innerHTML=jobs.map(job=>`<div class="upload-row"><div><strong>${esc(job.file.name)}</strong><small>→ ${esc(job.path)} · ${job.existing?'覆盖 v'+job.existing.version:job.renamed?'自动避让':'新文件'} · ${(job.file.size/1024).toFixed(1)} KB</small>${job.error?`<small class="error-text">${esc(job.error)}</small>`:''}</div><span>${esc(job.status)}</span></div>`).join('');
    $('#upload-progress').value=jobs.filter(j=>j.status==='已完成').length;
  }
  const close=()=>{if(!busy)modal.close();};const cancel=e=>{e.preventDefault();close();};modal.addEventListener('cancel',cancel);
  $('#close-upload').onclick=close;$('#cancel-upload').onclick=close;$('#upload-directory').onchange=plan;$('#upload-mode').onchange=plan;
  $('#stop-upload').onclick=()=>controller?.abort();
  $('#start-upload').onclick=async()=>{
    if(busy)return;busy=true;controller=new AbortController();
    for(const selector of ['#close-upload','#cancel-upload','#start-upload','#upload-directory','#upload-mode'])$(selector).disabled=true;
    $('#stop-upload').hidden=false;$('#upload-status').textContent='正在上传文件内容…';let index=0;
    const pending=jobs.filter(j=>j.status!=='已完成');
    const worker=async()=>{while(index<pending.length&&!controller.signal.aborted){const job=pending[index++];job.error='';try{
      if(job.file.size>1572864)throw new Error('文件超过 1.5 MiB');
      if(!job.data){job.status='上传中';render();job.data=await putFile(base,await job.file.arrayBuffer(),job.path,controller.signal);}
      job.status='等待保存';
    }catch(e){job.status='失败';job.error=controller.signal.aborted?'已停止':e.message;}render();}};
    try{
      await Promise.all(Array.from({length:Math.min(3,pending.length)},worker));
      $('#upload-status').textContent='正在按顺序保存文件版本…';
      for(const job of pending){
        if(controller.signal.aborted)break;if(job.status!=='等待保存')continue;
        job.status='保存中';render();
        job.input||={opId:crypto.randomUUID(),patch:{id:job.existing?.id||crypto.randomUUID(),kind:'file',path:job.path,baseVersion:job.existing?.version||0,enabled:job.existing?!!job.existing.enabled:true,data:job.data}};
        try{await send(`${base}/commit`,job.input);job.status='已完成';changed=true;}catch(e){job.status='失败';job.error=e.message;}
        render();
      }
    }finally{
      busy=false;$('#stop-upload').hidden=true;$('#close-upload').disabled=false;$('#cancel-upload').disabled=false;
      const completed=jobs.filter(j=>j.status==='已完成').length;
      $('#upload-status').textContent=`已完成 ${completed} / ${jobs.length} 个。${completed<jobs.length?'未完成项保留在列表，可重试；冲突需先处理或重新选择目标。':''}`;
      $('#start-upload').textContent=completed===jobs.length?'全部完成':'重试未完成项';$('#start-upload').disabled=completed===jobs.length;
    }
  };
  modal.showModal();plan();
  await new Promise(resolve=>modal.addEventListener('close',resolve,{once:true}));
  controller?.abort();modal.removeEventListener('cancel',cancel);modal.classList.remove('upload-modal');modal.replaceChildren();
  return changed;
}
