// 重试时复用已创建的 D1，绑定不存在或无权限时停止，不悄悄切换数据库。
export async function provisionDatabase(input, run, log = console.log) {
  const config = structuredClone(input);
  const binding = config.d1_databases?.find(item => item.binding === 'DB');
  if (!binding) throw new Error('配置缺少 DB 绑定');
  if (!binding.database_id && !binding.database_name) binding.database_name = `${config.name}-db`;
  const find = async () => {
    const rows = JSON.parse(await run(['d1', 'list', '--json']));
    if (!Array.isArray(rows) || rows.some(row => !row.uuid || !row.name)) throw new Error('无法识别 D1 列表');
    return rows.find(row => binding.database_id ? row.uuid === binding.database_id : row.name === binding.database_name);
  };
  let database = await find();
  if (!database && binding.database_id) throw new Error('配置的 D1 ID 不存在或不可访问，请核对账户；不会创建替代数据库');
  if (!database) {
    log(`创建 D1：${binding.database_name}`);
    try {
      await run(['d1', 'create', binding.database_name, '--update-config=false', ...(binding.jurisdiction ? ['--jurisdiction', binding.jurisdiction] : [])]);
    } catch (error) {
      // 只有重新查到同名资源，才允许把并发创建的冲突当作成功。
      database = await find(); if (!database) throw error;
    }
    database ||= await find();
    if (!database) throw new Error('创建后未查到 D1，请稍后重新部署');
  }
  if (binding.jurisdiction) {
    const info = JSON.parse(await run(['d1', 'info', database.uuid, '--json']));
    if (info.jurisdiction !== binding.jurisdiction) throw new Error('D1 jurisdiction 与配置不一致');
  }
  binding.database_id = database.uuid;
  binding.database_name = database.name;
  log(`使用 D1：${database.name}（${database.uuid}）`);
  return config;
}
