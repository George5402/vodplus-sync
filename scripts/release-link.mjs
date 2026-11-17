// 发布前把真实公开仓库地址写入 README 部署按钮，不创建仓库或上传代码。
import {readFile,writeFile} from 'node:fs/promises';
const raw=process.argv[2];
if(!raw||!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(raw))throw new Error('用法：node scripts/release-link.mjs https://github.com/OWNER/REPO');
const repo=raw.replace(/\/$/,'').replace(/\.git$/,'');
const file=new URL('../README.md',import.meta.url);const content=await readFile(file,'utf8');
const button=`<!-- deploy-button:start -->\n[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(repo)})\n<!-- deploy-button:end -->`;
if(!content.includes('<!-- deploy-button:start -->'))throw new Error('README 部署区域不存在');
await writeFile(file,content.replace(/<!-- deploy-button:start -->[\s\S]*?<!-- deploy-button:end -->/,button));
console.log('已为指定仓库生成部署按钮；请自行确认仓库公开且包含本项目。');
