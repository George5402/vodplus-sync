// 账号操作独立于人物管理；不提供匿名重置接口。
import {$,api,send,form,esc,toast} from '../ui.js';
export async function showAccount(onSignedOut){
  const admin=await api('/api/admin/account');let reset=false;
  const pending=form('管理员账号',[
    {html:`<p>当前账号：<strong>${esc(admin.username)}</strong></p>`},
    {name:'currentPassword',label:'当前密码',type:'password',autocomplete:'current-password'},
    {name:'newPassword',label:'新密码',type:'password',min:5,hint:'至少 5 位。修改后所有后台登录会话都需要重新登录。'},
    {name:'repeatPassword',label:'再次输入新密码',type:'password',min:5},
    {html:'<div class="account-danger"><strong>服务维护</strong><p>需要重新从零开始时，可进入左侧“服务重置”菜单。</p><button type="button" id="open-reset">打开服务重置</button></div>'}
  ],'修改密码',{submit:input=>{if(input.newPassword!==input.repeatPassword)throw new Error('两次输入的新密码不一致');return send('/api/admin/account/password',{currentPassword:input.currentPassword,newPassword:input.newPassword});}});
  $('#open-reset').onclick=()=>{reset=true;$('#modal').close('cancel');};
  const result=await pending;
  if(result){toast('密码已修改，请重新登录');await onSignedOut();}
  if(reset)location.hash='reset';
}
export async function showReset(onSignedOut){
  const result=await form('清空全部数据并重置',[
    {html:'<p class="error-text">将删除全部管理员、用户、设备授权、文件及历史版本、分享接口、同步记录和自定义规则。此操作不能从后台撤销。</p>'},
    {name:'currentPassword',label:'当前管理员密码',type:'password',autocomplete:'current-password'},
    {name:'confirmation',label:'输入 RESET 确认',placeholder:'RESET',hint:'完成后进入管理员初始化页，设备需要重新绑定。'}
  ],'确认清空全部数据',{submit:input=>send('/api/admin/account/reset',input)});
  if(result){toast('数据已清空，请创建新管理员');await onSignedOut();}
}
export async function showLoginHelp(){
  await form('账号与重置说明',[
    {html:'<p>重新部署会保留原 D1 数据。显示登录页表示数据库已有管理员，请使用原账号和密码登录；本服务没有默认 admin 密码。</p><p>登录后，左侧“服务重置”菜单可直接清空数据并重新初始化，右上角头像可修改管理员密码，均通过网页操作。</p><p>如果确实忘记原账号密码，需要先由服务所有者恢复管理员访问权限；未登录的访客不能清空服务数据。</p>'}
  ],'知道了');
}
