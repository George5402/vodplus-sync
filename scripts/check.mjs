// 编译检查后端及每个前端入口，无网络部署副作用。
import { build } from 'esbuild';
await build({entryPoints:['src/worker.js','web/app.js','web/share.js','web/deploy.js','examples/sync-client.js','examples/sync-v2-client.js'],bundle:true,outdir:'dist/check',write:false,platform:'browser',format:'esm',loader:{'.sql':'text'},logLevel:'warning'});
console.log('模块与语法检查通过');
await build({entryPoints:['scripts/deploy.mjs'],bundle:true,write:false,platform:'node',format:'esm',packages:'external',logLevel:'warning'});
