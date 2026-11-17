// 发布表单与永久配置链接管理；公开接口直接复制，密码接口签发只读凭证。
import {esc,badge,empty,table,on,send,form,ownerOptions,copy,toast} from '../ui.js';
import {icon} from '../icons.js';
export function sharesPanel(data){
  return `<section class="panel"><div class="section-heading"><div><h2>配置接口</h2><p>永久有效的只读配置链接，支持公开访问或密码保护。</p></div><button class="primary" id="create-share">${icon('plus')}新建接口</button></div>${data.shares.length?table(['接口名称','来源 / 目录','访问方式','状态','操作'],data.shares.map(s=>`<tr><td><div class="share-title"><span class="share-symbol">${icon('link')}</span><div><strong>${esc(s.name)}</strong><small>永久有效</small></div></div></td><td>${esc(s.owner==='public'?'公共爬虫库':data.users.find(u=>u.id===s.owner)?.name)}<small class="share-scope">${icon('folder')}${esc(s.root||'全部目录')}</small></td><td><span class="share-scope">${icon(s.password_required?'lock':'globe')}${s.password_required?'密码访问':'公开访问'}</span></td><td>${badge(s.enabled?'启用':'停用',s.enabled?'green':'')}</td><td class="actions"><button data-token="${s.id}" ${s.enabled?'':'disabled'}>${icon('copy')}复制配置</button><button data-entry="${s.id}" title="复制分享入口">${icon('link')}分享入口</button><button data-share="${s.id}">${icon('settings')}设置</button></td></tr>`)):empty('创建第一个配置接口','选择资源目录，即可生成供 App 使用的永久链接。')}</section>`;
}
export function bindShareActions(data,reload){
  on('#create-share','click',async()=>{
    const result=await form('新建配置接口',[
      {name:'name',label:'接口名称',placeholder:'例如：家庭点播'},
      {name:'owner',label:'来源空间',type:'select',options:ownerOptions(data.users)},
      {name:'root',label:'发布目录',required:false,placeholder:'全部目录',hint:'留空使用全部文件，也可填写已有目录的相对路径。'},
      {name:'password',label:'访问密码（选填）',type:'password',required:false,min:5,placeholder:'留空即可公开访问',hint:'设置密码时至少 5 位。配置链接永久有效。'}
    ],'创建接口',{description:'只分享所选目录的配置和脚本，不包含人物观看数据。',submit:input=>send('/api/admin/shares',input)});
    if(result){toast('接口已创建');await reload();}
  });
  for(const share of data.shares){
    on(`[data-entry="${share.id}"]`,'click',()=>copy(`${location.origin}/s/${share.id}`));
    on(`[data-token="${share.id}"]`,'click',async()=>{const result=await send(`/api/admin/shares/${share.id}/token`);await copy(result.url);});
    on(`[data-share="${share.id}"]`,'click',async()=>{
      const result=await form('接口设置',[
        {name:'name',label:'接口名称',value:share.name},
        {name:'enabled',label:'接口状态',type:'select',value:share.enabled,options:[{value:1,label:'启用'},{value:0,label:'停用'}]},
        {name:'passwordAction',label:'访问密码',type:'select',options:[{value:'keep',label:share.password_required?'保留当前密码':'保持公开访问'},{value:'set',label:'设置新密码'},{value:'clear',label:'取消密码，公开访问'}]},
        {name:'password',label:'新密码',type:'password',required:false,min:5,placeholder:'选择“设置新密码”时填写',hint:'至少 5 位。修改密码会撤销原有授权链接。'}
      ],'保存设置',{submit:input=>{
        const patch={name:input.name,enabled:input.enabled==='1'};
        if(input.passwordAction==='set'){if(input.password.length<5)throw new Error('新密码至少 5 位');patch.password=input.password;}
        if(input.passwordAction==='clear')patch.password='';
        return send(`/api/admin/shares/${share.id}`,patch,'PATCH');
      }});
      if(result){toast('接口设置已保存');await reload();}
    });
  }
}
