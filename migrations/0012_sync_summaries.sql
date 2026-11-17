-- 以少量 JSON 行记录空间变化与设备确认状态，无变化时不复制逐项快照。
CREATE TABLE sync_heads (owner TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE device_sync_summaries (device TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TRIGGER sync_head_insert AFTER INSERT ON entities BEGIN
 INSERT INTO sync_heads(owner,state) VALUES(NEW.owner,
  CASE WHEN NEW.path IS NOT NULL THEN json_object('files',1,'data',json('{}'))
  ELSE json_object('files',0,'data',json_object(CASE WHEN NEW.kind='record' THEN json_extract(NEW.data,'$.namespace') ELSE 'legacy.'||NEW.kind END,1)) END)
 ON CONFLICT(owner) DO UPDATE SET state=CASE WHEN NEW.path IS NOT NULL
  THEN json_set(state,'$.files',COALESCE(json_extract(state,'$.files'),0)+1)
  ELSE json_set(state,'$.data.'||json_quote(CASE WHEN NEW.kind='record' THEN json_extract(NEW.data,'$.namespace') ELSE 'legacy.'||NEW.kind END),COALESCE(json_extract(state,'$.data.'||json_quote(CASE WHEN NEW.kind='record' THEN json_extract(NEW.data,'$.namespace') ELSE 'legacy.'||NEW.kind END)),0)+1) END;
END;
CREATE TRIGGER sync_head_update AFTER UPDATE ON entities BEGIN
 INSERT INTO sync_heads(owner,state) VALUES(NEW.owner,
  CASE WHEN NEW.path IS NOT NULL THEN json_object('files',1,'data',json('{}'))
  ELSE json_object('files',0,'data',json_object(CASE WHEN NEW.kind='record' THEN json_extract(NEW.data,'$.namespace') ELSE 'legacy.'||NEW.kind END,1)) END)
 ON CONFLICT(owner) DO UPDATE SET state=CASE WHEN NEW.path IS NOT NULL
  THEN json_set(state,'$.files',COALESCE(json_extract(state,'$.files'),0)+1)
  ELSE json_set(state,'$.data.'||json_quote(CASE WHEN NEW.kind='record' THEN json_extract(NEW.data,'$.namespace') ELSE 'legacy.'||NEW.kind END),COALESCE(json_extract(state,'$.data.'||json_quote(CASE WHEN NEW.kind='record' THEN json_extract(NEW.data,'$.namespace') ELSE 'legacy.'||NEW.kind END)),0)+1) END;
END;
CREATE TRIGGER reset_sync_summaries BEFORE INSERT ON maintenance_actions WHEN NEW.action='factory_reset' BEGIN
 DELETE FROM sync_heads;
 DELETE FROM device_sync_summaries;
END;
