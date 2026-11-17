// 开发入口先编译样式，再把终端交给 Wrangler。
import { spawn } from 'node:child_process';
import { buildStyles } from './styles.mjs';
buildStyles();
const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev'],{stdio:'inherit',shell:false,windowsHide:true});
child.on('exit',code=>{process.exitCode=code??1;});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
process.on('SIGINT',()=>child.kill());process.on('SIGTERM',()=>child.kill());
