// 配置弹窗轮询实际回报，用户正在编辑的草稿不会被刷新覆盖。
import {$,api,send,esc,time,toast,setUnsaved,onPageLeave} from '../ui.js';
const fields=[['vod','点播'],['live','直播'],['theme','主题'],['wallpaper','壁纸']];
export async function showDeviceConfig(device){
  const modal=$('#modal');modal.classList.add('device-config-modal');const base=`/api/admin/devices/${device.id}/config`;
  modal.innerHTML=`<div class="dialog-heading"><h2>${esc(device.name)} · 当前配置</h2><button class="icon-button" id="close-device-config" aria-label="关闭">×</button></div><div class="dialog-body"><p id="device-config-status" role="status">正在读取设备状态…</p><p id="device-apply-state" class="muted"></p><div class="device-config-labels"><span>设备实际值</span><span>要应用的配置</span></div>${fields.map(([key,label])=>`<div class="device-config-field"><h3>${label}</h3><div><input id="current-${key}" aria-label="${label}当前值" readonly placeholder="尚未上报"><div class="device-config-input"><input id="desired-${key}" aria-label="${label}新配置" placeholder="配置链接或值"><button type="button" data-clear="${key}" title="清空${label}配置">清空</button></div></div></div>`).join('')}<small>留空并点击“清空”可下发空值。仅修改选中的这台设备；其他设备不受影响。</small><p id="device-config-error" class="error-text" role="alert" hidden></p></div><div class="dialog-footer"><button id="reset-device-config">放弃修改</button><button id="refresh-device-config">实时取值</button><button class="primary" id="save-device-config">保存并应用</button></div>`;
  let state=null,dirty=new Set(),editRevision=null,busy=false,closed=false,timer=null,waiting=null,until=Date.now()+60000,submission=null;
  const error=message=>{if(closed)return;$('#device-config-error').textContent=message;$('#device-config-error').hidden=false;};
  function update(next){
    if(closed)return;if(state&&(next.revision<state.revision||next.reportSeq<state.reportSeq||next.refreshRevision<state.refreshRevision))return;
    state=next;
    for(const [key] of fields){$('#current-'+key).value=next.current?.[key]??'';$('#current-'+key).placeholder=next.current?'未设置（空值）':'尚未上报';if(!dirty.has(key))$('#desired-'+key).value=Object.hasOwn(next.desired,key)&&next.revision>next.appliedRevision?next.desired[key]:next.current?.[key]??'';}
    $('#device-config-status').textContent=next.current?`最近上报：${time(next.reportedAt)}`:'设备尚未上报当前配置，需要 App 接入配置控制接口。';
    if(waiting!==null){if(next.reportedRefreshRevision>=waiting){$('#device-config-status').textContent=`已取得新的设备回报：${time(next.reportedAt)}`;waiting=null;}else $('#device-config-status').textContent+=Date.now()<until?' · 正在等待设备实时回报…':' · 暂未收到新回报，设备可能离线。';}
    $('#device-apply-state').textContent=next.revision>next.appliedRevision?`待应用 v${next.revision}；设备已确认 v${next.appliedRevision}${next.error?' · '+next.error:''}`:next.revision?`设备已确认应用 v${next.appliedRevision}`:'尚无远程配置指令。';
  }
  async function read(){update(await api(base));}
  function schedule(){clearTimeout(timer);if(closed)return;if(Date.now()<until)timer=setTimeout(async()=>{try{if(!busy)await read();}catch(e){error(e.message);}finally{schedule();}},2000);else if(waiting!==null&&state)update(state);}
  async function requestRefresh(){if(closed)return;waiting=(await send(base+'/refresh')).refreshRevision;until=Date.now()+60000;await read();schedule();}
  const close=()=>{if(busy)return;if(dirty.size&&!window.confirm('放弃尚未下发的配置修改？'))return;modal.close();};
  const cancel=e=>{e.preventDefault();close();};modal.addEventListener('cancel',cancel);$('#close-device-config').onclick=close;
  for(const [key] of fields){const mark=()=>{if(editRevision===null)editRevision=state?.revision??0;dirty.add(key);setUnsaved(true);submission=null;};$('#desired-'+key).oninput=mark;modal.querySelector(`[data-clear="${key}"]`).onclick=()=>{$('#desired-'+key).value='';mark();};}
  $('#reset-device-config').onclick=()=>{dirty.clear();setUnsaved(false);editRevision=null;submission=null;if(state)update(state);};
  $('#refresh-device-config').onclick=()=>requestRefresh().catch(e=>error(e.message));
  $('#save-device-config').onclick=async()=>{
    if(busy||!state)return;if(!dirty.size){toast('请先修改需要下发的配置');return;}
    busy=true;modal.querySelectorAll('button,input').forEach(el=>el.disabled=true);$('#device-config-error').hidden=true;
    const values=Object.fromEntries([...dirty].map(key=>[key,$('#desired-'+key).value.trim()]));
    const fingerprint=JSON.stringify({baseRevision:editRevision,values});if(submission?.fingerprint!==fingerprint)submission={fingerprint,input:{opId:crypto.randomUUID(),baseRevision:editRevision,values}};
    try{await send(base,submission.input,'PUT');dirty.clear();setUnsaved(false);editRevision=null;submission=null;until=Date.now()+60000;await read();schedule();toast('配置已下发，等待 App 加载确认');}catch(e){error(e.message);}finally{busy=false;if(!closed)modal.querySelectorAll('button,input').forEach(el=>el.disabled=false);}
  };
  modal.showModal();onPageLeave(()=>{if(!closed)modal.close();});const done=new Promise(resolve=>modal.addEventListener('close',()=>{closed=true;setUnsaved(false);clearTimeout(timer);modal.removeEventListener('cancel',cancel);modal.classList.remove('device-config-modal');modal.replaceChildren();resolve();},{once:true}));
  try{await read();if(!device.revoked)await requestRefresh();else $('#save-device-config').disabled=true;}catch(e){error(e.message);}
  return done;
}
