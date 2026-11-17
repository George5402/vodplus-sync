// 跨语言内容摘要：对象键排序、数值使用 IEEE754，避免 JSON 文本格式影响比对。
const encoder=new TextEncoder();
function stringPart(value){
  for(let i=0;i<value.length;i++){
    const unit=value.charCodeAt(i);
    if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new TypeError('字符串包含无效 Unicode');}
    else if(unit>=0xdc00&&unit<=0xdfff)throw new TypeError('字符串包含无效 Unicode');
  }
  return `s${encoder.encode(value).length}:${value}`;
}
export function canonicalValue(value){
  if(value===null)return 'n';
  if(typeof value==='boolean')return value?'t':'f';
  if(typeof value==='string')return stringPart(value);
  if(typeof value==='number'){
    if(!Number.isFinite(value))throw new TypeError('数字必须为有限值');
    const bytes=new Uint8Array(8);new DataView(bytes.buffer).setFloat64(0,value===0?0:value,false);
    return 'd'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  }
  if(Array.isArray(value))return `a${value.length}:`+value.map(canonicalValue).join('');
  if(value&&typeof value==='object'){
    const keys=Object.keys(value).sort();return `o${keys.length}:`+keys.map(key=>stringPart(key)+canonicalValue(value[key])).join('');
  }
  throw new TypeError('内容必须为 JSON 值');
}
export async function bytesDigest(bytes){
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export const valueDigest=value=>bytesDigest(encoder.encode(canonicalValue(value)));
export const bytesFingerprint=async bytes=>(await bytesDigest(bytes)).slice(0,32);
export const valueFingerprint=async value=>(await valueDigest(value)).slice(0,32);
