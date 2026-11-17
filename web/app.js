// 后台页面壳与首次初始化，页面功能由独立模块提供。
import {$,api,send,esc,on,toast,canLeave,setUnsaved,cleanupPage} from './ui.js';
import {icon,brand} from './icons.js';
import {overview} from './pages/overview.js';
import {usersPage,devicesPage} from './pages/people.js';
import {filesPage} from './pages/files.js';
import {showAccount,showLoginHelp} from './pages/account.js';
import {serviceResetPage} from './pages/service-reset.js';
const nav=[['overview','概览','overview'],['users','用户管理','users'],['files','爬虫管理','folder'],['devices','设备管理','devices'],['reset','服务重置','refresh']];
let active='overview';let data;
async function login(){
  cleanupPage();
  const status=await api('/api/status');const setup=!status.initialized;
  $('#app').innerHTML=`<main class="auth"><div class="wordmark">${brand()}</div><h1>${setup?'创建管理员':'登录管理后台'}</h1><p>${setup?'首次使用，设置账号和密码后即可开始。':'管理资源、配置接口和设备同步。'}</p><form id="login-form"><label>管理员账号<input name="username" required autocomplete="username" placeholder="输入管理员账号"></label><label>密码<input name="password" type="password" minlength="5" maxlength="200" required autocomplete="${setup?'new-password':'current-password'}" placeholder="至少 5 位">${setup?'<small>密码至少 5 位，创建后使用此账号登录。</small>':''}</label><p id="login-error" class="error-text" role="alert" hidden></p><button class="primary">${setup?'创建并进入后台':'登录'}</button></form>${setup?'':'<button id="login-help" class="text-button">无法登录？查看账号与重置说明</button>'}<small>VodPlus Sync · 你的资源与同步空间</small></main>`;
  on('#login-help','click',showLoginHelp);
  on('#login-form','submit',async e=>{
    e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;
    try{await send(setup?'/api/setup':'/api/login',Object.fromEntries(new FormData(e.target)));await load();}
    catch(error){$('#login-error').textContent=error.message;$('#login-error').hidden=false;button.disabled=false;}
  });
}
async function load(){
  try{data=await api('/api/admin/overview');await render();}
  catch(error){if(error.status===401)return login();throw error;}
}
async function render(){
  cleanupPage();
  setUnsaved(false);
  $('#app').innerHTML=`<aside class="sidebar"><a class="wordmark" href="#overview">${brand()}</a><div class="workspace-label">工作空间</div><nav>${nav.map(([key,label,symbol])=>`<a href="#${key}" ${active===key?'aria-current="page"':''}>${icon(symbol)}<span>${label}</span></a>`).join('')}</nav><div class="sidebar-bottom"><div><span class="avatar">管</span><div><p>管理员</p><small>资源与同步管理</small></div></div><button id="account" class="text-button">${icon('settings')}账号与数据</button><button id="logout" class="text-button">${icon('logout')}退出登录</button></div></aside><main class="workspace"><header class="topbar"><span class="breadcrumb">工作空间 ${icon('chevron')} ${nav.find(n=>n[0]===active)[1]}</span><div><span class="environment">个人空间</span><button id="account-top" class="avatar" aria-label="管理员账号设置">管</button></div></header><div id="page"></div><footer>VodPlus Sync<span>资源有序，数据独立。</span></footer></main>`;
  on('#account','click',()=>showAccount(login));on('#account-top','click',()=>showAccount(login));
  on('#logout','click',async()=>{if(canLeave()){await send('/api/logout');setUnsaved(false);await login();}});
  document.querySelectorAll('a[href^="#"]').forEach(link=>link.addEventListener('click',event=>{if(!canLeave())event.preventDefault();}));
  await ({overview,users:usersPage,devices:devicesPage,files:filesPage,reset:serviceResetPage}[active])({data,reload:load,onReset:async()=>{active='overview';history.replaceState(null,'','#overview');await login();}});
}
window.addEventListener('hashchange',()=>{const key=location.hash.slice(1).split('?')[0];if(nav.some(n=>n[0]===key)){active=key;load().catch(e=>toast(e.message,true));}});
active=nav.some(n=>n[0]===location.hash.slice(1).split('?')[0])?location.hash.slice(1).split('?')[0]:'overview';
load().catch(error=>{$('#app').innerHTML=`<main class="auth"><div class="wordmark">${brand()}</div><h1>暂时无法连接</h1><p>${esc(error.message)}</p><button id="retry">重试</button></main>`;on('#retry','click',load);});
