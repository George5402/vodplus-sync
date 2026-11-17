// 临时浏览器验收服务：仅监听回环，演示数据全部保存在内存，退出即销毁。
import { createServer } from 'node:http';
import { createHarness } from '../tests/harness.js';
import { buildStyles } from './styles.mjs';
buildStyles();
const setupOnly=process.argv.includes('--setup');
const h=await createHarness({assets:true,setup:!setupOnly});
for(const name of setupOnly?[]:['林女士','小满','父亲']){
  const owner=await h.createUser(name);const device=await h.bind(owner,name);
  await h.request(`/api/admin/devices/${device.deviceId}`,{method:'PATCH',data:{name:name==='林女士'?'客厅电视':name==='小满'?'学习平板':'父亲的手机'}});
  await h.request('/api/sync/device-config/report',{method:'POST',token:device.token,data:{sequence:1,appliedRevision:0,refreshRevision:0,values:{vod:'https://example.com/vod.json',live:'https://example.com/live.m3u8',theme:'system',wallpaper:''}}});
  for(const path of ['影视线路','直播配置'])await h.request(`/api/admin/spaces/${owner}/commit`,{method:'POST',data:{opId:crypto.randomUUID(),patch:{id:crypto.randomUUID(),kind:'directory',path,baseVersion:0}}});
  await h.put(owner,'影视线路/example.py','# 示例脚本，仅用于界面预览\nclass Spider:\n    def getName(self):\n        return "示例资源"\n');
  await h.put(owner,'直播配置/example.m3u8','#EXTM3U\n');
  if(name==='林女士'&&process.argv.includes('--file-types')){
    await h.request(`/api/admin/spaces/${owner}/commit`,{method:'POST',data:{opId:crypto.randomUUID(),patch:{id:crypto.randomUUID(),kind:'directory',path:'影视线路/子目录',baseVersion:0}}});
    await h.put(owner,'影视线路/子目录/deep.py','# 目录层级预览\n');
    for(const filename of ['file10.py','file2.py','config.json','loader.js','index.php','page.html','plugin.jar','notes.txt','data'])await h.put(owner,filename,filename.endsWith('.json')?'{}':'仅用于文件类型图标预览。');
  }
  if(name==='林女士')await h.request('/api/admin/shares',{method:'POST',data:{owner,name:'家庭点播',root:'影视线路',password:'preview-password-123'}});
}
if(!setupOnly)await h.put('public','example.js','// 公共示例，不包含真实来源。\nexport const name = "公共资源";\n');
const server=createServer(async(req,res)=>{
  try{
    const response=await h.mf.dispatchFetch('http://127.0.0.1:8799'+req.url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:req,duplex:'half'});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Preview error');}
});
server.listen(8799,'127.0.0.1',()=>console.log('PREVIEW_READY http://127.0.0.1:8799 (admin / test-password-1234)'));
async function close(){server.close();await h.dispose();process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);process.on('message',message=>{if(message==='stop')close();});
