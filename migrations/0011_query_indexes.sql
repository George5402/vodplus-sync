-- 按记录身份和文件路径查找，避免恢复确认及上传路径校验重复扫描空间。
CREATE INDEX entity_record_lookup ON entities(owner,CAST(json_extract(data,'$.namespace') AS TEXT),CAST(json_extract(data,'$.key') AS TEXT)) WHERE kind='record' AND deleted=0;
CREATE INDEX entity_path_lookup ON entities(owner,lower(path),deleted,updated DESC) WHERE path IS NOT NULL;
CREATE INDEX entity_disabled_directories ON entities(owner,path) WHERE kind='directory' AND deleted=0 AND enabled=0;
