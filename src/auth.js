// 管理员、设备和分享分别认证；无管理员时开放一次初始化。
import { assert, body, json, name, id } from './lib/http.js';
import { digest, equal, password, token, verify } from './lib/crypto.js';
import { one, run } from './lib/db.js';

export async function throttle(env, request, scope, limit = 15) {
  const key = await digest(`${scope}:${request.headers.get('cf-connecting-ip') || 'local'}`); const now = Date.now();
  const row = await env.DB.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END, expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END RETURNING count').bind(key, now + 600000, now, now).first();
  assert(row.count <= limit, 429, '尝试过于频繁，请十分钟后重试');
}
export function origin(request) {
  const from = request.headers.get('origin');
  assert(!from || from === new URL(request.url).origin, 403, '不接受跨站操作');
}
export async function admin(env, request) {
  origin(request);
  const raw = request.headers.get('cookie')?.match(/(?:^|; )vp_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  assert(raw && await one(env, 'SELECT hash FROM sessions WHERE hash=? AND expires>?', await digest(raw), Date.now()), 401, '请登录管理后台');
}
export async function device(env, request) {
  const raw = request.headers.get('authorization')?.replace(/^Bearer /, '');
  assert(raw && /^[a-f0-9]{64}$/.test(raw), 401, '设备凭证无效');
  const row = await one(env, 'SELECT d.* FROM devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=? AND d.revoked=0 AND u.enabled=1', await digest(raw));
  assert(row, 401, '设备已撤销或用户已停用');
  // 批量传文件时最多每 30 秒刷新一次活跃时间，鉴权仍逐请求执行。
  const now = Date.now();
  if (!row.last_seen || row.last_seen < now - 30000) await run(env, 'UPDATE devices SET last_seen=? WHERE id=? AND (last_seen IS NULL OR last_seen<?)', now, row.id, now - 30000);
  return row;
}
function cookie(request, value, age) { return `vp_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`; }
export async function authRoute(env, request, path) {
  if (path === '/api/status' && request.method === 'GET') return json({ initialized: !!await one(env, 'SELECT id FROM administrators') });
  if (path === '/api/logout' && request.method === 'POST') {
    await admin(env, request);
    const raw = request.headers.get('cookie').match(/vp_session=([a-f0-9]{64})/)[1];
    await run(env, 'DELETE FROM sessions WHERE hash=?', await digest(raw));
    return json({ ok: true }, 200, { 'set-cookie': cookie(request, '', 0) });
  }
  if (!['/api/setup','/api/login','/api/bind'].includes(path) || request.method !== 'POST') return null;
  origin(request); await throttle(env, request, path); const input = await body(request);
  if (path === '/api/bind') {
    const credential = token(); const deviceId = crypto.randomUUID(); const now = Date.now();
    assert(typeof input.code === 'string' && input.code.trim().length > 0 && input.code.length <= 256, 400, '请填写设备码');
    const hash = await digest(input.code.trim());
    // 设备创建与绑定码消费在同一事务内，失败不会烧掉绑定码。
    // 兼容旧请求中的 username 字段，但人物归属始终只由设备码确定。
    const deviceName = name(input.deviceName);
    const expectedUserId = input.expectedUserId === undefined ? null : id(input.expectedUserId);
    const results = await env.DB.batch([
      env.DB.prepare('SELECT b.user_id FROM bindings b JOIN users u ON u.id=b.user_id AND u.enabled=1 WHERE b.hash=? AND b.consumed=0 AND b.expires>? AND ? IS NOT NULL AND b.user_id<>?').bind(hash,now,expectedUserId,expectedUserId),
      env.DB.prepare('INSERT INTO devices(id,user_id,name,token_hash,last_seen) SELECT ?,b.user_id,?,?,? FROM bindings b JOIN users u ON u.id=b.user_id AND u.enabled=1 WHERE b.hash=? AND b.consumed=0 AND b.expires>? AND (? IS NULL OR b.user_id=?)').bind(deviceId, deviceName, await digest(credential), now, hash, now,expectedUserId,expectedUserId),
      env.DB.prepare('UPDATE bindings SET consumed=1 WHERE hash=? AND EXISTS(SELECT 1 FROM devices WHERE id=?)').bind(hash, deviceId),
      env.DB.prepare('SELECT d.user_id,u.name username FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=?').bind(deviceId)
    ]);
    assert(!results[0].results.length, 409, '设备码属于另一人物，原绑定保持不变', {code:'USER_MISMATCH'});
    assert(results[1].meta.changes === 1, 401, '设备码无效、已使用或过期，或所属用户已停用');
    const row = results[3].results[0];
    return json({ deviceId, userId: row.user_id, token: credential, username: row.username }, 201);
  }
  assert(typeof input.password === 'string' && input.password.length >= 5 && input.password.length <= 200, 400, '密码需要 5–200 个字符');
  if (path === '/api/setup') {
    assert(!await one(env, 'SELECT id FROM administrators'), 409, '管理员已经初始化');
    const result = await run(env, 'INSERT OR IGNORE INTO administrators(id,username,password) VALUES(1,?,?)', name(input.username), await password(input.password));
    assert(result.meta.changes === 1, 409, '管理员已经初始化');
  } else {
    const user = await one(env, 'SELECT * FROM administrators WHERE id=1');
    assert(user && equal(input.username, user.username) && await verify(input.password, user.password), 401, '用户名或密码错误');
  }
  const session = token(); await run(env, 'INSERT INTO sessions(hash,expires) VALUES(?,?)', await digest(session), Date.now() + 43200000);
  return json({ ok: true }, 200, { 'set-cookie': cookie(request, session, 43200) });
}
