-- 上传前比对摘要；未上传内容或比对后被改动的项目不能直接确认发布。
CREATE TABLE publish_checks (
 session TEXT NOT NULL, identity TEXT NOT NULL, type TEXT NOT NULL,
 namespace TEXT, key TEXT, path TEXT, hash TEXT NOT NULL, size INTEGER,
 entity_id TEXT, version INTEGER,
 PRIMARY KEY(session,identity)
);
CREATE TABLE device_contents (
 device TEXT NOT NULL, identity TEXT NOT NULL, type TEXT NOT NULL,
 namespace TEXT, key TEXT, path TEXT, entity_id TEXT NOT NULL, version INTEGER NOT NULL,
 PRIMARY KEY(device,identity)
);
CREATE TRIGGER reset_publish_checks BEFORE INSERT ON maintenance_actions WHEN NEW.action='factory_reset' BEGIN
 DELETE FROM publish_checks;
 DELETE FROM device_contents;
END;
