// 通用协议只约束名称、相对路径和包大小，不解释 JSON 中的业务字段。
import {assert,relativePath} from '../lib/http.js';
export function namespace(value){
  assert(typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value),400,'数据分区名称无效');return value;
}
export function requestId(value){
  assert(typeof value==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(value),400,'缺少本次操作标记');return value;
}
export function dataKey(value){
  assert(typeof value==='string'&&value.length>0&&value.length<=2000&&!/[\x00-\x1f]/.test(value),400,'记录名称为空或过长');return value;
}
export function scopeValue(value){
  assert(value&&Array.isArray(value.namespaces)&&value.namespaces.length<=32,400,'请指定要恢复的数据分区');
  assert(value.files===undefined||typeof value.files==='boolean',400,'files 必须是布尔值');
  const names=[...new Set(value.namespaces.map(namespace))].sort();
  const files=value.files===true;const raw=files?(value.roots??['']):[];
  assert(Array.isArray(raw)&&raw.length<=32&&(!files||raw.length>0),400,'文件范围无效');
  const roots=[...new Set(raw.map(path=>path===''?'':relativePath(path)))].sort();
  assert(names.length||files,400,'至少选择一种恢复范围');
  return {namespaces:names,files,roots:roots.filter(path=>!roots.some(parent=>parent!==path&&(!parent||path.startsWith(parent+'/'))))};
}
