// 通用请求、转义与对话框行为；视觉样式由 Tailwind 组件层提供。
import { icon } from './icons.js';
export const $=selector=>document.querySelector(selector);
let unsaved=false;
let pageCleanups=[];
export const onPageLeave=callback=>pageCleanups.push(callback);
export function cleanupPage(){for(const callback of pageCleanups)callback();pageCleanups=[];}
export const setUnsaved=value=>{unsaved=value;};
export const canLeave=()=>!unsaved||window.confirm('当前内容尚未保存，放弃修改吗？');
window.addEventListener('beforeunload',event=>{if(unsaved){event.preventDefault();event.returnValue='';}});
export const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚未连接';
export const badge=(text,style='')=>`<span class="badge ${style}">${esc(text)}</span>`;
export const empty=(title,detail='')=>`<div class="empty"><span class="empty-mark">${icon('folder')}</span><strong>${esc(title)}</strong><p>${esc(detail)}</p></div>`;
export const table=(headers,rows)=>`<div class="table-wrap"><table><thead><tr>${headers.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
export async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{...(options.body&&typeof options.body==='string'?{'content-type':'application/json'}:{}),...options.headers}});
  if(!response.ok){const result=await response.json().catch(()=>({}));const error=new Error(result.error||`请求失败 ${response.status}`);error.detail=result.detail;error.status=response.status;throw error;}
  return response.headers.get('content-type')?.includes('application/json')?response.json():response;
}
export const send=(path,data={},method='POST')=>api(path,{method,body:JSON.stringify(data)});
export function toast(message,error=false){$('#toast').textContent=message;$('#toast').className=error?'show error':'show';clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').className='',4500);}
export function on(selector,event,action){const element=$(selector);if(element)element.addEventListener(event,async e=>{try{await action(e);}catch(error){toast(error.message,true);}});}
function fieldMarkup(field){
  if(field.html)return field.html;
  const control=field.type==='select'?`<select name="${esc(field.name)}">${field.options.map(o=>`<option value="${esc(o.value)}" ${String(o.value)===String(field.value)?'selected':''}>${esc(o.label)}</option>`).join('')}</select>`:
    `<input name="${esc(field.name)}" type="${field.type||'text'}" value="${esc(field.value||'')}" ${field.required===false?'':'required'} ${field.min?`minlength="${field.min}"`:''} placeholder="${esc(field.placeholder||'')}" autocomplete="${esc(field.autocomplete||(field.type==='password'?'new-password':'off'))}">`;
  return `<label>${esc(field.label)}${control}${field.hint?`<small>${esc(field.hint)}</small>`:''}</label>`;
}
export async function form(title,fields,action='保存',options={}){
  const modal=$('#modal');
  modal.innerHTML=`<form method="dialog"><div class="dialog-heading"><h2>${esc(title)}</h2><button type="button" data-cancel class="icon-button" aria-label="关闭">×</button></div><div class="dialog-body">${options.description?`<p class="dialog-description">${esc(options.description)}</p>`:''}${fields.map(fieldMarkup).join('')}</div><p class="dialog-error" role="alert" hidden></p><div class="dialog-footer"><button type="button" data-cancel>取消</button><button type="submit" class="primary" value="ok">${esc(action)}</button></div></form>`;
  const element=modal.querySelector('form');let busy=false;
  element.querySelectorAll('[data-cancel]').forEach(button=>button.addEventListener('click',()=>{if(!busy)modal.close('cancel');}));
  element.addEventListener('submit',async event=>{
    if(event.submitter?.value==='cancel')return;
    if(busy){event.preventDefault();return;}
    if(!options.submit)return;
    event.preventDefault();busy=true;const buttons=[...element.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
    const errorBox=element.querySelector('.dialog-error');errorBox.hidden=true;
    try{await options.submit(Object.fromEntries(new FormData(element)));modal.close('ok');}
    catch(error){errorBox.textContent=error.message;errorBox.hidden=false;}
    finally{busy=false;buttons.forEach(b=>b.disabled=false);}
  });
  const cancel=event=>{if(busy)event.preventDefault();};
  modal.addEventListener('cancel',cancel);modal.returnValue='';
  modal.showModal();
  return new Promise(resolve=>modal.addEventListener('close',()=>{modal.removeEventListener('cancel',cancel);resolve(modal.returnValue==='ok'?Object.fromEntries(new FormData(element)):null);},{once:true}));
}
export const confirm=async(title,message)=>!!await form(title,[{html:`<p>${esc(message)}</p>`}],'确认');
export async function showSecret(title,value,hint){await form(title,[{html:`<p>${esc(hint)}</p><textarea readonly rows="4">${esc(value)}</textarea><small>选中内容即可复制。</small>`}],'完成');}
export async function copy(text){try{await navigator.clipboard.writeText(text);toast('已复制');}catch{await showSecret('复制内容',text,'浏览器未允许自动复制，请手动复制。');}}
export const ownerOptions=users=>[{value:'public',label:'公共爬虫库'},...users.map(u=>({value:u.id,label:u.name}))];
