-- 单语句触发原子清空；保留表结构和迁移记录，恢复默认同步规则。
CREATE TABLE maintenance_actions (action TEXT PRIMARY KEY CHECK(action='factory_reset'));
CREATE TRIGGER factory_reset AFTER INSERT ON maintenance_actions WHEN NEW.action='factory_reset' BEGIN
 DELETE FROM share_tokens;
 DELETE FROM shares;
 DELETE FROM device_config;
 DELETE FROM bindings;
 DELETE FROM devices;
 DELETE FROM users;
 DELETE FROM file_chunks;
 DELETE FROM file_contents;
 DELETE FROM conflicts;
 DELETE FROM receipts;
 DELETE FROM versions;
 DELETE FROM changes;
 DELETE FROM entities;
 DELETE FROM events;
 DELETE FROM sessions;
 DELETE FROM rate_limits;
 DELETE FROM sync_settings;
 INSERT INTO sync_settings(id,file_extensions,include_extensionless,revision,updated,excluded_directories)
 VALUES(1,'["py","js","txt","json","m3u8","jar","php","html"]',1,1,0,'["_cache","__pycache__","pycache"]');
 DELETE FROM administrators;
 DELETE FROM maintenance_actions;
END;
