// 仅使用内存测试数据，验证改密失效会话与全量重置的原子性。
import {test} from 'node:test';import assert from 'node:assert/strict';
import {createHarness} from './harness.js';
const oldPassword='test-password-1234';
test('修改密码验证旧密码，接受 5 位新密码并注销旧会话',async()=>{
  const h=await createHarness();try{
    assert.equal((await h.request('/api/admin/account')).value.username,'admin');
    assert.equal((await h.request('/api/admin/account/password',{method:'POST',data:{currentPassword:'wrong',newPassword:'12345'}})).status,401);
    assert.equal((await h.request('/api/admin/account/password',{method:'POST',data:{currentPassword:oldPassword,newPassword:'1234'}})).status,400);
    assert.equal((await h.request('/api/admin/account/password',{method:'POST',data:{currentPassword:oldPassword,newPassword:'12345'}})).status,200);
    assert.equal((await h.request('/api/admin/overview')).status,401);
    assert.equal((await h.request('/api/login',{method:'POST',data:{username:'admin',password:oldPassword}})).status,401);
    assert.equal((await h.request('/api/login',{method:'POST',data:{username:'admin',password:'12345'}})).status,200);
  }finally{await h.dispose();}
});
test('匿名、错误密码或确认文字不能清空数据',async()=>{
  const h=await createHarness();try{
    await h.createUser('保留用户');
    const input={currentPassword:oldPassword,confirmation:'RESET'};
    assert.equal((await h.request('/api/admin/account/reset',{method:'POST',admin:false,data:input})).status,401);
    assert.equal((await h.request('/api/admin/account/reset',{method:'POST',data:{...input,currentPassword:'wrong'}})).status,401);
    assert.equal((await h.request('/api/admin/account/reset',{method:'POST',data:{...input,confirmation:'reset'}})).status,400);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM users').first()).n,1);
  }finally{await h.dispose();}
});
test('重置清空全部业务数据、失效设备凭证并重新开放管理员初始化',async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('待清空');const device=await h.bind(owner);await h.put(owner,'a.py','secret content');
    await h.request('/api/admin/shares',{method:'POST',data:{name:'分享',owner,root:'',password:''}});
    await h.request('/api/sync/device-config',{token:device.token});
    const result=await h.request('/api/admin/account/reset',{method:'POST',data:{currentPassword:oldPassword,confirmation:'RESET'}});assert.equal(result.status,200);assert.equal(result.value.initialized,false);
    for(const table of ['administrators','users','devices','bindings','device_config','entities','versions','changes','conflicts','receipts','file_contents','json_documents','shares','share_tokens','sessions','events','rate_limits','maintenance_actions'])assert.equal((await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n,0,table);
    assert.equal((await h.request('/api/status')).value.initialized,false);assert.equal((await h.request('/api/sync/settings',{token:device.token})).status,401);
    const settings=await h.db.prepare('SELECT * FROM sync_settings').first();assert.deepEqual(JSON.parse(settings.excluded_directories),['_cache','__pycache__','pycache']);
    assert.equal((await h.request('/api/setup',{method:'POST',data:{username:'new-admin',password:'12345'}})).status,200);
  }finally{await h.dispose();}
});
test('清空中途遇到数据库异常时整体回滚，不留下半清空状态',async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('完整保留');await h.put(owner,'a.py');
    await h.db.prepare("CREATE TRIGGER prevent_test_reset BEFORE DELETE ON file_contents BEGIN SELECT RAISE(ABORT,'test rollback'); END;").run();
    assert.equal((await h.request('/api/admin/account/reset',{method:'POST',data:{currentPassword:oldPassword,confirmation:'RESET'}})).status,500);
    assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM users').first()).n,1);assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM file_contents').first()).n,1);assert.equal((await h.request('/api/status')).value.initialized,true);
  }finally{await h.dispose();}
});
