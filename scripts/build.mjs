// 构建样式并检查 Worker 打包，不发布线上资源。
import { spawnSync } from 'node:child_process';
import { buildStyles } from './styles.mjs';
buildStyles();
const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--outdir','dist'],{stdio:'inherit',shell:false,windowsHide:true});
if(result.error)throw result.error;process.exitCode=result.status??1;
