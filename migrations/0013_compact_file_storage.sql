-- 文件存储重建：开发数据清空后使用 JSON 文档与原始 BLOB。
INSERT OR IGNORE INTO maintenance_actions(action) VALUES('factory_reset');
DROP TRIGGER IF EXISTS factory_reset;
DROP TABLE IF EXISTS file_chunks;
DROP TABLE IF EXISTS file_contents;
DROP TABLE IF EXISTS restore_sessions;
DROP INDEX IF EXISTS live_path;
DROP INDEX IF EXISTS entity_path_lookup;
DROP INDEX IF EXISTS entity_disabled_directories;
CREATE TABLE file_contents (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 owner TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 1572864),
 content BLOB NOT NULL, created INTEGER NOT NULL, UNIQUE(owner,hash)
);
CREATE TABLE json_documents (
 key TEXT NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL,
 revision INTEGER NOT NULL, meta TEXT NOT NULL, value TEXT NOT NULL,
 PRIMARY KEY(key,part)
);
CREATE TABLE storage_format (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
CREATE TABLE restore_sessions (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL,
 owner TEXT NOT NULL, device TEXT NOT NULL, request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, scope_hash TEXT NOT NULL, scope TEXT NOT NULL,
 mode TEXT NOT NULL, policy TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
 acknowledged INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
 data_count INTEGER NOT NULL DEFAULT 0, file_count INTEGER NOT NULL DEFAULT 0, file_page TEXT,
 UNIQUE(device,request_id)
);
CREATE INDEX restore_device_scope ON restore_sessions(device,scope_hash,acknowledged,seq);
CREATE TRIGGER reject_row_file_insert BEFORE INSERT ON entities WHEN NEW.kind IN ('file','directory') BEGIN
 SELECT RAISE(ABORT,'File metadata must use the JSON catalog');
END;
CREATE TRIGGER reject_row_file_update BEFORE UPDATE ON entities WHEN NEW.kind IN ('file','directory') BEGIN
 SELECT RAISE(ABORT,'File metadata must use the JSON catalog');
END;
CREATE TRIGGER factory_reset AFTER INSERT ON maintenance_actions WHEN NEW.action='factory_reset' BEGIN
 DELETE FROM share_tokens;
 DELETE FROM shares;
 DELETE FROM device_config;
 DELETE FROM bindings;
 DELETE FROM devices;
 DELETE FROM users;
 DELETE FROM json_documents;
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
INSERT OR REPLACE INTO storage_format(id,version) VALUES(1,13);
