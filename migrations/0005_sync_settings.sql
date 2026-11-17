-- 全局默认文件类型规则，修改不清理任何已有文件或变更记录。
CREATE TABLE sync_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 file_extensions TEXT NOT NULL,
 include_extensionless INTEGER NOT NULL CHECK(include_extensionless IN (0,1)),
 revision INTEGER NOT NULL,
 updated INTEGER NOT NULL
);
INSERT INTO sync_settings VALUES(1,'["py","js","txt","json","m3u8","jar","php","html"]',1,1,0);
