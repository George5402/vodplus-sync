// 同步提交使用版本比较和事务回执；失败候选保留供管理员处理。
import { assert, id, relativePath, inside } from '../lib/http.js';
import { digest } from '../lib/crypto.js';
import { all, one, stmt, decode } from '../lib/db.js';
import { contentInfo } from '../storage/content.js';
import { readCommitContext } from './context.js';
import { assertFileAllowed } from './settings.js';
import {fileRows} from '../storage/catalog.js';
import {commitFile} from '../storage/file-commit.js';
import {namespace,dataKey} from '../generic/input.js';

export const recordRows=async(env,owner)=>(await all(env,'SELECT * FROM entities WHERE owner=? ORDER BY id',owner)).map(decode);
export const entities = async (env, owner) => [...await fileRows(env,owner),...await recordRows(env,owner)];
export const cursor = async (env, owner) => (await one(env, 'SELECT COALESCE(MAX(seq),0) value FROM changes WHERE owner=?', owner)).value;
const clean = row => ({ id: row.id, kind: row.kind, path: row.path, data: row.data, enabled: row.enabled, deleted: row.deleted });

export async function validate(env, owner, patch, current, allRows) {
  id(patch.id); assert(Number.isSafeInteger(patch.baseVersion) && patch.baseVersion >= 0, 400, '缺少有效基础版本');
  assert(['file','directory','history','progress','search','config','record'].includes(patch.kind), 400, '不支持的数据类型');
  assert(!current || current.kind === patch.kind, 400, '不能修改记录类型');
  const value = { id: patch.id, kind: patch.kind, path: null, data: patch.data ?? {}, enabled: patch.enabled === false || patch.enabled === 0 ? 0 : 1, deleted: patch.deleted ? 1 : 0 };
  assert(value.data && typeof value.data === 'object' && !Array.isArray(value.data), 400, 'data 必须是对象');
  if (patch.kind === 'file' || patch.kind === 'directory') {
    value.path = relativePath(patch.path);
    if (!value.deleted) {
      const parts = value.path.split('/'); parts.pop(); let prefix = '';
      for (const part of parts) {
        prefix += (prefix ? '/' : '') + part;
        assert(allRows.some(r => r.path === prefix && r.kind === 'directory' && !r.deleted), 409, '请先创建父目录');
      }
      assert(!allRows.some(r => !r.deleted && r.id !== value.id && r.path?.toLowerCase() === value.path.toLowerCase()), 409, '路径已存在（不区分大小写）');
    }
    if (patch.kind === 'file') {
      assert(/^[a-f0-9]{64}$/.test(value.data.hash) && Number.isSafeInteger(value.data.size) && value.data.size >= 0 && value.data.size <= 1572864, 400, '文件摘要或大小无效');
      const object = await contentInfo(env, owner, value.data.hash);
      assert(object && object.size === value.data.size, 400, '文件内容尚未完整上传');
      value.data = { hash: value.data.hash, size: value.data.size };
    } else value.data = {};
  } else {
    assert(value.kind==='record'?new TextEncoder().encode(JSON.stringify(value.data)).length<=16384:JSON.stringify(value.data).length<=16000, 413, '单条记录过大');
    assert(typeof value.data.key === 'string' && value.data.key.length > 0 && value.data.key.length <= 2000, 400, '记录需要稳定的跨设备 key');
    if(value.kind==='record'){
      namespace(value.data.namespace);assert(!value.data.namespace.startsWith('legacy.'),400,'数据分区使用了保留名称');dataKey(value.data.key);assert(Object.hasOwn(value.data,'value'),400,'缺少记录内容');
      assert(value.id===`record_${await digest(JSON.stringify([value.data.namespace,value.data.key]))}`,400,'记录定位字段不能修改');
    }else assert(value.id === `${value.kind}_${await digest(value.data.key)}`, 400, '记录 ID 必须由类型和稳定 key 的 SHA-256 组成');
    if (value.kind === 'progress' && !value.deleted) {
      assert(typeof value.data.sessionId === 'string' && value.data.sessionId.length <= 100 && Number.isSafeInteger(value.data.sequence) && value.data.sequence >= 0 && Number.isFinite(value.data.position) && value.data.position >= 0, 400, '播放会话或进度无效');
      assert(!current || current.deleted || current.data.sessionId !== value.data.sessionId || value.data.sequence > current.data.sequence, 409, '该播放会话的进度已经提交');
    }
  }
  return value;
}

