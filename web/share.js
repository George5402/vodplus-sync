// 公开接口直接获取永久链接，密码接口通过 POST 验证后获取。
import {$,api,send,on,copy} from './ui.js';
import {brand} from './icons.js';
const shareId=location.pathname.split('/')[2];
$('#share-brand').innerHTML=brand();
function show(url){$('#url').value=url;$('#unlock').hidden=true;$('#result').hidden=false;$('#share-description').textContent='复制下方链接，即可使用此配置。';}
api(`/share/${shareId}/info`).then(info=>{
  $('#share-name').textContent=info.name;
  if(info.passwordRequired){$('#unlock').hidden=false;$('#share-description').textContent='此配置设置了密码，验证后即可获取永久链接。';}
  else show(info.url);
}).catch(error=>{$('#share-description').textContent=error.message;});
on('#unlock','submit',async e=>{
  e.preventDefault();$('#error').hidden=true;const button=e.target.querySelector('button');button.disabled=true;
  try{const result=await send(`/share/${shareId}/auth`,Object.fromEntries(new FormData(e.target)));show(result.url);e.target.reset();}
  catch(error){$('#error').textContent=error.message;$('#error').hidden=false;}
  finally{button.disabled=false;}
});
on('#copy','click',()=>copy($('#url').value));
