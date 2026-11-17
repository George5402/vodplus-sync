// 管理人物、设备与文件；后台编辑和设备提交共用同一版本入口。
import { assert, body, id, json, name } from './lib/http.js';
import { digest, token } from './lib/crypto.js';
import { all, one, run, event } from './lib/db.js';
import { entities, commit,recordRows } from './sync/store.js';
import { download, upload } from './sync/routes.js';
import { copyContent, getContent } from './storage/content.js';
import { syncSettings, updateSyncSettings } from './sync/settings.js';
import {fileRows,Catalog,readCatalog} from './storage/catalog.js';

async function shareOverview(env){
  const shares=await all(env,"SELECT id,name,owner,root,root_id,enabled,created,CASE WHEN password='' THEN 0 ELSE 1 END password_required FROM shares ORDER BY created DESC");const catalogs=new Map();
  for(const share of shares){if(!share.root_id)continue;if(!catalogs.has(share.owner))catalogs.set(share.owner,new Catalog((await readCatalog(env,share.owner)).value));const model=catalogs.get(share.owner),item=model.byId(share.root_id);if(item)share.root=model.path(item);}
  return shares;
}

export async function ownerExists(env, owner) { assert(owner === 'public' || await one(env, 'SELECT id FROM users WHERE id=?', owner), 404, '人物不存在'); return owner; }
export async function adminRoute(env, request, url) {
  const path = url.pathname; const method = request.method;
  if (path === '/api/admin/sync-settings' && method === 'GET') return json(await syncSettings(env));
  if (path === '/api/admin/sync-settings' && method === 'PUT') return json(await updateSyncSettings(env, await body(request)));
  if (path === '/api/admin/overview' && method === 'GET') return json({
    users: await all(env, 'SELECT * FROM users ORDER BY created'),
    devices: await all(env, 'SELECT d.id,d.user_id,d.name,d.revoked,d.last_seen,d.cursor,d.status,u.name user_name FROM devices d JOIN users u ON d.user_id=u.id ORDER BY last_seen DESC'),
    events: await all(env, 'SELECT e.*,u.name user_name,d.name device_name FROM events e LEFT JOIN users u ON e.owner=u.id LEFT JOIN devices d ON e.device=d.id ORDER BY e.id DESC LIMIT 60'),
    shares: await shareOverview(env),
    conflicts: await one(env, 'SELECT COUNT(*) total FROM conflicts WHERE resolved=0'), serverTime: Date.now()
  });
  if (path === '/api/admin/copy' && method === 'POST') {
    const input = await body(request); const owner = await ownerExists(env, id(input.owner));
    assert(Number.isSafeInteger(input.sourceVersion) && input.sourceVersion > 0, 400, '复制需要固定源版本');
    const snapshot = await one(env, 'SELECT snapshot FROM changes WHERE owner=\'public\' AND entity_id=? AND version=? LIMIT 1', id(input.fileId), input.sourceVersion);
    const source = snapshot && JSON.parse(snapshot.snapshot);
    assert(source?.kind === 'file' && !source.deleted, 404, '公共文件版本不存在'); const data = source.data;
    await copyContent(env, 'public', owner, data.hash);
    const result = await commit(env, owner, `admin:${owner}`, { opId: id(input.opId), patch: { id: id(input.id), kind: 'file', path: input.path, baseVersion: 0, data, enabled: source.enabled } });
    await event(env, owner, null, '公共库复制', input.path); return json(result);
  }
  if (path === '/api/admin/users' && method === 'POST') {
    const input = await body(request); const userId = crypto.randomUUID();
    assert(!await one(env, 'SELECT id FROM users WHERE name=?', name(input.name)), 409, '用户名已经存在');
    await run(env, 'INSERT INTO users(id,name,created) VALUES(?,?,?)', userId, name(input.name), Date.now());
    return json({ id: userId }, 201);
  }
  const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)(\/binding)?$/);
  if (userMatch) {
    const userId = await ownerExists(env, id(userMatch[1]));
    if (userMatch[2] && method === 'POST') {
      assert((await one(env, 'SELECT enabled FROM users WHERE id=?', userId)).enabled, 409, '请先启用人物');
      const code = token(); const expires = Date.now() + 600000;
      await run(env, 'INSERT INTO bindings(hash,user_id,expires) VALUES(?,?,?)', await digest(code), userId, expires);
      return json({ code, expires });
    }
    if (method === 'PATCH') {
      const input = await body(request); const existing = await one(env, 'SELECT * FROM users WHERE id=?', userId);
      const newName = input.name === undefined ? existing.name : name(input.name);
      assert(!await one(env, 'SELECT id FROM users WHERE name=? AND id<>?', newName, userId), 409, '用户名已存在');
      await run(env, 'UPDATE users SET name=?,enabled=? WHERE id=?', newName, input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0, userId);
      return json({ ok: true });
    }
  }
  const deviceMatch = path.match(/^\/api\/admin\/devices\/([^/]+)$/);
  if (deviceMatch && method === 'PATCH') {
    const input = await body(request); const row = await one(env, 'SELECT * FROM devices WHERE id=?', id(deviceMatch[1]));
    assert(row, 404, '设备不存在');
    await run(env, 'UPDATE devices SET name=?,revoked=? WHERE id=?', input.name === undefined ? row.name : name(input.name), input.revoked ? 1 : row.revoked, row.id);
    return json({ ok: true });
  }
  const ownerMatch = path.match(/^\/api\/admin\/spaces\/([^/]+)\/(entities|commit|conflicts|conflict-file\/[^/]+|blobs\/[^/]+|files\/[^/]+|versions\/[^/]+|resolve\/[^/]+)$/);
  if (ownerMatch) {
    const owner = await ownerExists(env, ownerMatch[1]); const action = ownerMatch[2];
    if (action === 'entities' && method === 'GET') return json({ items: url.searchParams.get('kind')==='files'?await fileRows(env,owner):url.searchParams.get('kind')==='records'?await recordRows(env,owner):await entities(env, owner) });
    if (action === 'commit' && method === 'POST') {
      const result = await commit(env, owner, `admin:${owner}`, await body(request));
      await event(env, owner, null, '后台编辑', `${result.items.length} 项`); return json(result);
    }
    if (action.startsWith('blobs/') && method === 'PUT') return upload(env, request, owner, action.split('/')[1]);
    if (action.startsWith('files/') && method === 'GET') return download(env, owner, action.split('/')[1], url.searchParams.get('version'));
    if (action.startsWith('versions/') && method === 'GET') return json({ items: (await all(env, 'SELECT snapshot FROM versions WHERE owner=? AND entity_id=? ORDER BY version DESC', owner, action.split('/')[1])).map(r => JSON.parse(r.snapshot)) });
    if (action === 'conflicts' && method === 'GET') return json({ items: (await all(env, 'SELECT * FROM conflicts WHERE owner=? AND resolved=0 ORDER BY created DESC', owner)).map(r => ({ ...r, proposed: JSON.parse(r.proposed) })) });
    if (action.startsWith('conflict-file/') && method === 'GET') {
      const row = await one(env, 'SELECT proposed FROM conflicts WHERE owner=? AND id=?', owner, action.split('/')[1]);
      assert(row, 404, '冲突候选不存在'); const patch = JSON.parse(row.proposed).patch;
      assert(patch.kind === 'file', 400, '不是文件候选');
      const object = await getContent(env, owner, patch.data.hash); assert(object, 404, '候选内容不存在');
      return new Response(object.body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (action.startsWith('resolve/') && method === 'POST') {
      await run(env, 'UPDATE conflicts SET resolved=1 WHERE id=? AND owner=?', action.split('/')[1], owner); return json({ ok: true });
    }
  }
  return null;
}
