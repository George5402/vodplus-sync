// 管理员修改密码与主动恢复初始状态；重置必须同时验证密码和确认文字。
import {assert,body,json} from './lib/http.js';
import {one,run} from './lib/db.js';
import {password,verify} from './lib/crypto.js';
import {throttle} from './auth.js';
import {ensureSchema} from './schema/ensure.js';
function signedOut(request){return {'set-cookie':`vp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${new URL(request.url).protocol==='https:'?'; Secure':''}`};}
async function currentAdmin(env,input){
  assert(typeof input.currentPassword==='string'&&input.currentPassword.length<=200,400,'请填写当前管理员密码');
  const admin=await one(env,'SELECT username,password FROM administrators WHERE id=1');
  assert(admin&&await verify(input.currentPassword,admin.password),401,'当前管理员密码错误');return admin;
}
export async function accountRoute(env,request,url){
  if(url.pathname==='/api/admin/account'&&request.method==='GET'){
    const admin=await one(env,'SELECT username FROM administrators WHERE id=1');assert(admin,401,'管理员尚未初始化');return json(admin);
  }
  if(!['/api/admin/account/password','/api/admin/account/reset'].includes(url.pathname)||request.method!=='POST')return null;
  await throttle(env,request,url.pathname,10);const input=await body(request);const admin=await currentAdmin(env,input);
  if(url.pathname.endsWith('/password')){
    assert(typeof input.newPassword==='string'&&input.newPassword.length>=5&&input.newPassword.length<=200,400,'新密码需要 5–200 个字符');
    const next=await password(input.newPassword);
    const results=await env.DB.batch([
      env.DB.prepare('UPDATE administrators SET password=? WHERE id=1 AND password=?').bind(next,admin.password),
      env.DB.prepare('DELETE FROM sessions WHERE EXISTS(SELECT 1 FROM administrators WHERE id=1 AND password=?)').bind(next)
    ]);
    assert(results[0].meta.changes===1,409,'管理员信息已变化，请重新登录');
    return json({ok:true,relogin:true},200,signedOut(request));
  }
  assert(input.confirmation==='RESET',400,'请输入 RESET 确认清空全部数据');
  // 重置前重新检查，兼容旧库漏迁移或运行期间缺表，不要求用户手动升级。
  await ensureSchema(env,{force:true});
  const result=await run(env,"INSERT INTO maintenance_actions(action) SELECT 'factory_reset' FROM administrators WHERE id=1 AND password=?",admin.password);
  assert(result.meta.changes>0,409,'管理员信息已变化，未执行重置');
  return json({ok:true,initialized:false},200,signedOut(request));
}
