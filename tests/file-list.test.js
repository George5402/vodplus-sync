// 验证分层排序、默认折叠和搜索恢复，防止目录子项被排到别处。
import {test} from 'node:test';import assert from 'node:assert/strict';
import {fileList} from '../web/lib/file-list.js';
const rows=[
 {id:'a',kind:'file',path:'a.py',data:{size:1},updated:5},
 {id:'dir',kind:'directory',path:'z-dir',updated:1},
 {id:'sub',kind:'directory',path:'z-dir/z-sub',updated:2},
 {id:'f10',kind:'file',path:'z-dir/file10.py',data:{size:10},updated:3},
 {id:'f2',kind:'file',path:'z-dir/file2.py',data:{size:2},updated:4},
 {id:'deep',kind:'file',path:'z-dir/z-sub/deep.py',data:{size:8},updated:6}
];
test('默认只显示根目录及根文件，目录优先',()=>{assert.deepEqual(fileList(rows).entries.map(e=>e.row.id),['dir','a']);});
test('展开保留目录层级并在每一级目录优先、名称自然排序',()=>{
 const list=fileList(rows,{expanded:new Set(['dir','sub'])}).entries;
 assert.deepEqual(list.map(e=>e.row.id),['dir','sub','deep','f2','f10','a']);assert.deepEqual(list.map(e=>e.depth),[0,1,2,1,1,0]);
});
test('时间和大小排序不会打散父子关系，收起后恢复只显示根项',()=>{
 for(const sort of ['updated','size']){const entries=fileList(rows,{expanded:new Set(['dir','sub']),sort}).entries;assert.equal(entries[0].row.id,'dir');assert.equal(entries[1].row.id,'sub');assert.equal(entries[2].row.id,'deep');assert.equal(entries.at(-1).row.id,'a');}
 assert.deepEqual(fileList(rows,{expanded:new Set()}).entries.map(e=>e.row.id),['dir','a']);
});
test('搜索显示匹配路径的祖先，但不改变原展开状态',()=>{
 const expanded=new Set();const result=fileList(rows,{query:'DEEP',expanded});assert.deepEqual(result.entries.map(e=>e.row.id),['dir','sub','deep']);assert.equal(result.matches,1);assert.equal(expanded.size,0);assert.equal(fileList(rows,{expanded}).entries.length,2);
});
test('回收站缺少父目录时仍显示子项',()=>{const result=fileList([{...rows.at(-1),deleted:1}],{deleted:true});assert.equal(result.entries[0].row.id,'deep');assert.equal(result.entries[0].depth,0);});
