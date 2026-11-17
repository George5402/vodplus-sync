// Worker 总入口：路由鉴权、统一错误和后台静态资源。
import { Fault, assert, json, secure } from './lib/http.js';
import { admin, authRoute, device } from './auth.js';
import { adminRoute } from './admin.js';
import { syncRoute } from './sync/routes.js';
import { manageShare, shareRoute } from './shares.js';
import { maintenance } from './maintenance.js';
import {adminDeviceConfigRoute,syncDeviceConfigRoute} from './devices/routes.js';
import {accountRoute} from './account.js';
import {health,failureDetail,failureMessage} from './diagnostics.js';
import {ensureSchema} from './schema/ensure.js';
import {genericRoute} from './generic/routes.js';

export default {
  async scheduled(_event, env) { if(await ensureSchema(env))await maintenance(env); },
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const healthRequest=url.pathname==='/api/health'&&request.method==='GET';
      if(!healthRequest&&(url.pathname.startsWith('/api/')||url.pathname.startsWith('/share/')))await ensureSchema(env);
      let response = healthRequest?await health(env):await authRoute(env, request, url.pathname);
      if (!response && url.pathname.startsWith('/api/admin/')) {
        await admin(env, request);
        response = await accountRoute(env,request,url) || await adminDeviceConfigRoute(env,request,url) || await adminRoute(env, request, url) || await manageShare(env, request, url);
      }
      if (!response && url.pathname.startsWith('/api/sync/')) {const current=await device(env,request);response=await syncDeviceConfigRoute(env,request,url,current)||await syncRoute(env,request,url,current);}
      if (!response && url.pathname.startsWith('/api/v2/sync/')) response=await genericRoute(env,request,url,await device(env,request));
      if (!response && url.pathname.startsWith('/share/')) response = await shareRoute(env, request, url);
      if (!response) {
        assert(!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/share/'), 404, '接口不存在');
        assert(['GET','HEAD'].includes(request.method), 405, '请求方式不支持');
        const target = url.pathname.startsWith('/s/') ? new URL('/share.html', url) : url;
        response = await env.ASSETS.fetch(new Request(target, request));
      }
      return secure(response);
    } catch (error) {
      const status = error instanceof Fault ? error.status : 500;
      if(status===500){
        const detail=failureDetail(error);const requestId=crypto.randomUUID();
        // 不记录完整 URL、SQL、错误正文和头部，避免凭证进入日志。
        const path=new URL(request.url).pathname;
        const operation=path.startsWith('/api/sync/')||path.startsWith('/api/v2/sync/')?'sync':path.startsWith('/api/admin/')?'admin':path.startsWith('/share/')?'share':'other';
        console.error(JSON.stringify({event:'request_failed',requestId,operation,...detail}));
        return secure(json({error:failureMessage(detail),detail:{...detail,requestId}},500));
      }
      return secure(json({ error: status === 500 ? '服务暂时不可用，请检查数据库迁移和资源绑定' : error.message, detail: error.detail }, status, status === 503 && error.detail?.retryable ? { 'retry-after': '1' } : {}));
    }
  }
};
