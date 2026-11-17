-- 按文件与版本下载时直接命中索引，避免扫描该用户的全部变更记录。
CREATE INDEX change_entity_version ON changes(owner,entity_id,version);
CREATE INDEX entity_files ON entities(owner,path,id) WHERE path IS NOT NULL;
