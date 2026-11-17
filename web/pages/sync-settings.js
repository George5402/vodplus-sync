// 全局同步规则入口，保存版本随变更递增，不触发文件删除。
import { api, send, form, toast } from '../ui.js';
export async function showSyncSettings() {
  const current = await api('/api/admin/sync-settings');
  const result = await form('默认同步规则', [
    { name:'extensions', label:'文件后缀', value:current.fileExtensions.join(', '), required:false, hint:'默认 py, js, txt, json, m3u8, jar, php, html。用逗号或空格分隔，大小写不敏感。' },
    { name:'extensionless', label:'无后缀文件', type:'select', value:current.includeExtensionless?'yes':'no', options:[{value:'yes',label:'同步（包括 .hide 这类隐藏文件）'},{value:'no',label:'不同步'}] },
    { name:'excludedDirectories',label:'不同步的目录名',value:(current.excludedDirectories??['_cache','__pycache__','pycache']).join(', '),required:false,hint:'默认 _cache、__pycache__、pycache。用逗号分隔；任意层级同名目录及整个子树都跳过，大小写不敏感。' },
    { html:'<p>对所有用户生效。未排除的目录仍同步；已有内容会保留，规则修改不会自动删除本地或云端文件。公共爬虫库的发布不受此限制。</p>' }
  ], '保存规则', { submit:input=>send('/api/admin/sync-settings', {
    fileExtensions:input.extensions.split(/[\s,，;；]+/u).filter(Boolean),
    includeExtensionless:input.extensionless==='yes', excludedDirectories:input.excludedDirectories.split(/[,，;；\n]+/u).map(value=>value.trim()).filter(Boolean), revision:current.revision
  }, 'PUT') });
  if (result) toast('同步规则已保存，设备下次同步时读取');
}
