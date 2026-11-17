// 从项目自带迁移生成幂等补齐计划，普通访问不删除或覆盖已有业务数据。
export const MIGRATION_NAMES=[
  '0001_initial.sql','0002_d1_files.sql','0003_permanent_shares.sql','0004_sync_lookup.sql',
  '0005_sync_settings.sql','0006_device_config.sql','0007_excluded_directories.sql','0008_factory_reset.sql',
  '0009_generic_sync.sql','0010_publish_checks.sql','0011_query_indexes.sql','0012_sync_summaries.sql','0013_compact_file_storage.sql'
];

export function statements(sql){
  // 触发器中的分号属于同一条语句，不能拆开执行其中的清空指令。
  const triggers=[];
  const text=sql.replace(/^--.*$/gm,'').replace(/CREATE TRIGGER[\s\S]*?^END;/gm,trigger=>`__TRIGGER_${triggers.push(trigger)-1}__;`);
  return text.split(';').map(part=>part.trim()).filter(Boolean).map(part=>{
    const match=part.match(/^__TRIGGER_(\d+)__$/);return match?triggers[Number(match[1])]:part;
  });
}

export function repairPlan(migrations,{names,columns,applied,hasSettings,storageVersion=0}){
  names=new Set(names);
  const rebuilt=storageVersion>=13||applied.has('0013_compact_file_storage.sql');
  const plan=[];const missingColumn=!columns.has('excluded_directories');
  for(const {name,sql} of migrations){
    for(const statement of statements(sql)){
      const create=statement.match(/^CREATE (TABLE|UNIQUE INDEX|INDEX|TRIGGER) (\w+)/i);
      if(create){
        if(rebuilt&&((name==='0002_d1_files.sql')||(name==='0008_factory_reset.sql'&&create[2]==='factory_reset')||(name==='0009_generic_sync.sql'&&['restore_sessions','restore_device_scope'].includes(create[2]))||['live_path','entity_path_lookup','entity_disabled_directories'].includes(create[2])))continue;
        if(!names.has(create[2])||(name==='0013_compact_file_storage.sql'&&!rebuilt)){plan.push(statement.replace(/^CREATE (TABLE|UNIQUE INDEX|INDEX|TRIGGER) /i,'CREATE $1 IF NOT EXISTS '));names.add(create[2]);}
      }else if(name==='0013_compact_file_storage.sql'){
        if(statement.startsWith('INSERT OR REPLACE INTO storage_format')){if(storageVersion<13)plan.push(statement);}
        else if(!rebuilt){plan.push(statement);const dropped=statement.match(/^DROP (?:TABLE|TRIGGER|INDEX) IF EXISTS (\w+)/i);if(dropped)names.delete(dropped[1]);}
      }else if(/^PRAGMA foreign_keys/i.test(statement)){
        // D1 已启用外键；保留完整事务，不在请求内切换约束。
      }else if(name==='0005_sync_settings.sql'&&/^INSERT INTO sync_settings /i.test(statement)){
        if(!hasSettings)plan.push(statement.replace('INSERT INTO sync_settings','INSERT OR IGNORE INTO sync_settings(id,file_extensions,include_extensionless,revision,updated)'));
      }else if(name==='0007_excluded_directories.sql'){
        if(missingColumn)plan.push(statement);
      }else if(name==='0003_permanent_shares.sql'){
        // 新建表没有待调整行，跳过空更新，为首次状态请求保留查询额度。
        if(!applied.has(name)&&names.has('share_tokens'))plan.push(statement);
      }else{
        throw new Error(`Unsupported runtime migration: ${name}`);
      }
    }
  }
  const pending=migrations.map(migration=>migration.name).filter(name=>!applied.has(name));
  if(!names.has('d1_migrations'))plan.push('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
  // 与 Wrangler 共用迁移记录，之后正常部署不会重复建表或重复增加字段。
  if(pending.length)plan.push(`INSERT OR IGNORE INTO d1_migrations(name) VALUES ${pending.map(name=>`('${name}')`).join(',')}`);
  return plan;
}
