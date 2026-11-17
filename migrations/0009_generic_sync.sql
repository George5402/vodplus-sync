-- 通用恢复会话固定云端快照；设备仅在成功应用后确认，历史文件仍共用 D1。
CREATE TABLE restore_sessions (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL,
 owner TEXT NOT NULL, device TEXT NOT NULL, request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, scope_hash TEXT NOT NULL, scope TEXT NOT NULL,
 mode TEXT NOT NULL, policy TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
 acknowledged INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
 UNIQUE(device,request_id)
);
CREATE INDEX restore_device_scope ON restore_sessions(device,scope_hash,acknowledged,seq);
CREATE TABLE restore_snapshots (
 session TEXT NOT NULL, identity TEXT NOT NULL, type TEXT NOT NULL,
 namespace TEXT, key TEXT, path TEXT, value TEXT, hash TEXT, size INTEGER,
 version INTEGER NOT NULL, PRIMARY KEY(session,identity)
);
CREATE TABLE restore_items (
 session TEXT NOT NULL, position INTEGER NOT NULL, marker TEXT NOT NULL,
 type TEXT NOT NULL, op TEXT NOT NULL, namespace TEXT, key TEXT, path TEXT,
 value TEXT, hash TEXT, size INTEGER, PRIMARY KEY(session,position), UNIQUE(session,marker)
);
CREATE TABLE restore_baselines (
 device TEXT NOT NULL, scope_hash TEXT NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL,
 dirty INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(device,scope_hash)
);
CREATE TABLE restore_known (
 device TEXT NOT NULL, scope_hash TEXT NOT NULL, identity TEXT NOT NULL,
 type TEXT NOT NULL, namespace TEXT, key TEXT, path TEXT,
 PRIMARY KEY(device,scope_hash,identity)
);
CREATE TABLE publish_sessions (
 token TEXT PRIMARY KEY, device TEXT NOT NULL, owner TEXT NOT NULL,
 request_id TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL,
 finished INTEGER NOT NULL DEFAULT 0, UNIQUE(device,request_id)
);
CREATE TABLE publish_items (
 session TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(session,identity)
);
CREATE TRIGGER reset_generic_sync BEFORE INSERT ON maintenance_actions WHEN NEW.action='factory_reset' BEGIN
 DELETE FROM restore_baselines;
 DELETE FROM restore_known;
 DELETE FROM restore_items;
 DELETE FROM restore_snapshots;
 DELETE FROM restore_sessions;
 DELETE FROM publish_items;
 DELETE FROM publish_sessions;
END;
