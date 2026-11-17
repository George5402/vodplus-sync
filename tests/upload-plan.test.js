// 文件重名避让保留原文件；覆盖使用原 ID/version 参与正常版本提交。
import {test} from 'node:test';import assert from 'node:assert/strict';
import {planUploads} from '../web/lib/upload-plan.js';
const rows=[{id:'original',kind:'file',path:'dir/a.py',version:8},{id:'folder',kind:'directory',path:'dir/name'}];
test('自动避让已有名称及同批次名称，比较不区分大小写',()=>{
  const plan=planUploads([{name:'A.py'},{name:'A.py'},{name:'name'}],rows,'dir','rename');assert.deepEqual(plan.map(p=>p.path),['dir/A (1).py','dir/A (2).py','dir/name (1)']);assert.ok(plan.every(p=>!p.existing));
});
test('覆盖指向原文件，重复输入及同名目录仍改名保护',()=>{
  const plan=planUploads([{name:'a.py'},{name:'a.py'},{name:'name'}],rows,'dir','overwrite');assert.equal(plan[0].existing.id,'original');assert.equal(plan[0].existing.version,8);assert.equal(plan[1].path,'dir/a (1).py');assert.equal(plan[2].path,'dir/name (1)');
});
test('根目录、隐藏文件和多个后缀保持正确文件名',()=>{
  const plan=planUploads([{name:'.hide'},{name:'.hide'},{name:'a.tar.gz'},{name:'a.tar.gz'}],[],'','rename');assert.deepEqual(plan.map(p=>p.path),['.hide','.hide (1)','a.tar.gz','a.tar (1).gz']);
});
