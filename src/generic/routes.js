// 通用公开协议与旧同步协议分离，保留已有设备鉴权和后台界面。
import {body} from '../lib/http.js';
import {pushData} from './push.js';
import {pushFile} from './files.js';
import {restore} from './restore.js';
import {publication} from './publication.js';
import {checkPush} from './check.js';
export async function genericRoute(env,request,url,device){
  if(url.pathname==='/api/v2/sync/push'&&request.method==='POST'){const input=await body(request);return input.action==='check'?checkPush(env,device,input):input.action?publication(env,device,input):pushData(env,device,input);}
  if(url.pathname==='/api/v2/sync/file'&&['PUT','DELETE'].includes(request.method))return pushFile(env,request,url,device);
  if(url.pathname==='/api/v2/sync/restore'&&request.method==='POST')return restore(env,device,await body(request));
  return null;
}
