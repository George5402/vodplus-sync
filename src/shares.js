// 发布只读目录，可公开或设密码；授权链接永久有效，主动改密码时撤销。
import { assert, body, json, name, relativePath, inside } from './lib/http.js';
import { digest, password, token, verify } from './lib/crypto.js';
import { all, one, run } from './lib/db.js';
import { throttle } from './auth.js';
import { ownerExists } from './admin.js';
import {fileRows,fileRow} from './storage/catalog.js';
import { getContent } from './storage/content.js';

async function issue(env, share, base) {
  const url = `${base}/share/${share.id}/index.json`;
  if (!share.password) return { token: null, expires: null, url };
  const raw = token();
  await run(env, 'INSERT INTO share_tokens(hash,share_id,expires) VALUES(?,?,0)', await digest(raw), share.id);
  return { token: raw, expires: null, url: `${url}?token=${raw}` };
}
function validPassword(value) {
  assert(typeof value === 'string' && (value.length === 0 || value.length >= 5) && value.length <= 200, 400, '分享密码可留空，设置时需要 5–200 个字符');
}
export async function manageShare(env, request, url) {
  if (url.pathname === '/api/admin/shares' && request.method === 'POST') {
    const input = await body(request); await ownerExists(env, input.owner);
    input.password ??= ''; validPassword(input.password);
    const root = input.root ? relativePath(input.root) : '';
    const directory = root ? (await fileRows(env, input.owner)).find(r => r.path === root && r.kind === 'directory' && !r.deleted) : null;
    if (root) assert(directory, 400, '发布目录不存在');
    const shareId = crypto.randomUUID();
    await run(env, 'INSERT INTO shares(id,name,owner,root,root_id,password,created) VALUES(?,?,?,?,?,?,?)', shareId, name(input.name), input.owner, root, directory?.id || null, input.password ? await password(input.password) : '', Date.now());
    return json({ id: shareId, entry: `${url.origin}/s/${shareId}` }, 201);
  }
  const match = url.pathname.match(/^\/api\/admin\/shares\/([^/]+)(\/token)?$/);
  if (!match) return null;
  const share = await one(env, 'SELECT * FROM shares WHERE id=?', match[1]); assert(share, 404, '接口不存在');
  if (match[2] && request.method === 'POST') { assert(share.enabled, 409, '接口已停用'); return json(await issue(env, share, url.origin)); }
  if (request.method === 'PATCH') {
    const input = await body(request);
    if (input.password !== undefined) validPassword(input.password);
    const nextPassword = input.password === undefined ? share.password : input.password ? await password(input.password) : '';
    const statements = [env.DB.prepare('UPDATE shares SET name=?,enabled=?,password=? WHERE id=?').bind(input.name === undefined ? share.name : name(input.name), input.enabled === undefined ? share.enabled : input.enabled ? 1 : 0, nextPassword, share.id)];
    if (input.password !== undefined || input.revokeTokens === true) statements.push(env.DB.prepare('DELETE FROM share_tokens WHERE share_id=?').bind(share.id));
    await env.DB.batch(statements);
    return json({ ok: true });
  }
  return null;
}
export function publicFiles(rows, root) {
  const blocked = rows.filter(r => r.kind === 'directory' && !r.deleted && !r.enabled).map(r => r.path);
  return rows.filter(r => r.kind === 'file' && !r.deleted && r.enabled && inside(r.path, root) && !blocked.some(p => inside(r.path, p)));
}
export async function shareRoute(env, request, url) {
  const match = url.pathname.match(/^\/share\/([^/]+)\/(.+)$/); if (!match) return null;
  const share = await one(env, 'SELECT * FROM shares WHERE id=? AND enabled=1', match[1]); assert(share, 404, '分享不存在或已停用');
  if (share.owner !== 'public') assert(await one(env, 'SELECT id FROM users WHERE id=? AND enabled=1', share.owner), 404, '分享已停用');
  if (share.root_id) {
    const directory = await fileRow(env,share.owner,share.root_id);
    assert(directory && !directory.deleted && directory.enabled, 404, '发布目录已删除或停用');
    share.root = directory.path;
  }
  if (match[2] === 'info' && request.method === 'GET') return json({ name: share.name, passwordRequired: !!share.password, url: share.password ? null : `${url.origin}/share/${share.id}/index.json` });
  if (match[2] === 'auth' && request.method === 'POST') {
    await throttle(env, request, `share:${share.id}`); const input = await body(request);
    if (share.password) assert(typeof input.password === 'string' && input.password.length <= 200 && await verify(input.password, share.password), 401, '分享密码错误');
    return json(await issue(env, share, url.origin));
  }
  assert(request.method === 'GET', 405, '分享只允许读取');
  const raw = url.searchParams.get('token') || request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (share.password) assert(raw && await one(env, 'SELECT hash FROM share_tokens WHERE hash=? AND share_id=? AND (expires=0 OR expires>?)', await digest(raw), share.id, Date.now()), 401, '需要分享密码授权', { authUrl: `/share/${share.id}/auth` });
  const rows = publicFiles(await fileRows(env, share.owner), share.root);
  const link = suffix => `${url.origin}/share/${share.id}/${suffix}${share.password ? `?token=${encodeURIComponent(raw)}` : ''}`;
  const fileUrl = file => link(`files/${file.id}/${encodeURIComponent(file.path.split('/').pop())}`);
  const scripts = rows.filter(r => /\.(py|js|php)$/i.test(r.path) && !/(^|\/)直播配置\//.test(r.path));
  const sites = list => list.map(r => ({ key: r.id, name: r.path.split('/').pop().replace(/\.[^.]+$/, ''), type: 3, api: fileUrl(r), searchable: 1, quickSearch: 1, filterable: 1 }));
  const parent = r => r.path.includes('/') ? r.path.slice(0,r.path.lastIndexOf('/')) : '';
  const groups = [...new Set(scripts.map(parent))];
  const configs = rows.filter(r => /\.json$/i.test(r.path) && !/(^|\/)直播配置\//.test(r.path));
  const lives = rows.filter(r => /(^|\/)直播配置\//.test(r.path) && /\.(txt|m3u|m3u8|json)$/i.test(r.path)).map(r => ({ name: r.path.split('/').pop(), type: 0, url: fileUrl(r) }));
  if (match[2] === 'index.json') {
    if (!configs.length && groups.length <= 1) return json({ sites: sites(scripts), lives });
    return json({ urls: [
      ...groups.map(p => ({ name: p === share.root ? '默认线路' : p.slice(share.root.length).replace(/^\//,''), url: link(`line/${encodeURIComponent(p)}`) })),
      ...configs.map(r => ({ name: r.path.split('/').pop().replace(/\.json$/i,''), url: fileUrl(r) }))
    ], lives });
  }
  if (match[2].startsWith('line/')) { const group = decodeURIComponent(match[2].slice(5)); return json({ sites: sites(scripts.filter(r => parent(r) === group)), lives }); }
  const fileMatch = match[2].match(/^files\/([^/]+)\/[^/]+$/);
  assert(fileMatch, 404, '接口不存在'); const file = rows.find(r => r.id === fileMatch[1]); assert(file, 404, '文件不在发布范围或已停用');
  const object = await getContent(env, share.owner, file.data.hash); assert(object, 404, '内容不存在');
  if (/\.json$/i.test(file.path)) {
    let config; try { config = JSON.parse(await object.text()); } catch { assert(false, 422, '配置 JSON 无法解析'); }
    const pathKeys = new Set(['api','url','spider','ext','jsPath','path','file','logo','wallpaper']);
    const rewrite = (value, key = '') => {
      if (Array.isArray(value)) return value.map(v => rewrite(v, key));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,rewrite(v,k)]));
      if (typeof value !== 'string' || /^(https?:|data:)/i.test(value)) return value;
      const explicit = /^(\.\.?\/|local:\/\/)/.test(value);
      if (!explicit && !pathKeys.has(key)) return value;
      const path = value.startsWith('local://') ? value.slice(8) : new URL(value, `https://local/${file.path}`).pathname.slice(1);
      let decoded; try { decoded = decodeURIComponent(path); } catch { assert(false, 422, '配置引用的路径编码无效'); }
      const target = rows.find(r => r.path === decoded);
      if (target) return fileUrl(target);
      assert(!explicit, 422, '配置引用了发布范围以外或已停用的文件'); return value;
    };
    return json(rewrite(config));
  }
  return new Response(object.body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
