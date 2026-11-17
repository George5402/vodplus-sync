// 独立服务重置页面，只在管理员确认后调用现有原子重置接口。
import {$,on} from '../ui.js';
import {icon} from '../icons.js';
import {showReset} from './account.js';
export async function serviceResetPage({onReset}){
  $('#page').innerHTML=`<div class="page-heading"><div><h1>服务重置</h1><p>清空全部云端数据，重新开始配置服务。</p></div></div>
    <section class="panel reset-panel"><div class="section-heading"><h2>${icon('refresh')}恢复初始状态</h2></div><div class="reset-content">
    <p>在这里直接完成重置，不需要执行命令，也不需要删除数据库或重新创建 Worker。</p>
    <ul><li><strong>账号与访问</strong><span>清除管理员、登录会话、人物、设备授权和分享接口。</span></li><li><strong>文件与同步数据</strong><span>清除所有文件、历史版本、观看记录、搜索、配置、冲突和同步日志。</span></li><li><strong>重新初始化</strong><span>同步规则恢复默认，返回创建管理员页面；原设备需要重新绑定。</span></li></ul>
    <div class="reset-warning">此操作清空当前服务绑定的 D1 中全部业务数据，不能从后台撤销。App 本地文件不会被自动删除。</div>
    <button id="reset-service" class="reset-action">${icon('refresh')}清空全部数据并重置服务</button>
    </div></section>`;
  on('#reset-service','click',()=>showReset(onReset));
}