export async function commit(env, owner, principal, input) {
  if(['file','directory'].includes(input.patch?.kind))return commitFile(env,owner,principal,input,validate);
  id(input.opId); assert(input.patch && typeof input.patch === 'object', 400, '缺少 patch');
  id(input.patch.id); assert(Number.isSafeInteger(input.patch.baseVersion) && input.patch.baseVersion >= 0, 400, '缺少有效基础版本');
  const fingerprint = await digest(JSON.stringify(input));
  // 只因空间游标前进而失败时重读；始终沿用客户端原 baseVersion，绝不自动覆盖。
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await attemptCommit(env, owner, principal, input, fingerprint);
    if (result) return result;
  }
  assert(false, 503, '同步空间暂时繁忙，请保留原操作稍后重试', { retryable: true, retryAfterMs: 1000 });
}
async function attemptCommit(env, owner, principal, input, fingerprint) {
  const checks = await env.DB.batch([
    stmt(env, 'SELECT * FROM receipts WHERE principal=? AND op_id=?', principal, input.opId),
    stmt(env, 'SELECT id FROM conflicts WHERE principal=? AND op_id=?', principal, input.opId)
  ]);
  const previous = checks[0].results[0];
  if (previous) { assert(previous.fingerprint === fingerprint, 409, '同一 opId 不能提交不同内容'); return JSON.parse(previous.result); }
  const oldConflict = checks[1].results[0];
  assert(!oldConflict, 409, '此操作已产生冲突，请处理后用新 opId 提交', { conflictId: oldConflict?.id });
  const { checkpoint, rows, current, total, policy } = await readCommitContext(env, owner, input.patch);
  assert(total < 5000 || current, 409, '当前空间已达 5000 条记录，请先归档');
  const checkPolicy = policy && !input.patch.deleted && (!current || (input.patch.kind==='file' && current.data.hash !== input.patch.data?.hash));
  if (checkPolicy) assertFileAllowed(policy, input.patch.path, input.patch.kind);
  const proposed = await validate(env, owner, input.patch, current, rows);
  const policyRevision = checkPolicy ? policy.revision : null;
  assert(!current?.deleted || proposed.deleted || input.restore === true, 409, '记录已删除，恢复需要显式 restore');
  let patches = [{ ...proposed, baseVersion: input.patch.baseVersion }];
  if (current?.kind === 'directory' && !current.deleted) {
    assert(!inside(proposed.path, current.path) || proposed.path === current.path, 400, '不能把目录移入自身');
    const descendants = rows.filter(r => r.id !== current.id && !r.deleted && r.path && inside(r.path, current.path));
    if (proposed.path !== current.path || proposed.deleted) patches.push(...descendants.map(r => ({ ...clean(r), path: proposed.path + r.path.slice(current.path.length), deleted: proposed.deleted, baseVersion: r.version })));
    assert(patches.length <= 80, 413, '一次目录操作最多处理 80 项，请分批移动子目录');
  }
  const now = Date.now(); const nonce = crypto.randomUUID();
  const snapshots = patches.map(p => ({ ...clean(p), version: p.baseVersion + 1, source: principal, updated: now }));
  for (const item of snapshots.filter(p => p.path && !p.deleted)) {
    assert(!rows.some(r => !r.deleted && r.path?.toLowerCase() === item.path.toLowerCase() && !snapshots.some(p => p.id === r.id)), 409, '目标路径已有文件');
  }
  const result = { items: snapshots };
  const statements = [stmt(env, `INSERT OR IGNORE INTO receipts(principal,op_id,fingerprint,nonce,result,created)
    SELECT ?,?,?,?,?,? WHERE (SELECT COALESCE(MAX(seq),0) FROM changes WHERE owner=?)=?
    AND COALESCE((SELECT version FROM entities WHERE owner=? AND id=?),0)=?
    AND (? IS NULL OR EXISTS(SELECT 1 FROM sync_settings WHERE id=1 AND revision=?))`,
  principal, input.opId, fingerprint, nonce, JSON.stringify(result), now, owner, checkpoint, owner, proposed.id, input.patch.baseVersion, policyRevision, policyRevision)];
  for (const p of snapshots) statements.push(stmt(env, `INSERT INTO entities(owner,id,kind,path,version,data,deleted,enabled,source,updated)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM receipts WHERE principal=? AND op_id=? AND nonce=?)
    ON CONFLICT(owner,id) DO UPDATE SET path=excluded.path,version=excluded.version,data=excluded.data,deleted=excluded.deleted,enabled=excluded.enabled,source=excluded.source,updated=excluded.updated`,
  owner, p.id, p.kind, p.path, p.version, JSON.stringify(p.data), p.deleted, p.enabled, principal, now, principal, input.opId, nonce));
  try { await env.DB.batch(statements); }
  catch (error) {
    if (!String(error).includes('UNIQUE constraint')) throw error;
    assert(false, 409, '移动后的路径已被其他文件占用');
  }
  const outcome = await env.DB.batch([
    stmt(env, 'SELECT * FROM receipts WHERE principal=? AND op_id=?', principal, input.opId),
    stmt(env, 'SELECT * FROM entities WHERE owner=? AND id=?', owner, proposed.id)
  ]);
  const receipt = outcome[0].results[0];
  if (receipt) { assert(receipt.fingerprint === fingerprint, 409, 'opId 内容不一致'); return JSON.parse(receipt.result); }
  const latest = decode(outcome[1].results[0]);
  if ((latest?.version || 0) === input.patch.baseVersion) return null;
  const conflictId = crypto.randomUUID();
  await stmt(env, 'INSERT OR IGNORE INTO conflicts(id,owner,principal,op_id,proposed,created) VALUES(?,?,?,?,?,?)', conflictId, owner, principal, input.opId, JSON.stringify(input), now).run();
  const saved = await one(env, 'SELECT id FROM conflicts WHERE principal=? AND op_id=?', principal, input.opId);
  assert(false, 409, '版本已变化，候选内容已保留', { conflictId: saved.id, current: latest });
}
