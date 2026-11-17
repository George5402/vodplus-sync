// 统一响应、输入限制和错误，避免向客户端泄露内部异常。
export class Fault extends Error {
  constructor(status, message, detail) { super(message); this.status = status; this.detail = detail; }
}
export function assert(value, status, message, detail) { if (!value) throw new Fault(status, message, detail); }
export const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
export async function bytes(request, limit) {
  assert(Number(request.headers.get('content-length') || 0) <= limit, 413, '内容超过大小限制');
  const reader = request.body?.getReader(); const chunks = []; let size = 0;
  if (!reader) return new Uint8Array();
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Fault(413, '内容超过大小限制'); }
    chunks.push(value);
  }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export async function body(request, limit = 128 * 1024) {
  assert(request.headers.get('content-type')?.startsWith('application/json'), 415, '请使用 application/json');
  try { const value = JSON.parse(new TextDecoder().decode(await bytes(request, limit))); assert(value && typeof value === 'object' && !Array.isArray(value), 400, '请求必须是 JSON 对象'); return value; }
  catch (error) { if (error instanceof Fault) throw error; throw new Fault(400, 'JSON 格式错误'); }
}
export function name(value, max = 80) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value), 400, '名称为空或过长');
  return value.trim();
}
export function id(value) { assert(typeof value === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(value), 400, 'ID 格式错误'); return value; }
export function relativePath(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 500 && value === value.normalize('NFC'), 400, '相对路径无效');
  assert(!/[\\:\x00-\x1f<>"|?*%]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..' && !/[ .]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)), 400, '路径必须是安全的相对路径');
  return value;
}
export const inside = (path, root) => !root || path === root || path.startsWith(root + '/');
export function secure(response) {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store'); headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer'); headers.set('x-frame-options', 'DENY');
  headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return new Response(response.body, { status: response.status, headers });
}
