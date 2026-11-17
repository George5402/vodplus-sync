// 管理员按设备操作，App 只能通过自身 Bearer 访问绑定设备的配置。
import {body,json,assert,id} from '../lib/http.js';
import {one} from '../lib/db.js';
import {readDeviceConfig,saveDeviceConfig,requestDeviceConfig,reportDeviceConfig} from './config.js';
export async function adminDeviceConfigRoute(env,request,url){
  const match=url.pathname.match(/^\/api\/admin\/devices\/([^/]+)\/config(\/refresh)?$/);if(!match)return null;
  const deviceId=id(match[1]);
  if(request.method==='GET'&&!match[2])return json(await readDeviceConfig(env,deviceId));
  if(request.method==='PUT'||request.method==='POST'){
    const device=await one(env,'SELECT d.revoked,u.enabled FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=?',deviceId);
    assert(device,404,'设备不存在');assert(!device.revoked&&device.enabled,409,'设备已撤销或人物已停用');
    if(request.method==='POST'&&match[2])return json(await requestDeviceConfig(env,deviceId));
    if(request.method==='PUT'&&!match[2])return json(await saveDeviceConfig(env,deviceId,await body(request)));
  }
  return null;
}
export async function syncDeviceConfigRoute(env,request,url,device){
  if(url.pathname==='/api/sync/device-config'&&request.method==='GET'){
    const state=await readDeviceConfig(env,device.id);
    return json({revision:state.revision,values:state.revision>state.appliedRevision?state.desired:{},appliedRevision:state.appliedRevision,refreshRevision:state.refreshRevision,reportSeq:state.reportSeq,pollAfterMs:5000});
  }
  if(url.pathname==='/api/sync/device-config/report'&&request.method==='POST')return json(await reportDeviceConfig(env,device.id,await body(request)));
  return null;
}
