// 绑定链接只包含 HTTPS 服务根地址和一次性码，不携带身份或长期凭证。
export function bindingLinks(server, code) {
  const url = new URL(server);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('一键绑定需要 HTTPS 服务根地址');
  if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code)) throw new Error('设备码格式错误');
  const query = `server=${encodeURIComponent(url.origin)}&code=${encodeURIComponent(code)}`;
  return {
    direct: `vodplus://sync/bind?${query}`,
    android: `intent://sync/bind?${query}#Intent;scheme=vodplus;package=com.fongmi.vodplus;end`
  };
}
