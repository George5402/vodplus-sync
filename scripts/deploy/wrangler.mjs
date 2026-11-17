// 无 shell 调用固定版本 Wrangler，沿用其登录态，不读取或打印访问令牌。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
export function createWrangler(root, configPath, accountId) {
  return (args, { stream = false } = {}) => new Promise((resolve, reject) => {
    const env = { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' };
    if (!env.CLOUDFLARE_ACCOUNT_ID && accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
    const child = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--config', configPath], {
      cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; if (stream) process.stdout.write(data); });
    child.stderr.on('data', data => { stderr += data; if (stream) process.stderr.write(data); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Wrangler ${args.slice(0, 3).join(' ')} 失败（${code}）\n${stderr || stdout}`));
    });
  });
}
