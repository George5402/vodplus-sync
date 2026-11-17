// 全局后缀规则：仅约束人物空间新文件/新内容，历史读取与元数据操作保留。
import { assert, relativePath } from '../lib/http.js';
import { one } from '../lib/db.js';

export const DEFAULT_EXCLUDED_DIRECTORIES = ['_cache','__pycache__','pycache'];
export const settingsValue = row => ({ fileExtensions: JSON.parse(row.file_extensions), includeExtensionless: !!row.include_extensionless, excludedDirectories:row.excluded_directories===undefined?[...DEFAULT_EXCLUDED_DIRECTORIES]:JSON.parse(row.excluded_directories), revision: row.revision });
export async function syncSettings(env) { return settingsValue(await one(env, 'SELECT * FROM sync_settings WHERE id=1')); }
export function fileExtension(path) {
  const filename = path.slice(path.lastIndexOf('/') + 1);
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? '' : filename.slice(dot + 1).toLowerCase();
}
export function directoryExcluded(settings,path,kind='file') {
  const parts=path.split('/');if(kind!=='directory')parts.pop();
  const excluded=new Set((settings.excludedDirectories??DEFAULT_EXCLUDED_DIRECTORIES).map(value=>value.toLowerCase()));
  return parts.some(part=>excluded.has(part.toLowerCase()));
}
export function assertFileAllowed(settings, path, kind='file') {
  relativePath(path);
  assert(!directoryExcluded(settings,path,kind),422,'该目录及其子项不参与同步，已有内容会保留',{code:'DIRECTORY_EXCLUDED',revision:settings.revision});
  if(kind==='directory')return;
  const extension = fileExtension(path);
  assert(extension ? settings.fileExtensions.includes(extension) : settings.includeExtensionless, 422, '该文件类型不在当前同步规则中，已有文件会保留', { code: 'FILE_TYPE_NOT_ALLOWED', revision: settings.revision });
}
export async function updateSyncSettings(env, input) {
  assert(Array.isArray(input.fileExtensions) && input.fileExtensions.length <= 64, 400, '最多设置 64 个文件后缀');
  const extensions = [...new Set(input.fileExtensions.map(value => {
    assert(typeof value === 'string', 400, '文件后缀必须是字符串');
    const extension = value.trim().replace(/^\./, '').toLowerCase();
    assert(extension.length > 0 && extension.length <= 32 && !/[.\/\\\s\x00-\x1f:*?"<>|#%]/u.test(extension), 400, '后缀不能包含点、路径符或空白；例如 tar.gz 应填写 gz');
    return extension;
  }))];
  assert(typeof input.includeExtensionless === 'boolean', 400, 'includeExtensionless 必须是布尔值');
  assert(Number.isSafeInteger(input.revision) && input.revision >= 1, 400, '缺少设置版本');
  const current = await syncSettings(env);
  const rawDirectories=input.excludedDirectories??current.excludedDirectories;
  assert(Array.isArray(rawDirectories)&&rawDirectories.length<=64,400,'最多排除 64 个目录名');
  const excludedDirectories=[...new Set(rawDirectories.map(value=>{
    assert(typeof value==='string',400,'目录名必须是字符串');const directory=value.trim().toLowerCase();
    assert(directory.length<=100&&!directory.includes('/'),400,'请填写目录名，不要填写路径');relativePath(directory);return directory;
  }))];
  assert(input.revision === current.revision, 409, '同步规则已被修改，请重新打开设置');
  if (JSON.stringify(extensions) === JSON.stringify(current.fileExtensions) && input.includeExtensionless === current.includeExtensionless && JSON.stringify(excludedDirectories)===JSON.stringify(current.excludedDirectories)) return current;
  const result = await env.DB.prepare('UPDATE sync_settings SET file_extensions=?,include_extensionless=?,excluded_directories=?,revision=revision+1,updated=? WHERE id=1 AND revision=? RETURNING *').bind(JSON.stringify(extensions), input.includeExtensionless ? 1 : 0, JSON.stringify(excludedDirectories), Date.now(), input.revision).first();
  assert(result, 409, '同步规则已被修改，请重新打开设置');
  return settingsValue(result);
}
