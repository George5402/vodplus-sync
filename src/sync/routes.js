// 设备增量接口与内容寻址上传；游标由客户端在落盘完成后确认。
import { assert, body, bytes, json } from '../lib/http.js';
import { digest } from '../lib/crypto.js';
import { all, one, run, event } from '../lib/db.js';
import { commit, cursor } from './store.js';
import { putContent, getContent } from '../storage/content.js';
import { syncSettings, assertFileAllowed } from './settings.js';
import {fileRow} from '../storage/catalog.js';

export async function upload(env, request, owner, hash) {
  assert(/^[a-f0-9]{64}$/.test(hash), 400, '摘要无效');
  const path = new URL(request.url).searchParams.get('path');
  if (owner !== 'public' && path !== null) assertFileAllowed(await syncSettings(env), path);
  const content = await bytes(request, 1572864);
  assert(await digest(content) === hash, 422, '内容 SHA-256 不匹配');
  await putContent(env, owner, hash, content);
  return json({ hash, size: content.length });
}
export async function download(env, owner, entityId, version) {
  if (version) assert(Number.isSafeInteger(Number(version)) && Number(version) > 0, 400, '版本号无效');
  const row = version ? await one(env, 'SELECT snapshot FROM changes WHERE owner=? AND entity_id=? AND version=? LIMIT 1', owner, entityId, Number(version)) : await fileRow(env,owner,entityId);
  const value = row?.snapshot ? JSON.parse(row.snapshot) : row;
  assert(value?.kind === 'file', 404, '文件版本不存在');
  const object = await getContent(env, owner, value.data.hash); assert(object, 404, '文件内容不存在');
  return new Response(object.body, { headers: { 'content-type': 'application/octet-stream', 'x-content-sha256': value.data.hash } });
}
export async function syncRoute(env, request, url, device) {
  const owner = device.user_id; const path = url.pathname; const principal = `device:${device.id}`;
  if (path === '/api/sync/settings' && request.method === 'GET') return json(await syncSettings(env));
  if (request.method === 'PUT' && path.startsWith('/api/sync/blobs/')) return upload(env, request, owner, path.split('/').pop());
  if (request.method === 'GET' && path.startsWith('/api/sync/files/')) return download(env, owner, path.split('/').pop(), url.searchParams.get('version'));
  if (path === '/api/sync/changes' && request.method === 'GET') {
    const after = Number(url.searchParams.get('cursor') || 0);
    const latest = await cursor(env, owner); const until = Number(url.searchParams.get('until') || latest);
    assert(Number.isSafeInteger(after) && after >= 0 && after <= latest && Number.isSafeInteger(until) && until >= after && until <= latest, 400, '游标无效，请使用该用户自己的游标');
    const rows = await all(env, 'SELECT seq,snapshot FROM changes WHERE owner=? AND seq>? AND seq<=? ORDER BY seq LIMIT 101', owner, after, until);
    const page = rows.slice(0,100);
    return json({ changes: page.map(r => ({ seq: r.seq, ...JSON.parse(r.snapshot) })), cursor: page.at(-1)?.seq ?? after, until, hasMore: rows.length > 100 });
  }
  if (path === '/api/sync/commit' && request.method === 'POST') {
    const input = await body(request);
    try { const result = await commit(env, owner, principal, input); await event(env, owner, device.id, '上传', input.patch.kind); return json(result); }
    catch (error) { await event(env, owner, device.id, '失败', error.status ? error.message : '存储异常'); throw error; }
  }
  if (path === '/api/sync/ack' && request.method === 'POST') {
    const input = await body(request); const head = await cursor(env, owner);
    assert(Number.isSafeInteger(input.cursor) && input.cursor >= 0 && input.cursor <= head, 400, '确认游标无效');
    await run(env, 'UPDATE devices SET cursor=MAX(cursor,?),status=? WHERE id=?', input.cursor, input.ok === false ? String(input.error || '同步失败').slice(0,300) : '同步成功', device.id);
    await event(env, owner, device.id, input.ok === false ? '失败' : '下载确认', `游标 ${input.cursor}`);
    return json({ ok: true, serverTime: Date.now() });
  }
  return null;
}
