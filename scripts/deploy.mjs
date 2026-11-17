// 先确认 D1，再迁移同一数据库，全部成功后才发布 Worker。
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {execFileSync} from 'node:child_process';
import { parse, printParseErrorCode } from 'jsonc-parser';
import { createWrangler } from './deploy/wrangler.mjs';
import { provisionDatabase } from './deploy/database.mjs';
import { buildStyles } from './styles.mjs';

export async function deployProject({ root = fileURLToPath(new URL('../', import.meta.url)), runner, log = console.log } = {}) {
  const errors = [];
  const config = parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`Wrangler 配置无效：${printParseErrorCode(errors[0].error)}`);
  // 兼容首次部署页面生成过的旧配置；仅移除绑定，不删除账户内任何存储桶。
  delete config.r2_buckets;
  const configPath = join(root, `.wrangler-deploy-${randomUUID()}.json`);
  const invoke = runner || createWrangler(root, configPath, config.account_id);
  const execute = (args, options = {}) => invoke(args, { ...options, configPath });
  try {
    // 保持原有相对路径，临时配置始终与源码配置位于同一目录。
    await writeFile(configPath, JSON.stringify(config, null, 2), { flag: 'wx' });
    log('[1/3] 确认 D1 数据库，无需 R2');
    const resolved = await provisionDatabase(config, execute, log);
    await writeFile(configPath, JSON.stringify(resolved, null, 2));
    log('[2/3] 应用数据库迁移');
    await execute(['d1', 'migrations', 'apply', 'DB', '--remote'], { stream: true, configPath });
    log('[3/3] 发布 Worker');
    await execute(['deploy'], { stream: true, configPath });
  } finally {
    await unlink(configPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let revision='local';try{revision=execFileSync('git',['rev-parse','--short','HEAD'],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();}catch{}
  console.log(`[VodPlus Sync] source=${revision}; storage=D1-only; R2=disabled`);
  Promise.resolve().then(buildStyles).then(()=>deployProject()).catch(error => { console.error(`部署停止：${error.message}`); process.exitCode = 1; });
}
