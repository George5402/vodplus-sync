-- 设备配置独立于人物数据，区分管理员指令、实际值与刷新回报。
CREATE TABLE device_config (
 device_id TEXT PRIMARY KEY REFERENCES devices(id),
 revision INTEGER NOT NULL DEFAULT 0,
 desired TEXT NOT NULL DEFAULT '{}',
 applied_revision INTEGER NOT NULL DEFAULT 0,
 reported TEXT,
 reported_at INTEGER,
 report_seq INTEGER NOT NULL DEFAULT 0,
 report_hash TEXT,
 refresh_revision INTEGER NOT NULL DEFAULT 0,
 reported_refresh_revision INTEGER NOT NULL DEFAULT 0,
 requested_at INTEGER,
 error TEXT NOT NULL DEFAULT ''
);
