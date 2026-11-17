// 概览以配置接口、设备和真实同步事件为中心，不放装饰性仪表卡。
import {$,esc,time,badge,empty,table,on} from '../ui.js';
import {icon} from '../icons.js';
import {sharesPanel,bindShareActions} from './shares.js';
export async function overview({data,reload}){
  const active=data.devices.filter(d=>!d.revoked&&data.serverTime-d.last_seen<120000);
  $('#page').innerHTML=`<div class="page-heading"><div><h1>概览</h1><p>管理配置接口，查看设备和最近的同步活动。</p></div><button id="refresh">${icon('refresh')}刷新</button></div>
    <div class="stats-strip"><span>${icon('users')}<strong>${data.users.length}</strong> 个用户</span><span>${icon('devices')}<strong>${active.length}</strong> 台在线设备</span><span>${icon('link')}<strong>${data.shares.length}</strong> 个配置接口</span>${data.conflicts.total?`<a href="#files">${data.conflicts.total} 个冲突待处理 ${icon('chevron')}</a>`:''}</div>
    ${sharesPanel(data)}<div class="overview-grid"><section class="panel"><div class="section-heading"><h2>设备动态 <span>${data.devices.length}</span></h2><a href="#devices">全部设备 ${icon('chevron')}</a></div>${data.devices.length?table(['设备','所属用户','状态'],data.devices.slice(0,6).map(d=>`<tr><td><div class="person"><span class="avatar">${icon('devices')}</span><div><strong>${esc(d.name)}</strong><small>${time(d.last_seen)}</small></div></div></td><td>${esc(d.user_name)}</td><td>${badge(d.revoked?'已撤销':data.serverTime-d.last_seen<120000?'在线':'离线',!d.revoked&&data.serverTime-d.last_seen<120000?'green':'')}</td></tr>`)):empty('还没有绑定设备','在用户管理中生成绑定码，即可添加设备。')}</section>
    <section class="panel"><div class="section-heading"><h2>最近同步</h2><span class="muted">最近 ${data.events.length} 条</span></div>${data.events.length?`<div class="activity-list">${data.events.map(e=>`<div class="activity-row"><span class="activity-icon">${icon(e.action==='失败'?'clock':'refresh')}</span><div class="activity-content"><div><strong>${esc(e.device_name||'管理后台')} · ${esc(e.action)}</strong><time>${time(e.created)}</time></div><p>${esc(e.user_name||'公共库')} / ${esc(e.detail)}</p></div></div>`).join('')}</div>`:empty('暂无同步记录','上传、下载和后台修改会自动记录。')}</section></div>`;
  on('#refresh','click',reload);bindShareActions(data,reload);
}
