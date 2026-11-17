// 仅清理过期凭证与短期运行日志，保留回执、墓碑及文件内容以支持离线设备。
export async function maintenance(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(now),
    env.DB.prepare('DELETE FROM bindings WHERE expires<?').bind(now),
    env.DB.prepare('DELETE FROM share_tokens WHERE expires>0 AND expires<?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires<?').bind(now),
    env.DB.prepare('DELETE FROM events WHERE created<?').bind(now - 30 * 86400000)
  ]);
  // 已确认基线与未确认的已知路径保留；过期传输包可丢弃，重启恢复会强制全量。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM json_documents WHERE key LIKE 'restore-files:%' AND substr(key,15) NOT IN(SELECT token FROM restore_sessions WHERE expires>=?)").bind(now),
    env.DB.prepare("DELETE FROM json_documents WHERE key LIKE 'publish-files:%' AND substr(key,15) NOT IN(SELECT token FROM publish_sessions WHERE expires>=?)").bind(now)
  ]);
  const expired='SELECT token FROM restore_sessions WHERE expires<? AND token NOT IN (SELECT session FROM restore_baselines)';
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM restore_items WHERE session IN (${expired})`).bind(now),
    env.DB.prepare(`DELETE FROM restore_snapshots WHERE session IN (${expired})`).bind(now),
    env.DB.prepare(`DELETE FROM restore_sessions WHERE token IN (${expired})`).bind(now)
  ]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM publish_checks WHERE session IN (SELECT token FROM publish_sessions WHERE expires<?)').bind(now),
    env.DB.prepare('DELETE FROM publish_items WHERE session IN (SELECT token FROM publish_sessions WHERE expires<?)').bind(now),
    env.DB.prepare('DELETE FROM publish_sessions WHERE expires<?').bind(now)
  ]);
}
