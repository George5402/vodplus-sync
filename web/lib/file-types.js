// 后缀映射到本地文件类型 SVG，不根据用户输入构造资源路径。
const groups={
 python:['py','pyw','pyi','pyc'],javascript:['js','mjs','cjs','jsx'],json:['json','jsonc','json5'],php:['php','phtml'],java:['jar','java','class'],html:['html','htm','xhtml'],
 document:['txt','log','ini','conf'],markdown:['md','markdown'],css:['css','scss','sass','less'],xml:['xml','xsl'],yaml:['yaml','yml'],
 audio:['m3u','m3u8','mp3','aac','flac','ogg','wav'],video:['mp4','mkv','avi','mov','ts','webm'],image:['png','jpg','jpeg','webp','gif','bmp','ico','avif'],svg:['svg'],
 zip:['zip','rar','7z','gz','tar','bz2','xz'],pdf:['pdf'],database:['db','sqlite','sqlite3','sql'],table:['csv','tsv','xls','xlsx'],hex:['bin','dat','so','dll','exe','wasm']
};
const types=new Map(Object.entries(groups).flatMap(([type,extensions])=>extensions.map(extension=>[extension,type])));
const labels={python:'Python',javascript:'JavaScript',json:'JSON',php:'PHP',java:'Java / JAR',html:'HTML',document:'文本文件',markdown:'Markdown',css:'样式文件',xml:'XML',yaml:'YAML',audio:'音频 / 播放列表',video:'视频',image:'图片',svg:'SVG',zip:'压缩包',pdf:'PDF',database:'数据库',table:'表格',hex:'二进制文件'};
export const FILE_ICON_ASSETS=[...Object.keys(groups),'folder','folder-open'].map(name=>`file-icons/${name}.svg`);
export function extensionOf(path=''){const name=path.slice(path.lastIndexOf('/')+1);const dot=name.lastIndexOf('.');return dot<=0?'':name.slice(dot+1).toLowerCase();}
export function fileType(row,expanded=false){
  if(row.kind==='directory')return {src:`/file-icons/${expanded?'folder-open':'folder'}.svg`,label:expanded?'已展开的目录':'目录'};
  const extension=extensionOf(row.path);const type=extension?types.get(extension)||'document':'hex';
  return {src:`/file-icons/${type}.svg`,label:labels[type]};
}
