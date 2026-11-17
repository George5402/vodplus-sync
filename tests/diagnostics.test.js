// 用实际 D1 元数据验证迁移诊断，不把缺失迁移当作所有 500 的默认原因。
import {test} from 'node:test';import assert from 'node:assert/strict';
import {createHarness} from './harness.js';
import {failureDetail,failureMessage,health} from '../src/diagnostics.js';

test('数据库读取、写入、容量及单次查询额度分别诊断，不泄露原始异常',async()=>{
  for(const [message,type] of [
    ['D1_ERROR: exceeded daily limit of rows read','read'],
    ['D1_ERROR: exceeded daily limit of rows written','write'],
    ['D1_ERROR: database size limit exceeded','storage'],
    ['Too many API requests by single Worker invocation','queries']
  ]){const detail=failureDetail(new Error(message));assert.deepEqual(detail,{code:'DATABASE_LIMIT',limitType:type});assert.ok(failureMessage(detail));}
  const error=new Error('D1_ERROR',{cause:new Error('exceeded daily limit of rows read')});
  const response=await health({DB:{prepare(){return {};},async batch(){throw error;}}});
  assert.equal(response.status,503);const result=await response.json();assert.equal(result.code,'DATABASE_LIMIT');assert.equal(result.limitType,'read');assert.ok(!JSON.stringify(result).includes('exceeded'));
});
test('完整数据库返回结构就绪，缺失设备配置表时精确报告相应迁移',async()=>{
  const h=await createHarness();try{
    let result=await h.request('/api/health',{admin:false});assert.equal(result.status,200);assert.equal(result.value.ok,true);assert.deepEqual(result.value.missingMigrations,[]);
    await h.db.prepare('DROP TABLE device_config').run();result=await h.request('/api/health',{admin:false});assert.equal(result.status,503);assert.deepEqual(result.value.missingMigrations,['0006_device_config.sql']);
  }finally{await h.dispose();}
});
test('失败响应提供诊断码和请求编号，不回显请求内容',async()=>{
  const h=await createHarness();try{
    const owner=await h.createUser('诊断测试');const device=await h.bind(owner);await h.db.prepare('DROP TABLE device_config').run();
    const result=await h.request('/api/sync/device-config',{token:device.token});assert.equal(result.status,500);assert.equal(result.value.detail.code,'SCHEMA_NOT_READY');assert.ok(result.value.detail.requestId);assert.ok(!JSON.stringify(result.value).includes(device.token));
  }finally{await h.dispose();}
});
