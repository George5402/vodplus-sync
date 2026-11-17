// 本地编译 Tailwind，生产页面不加载 CDN 或运行时 CSS 编译器。
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export function buildStyles() {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const cli=fileURLToPath(new URL('../node_modules/@tailwindcss/cli/dist/index.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[cli,'-i','styles/index.css','-o','web/styles.css','--minify'],{cwd:root,shell:false,windowsHide:true,stdio:'inherit'});
  if(result.error)throw result.error;if(result.status!==0)throw new Error('Tailwind CSS 编译失败');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)buildStyles();
