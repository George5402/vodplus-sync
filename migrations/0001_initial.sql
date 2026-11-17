-- 人物隔离、设备凭证、同步版本及只读发布；变更日志保留删除元数据。
PRAGMA foreign_keys = ON;
CREATE TABLE administrators (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password TEXT NOT NULL);
CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL);
CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, last_seen INTEGER, cursor INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT '等待同步');
CREATE TABLE bindings (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE entities (owner TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT, version INTEGER NOT NULL, data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(owner,id));
CREATE UNIQUE INDEX live_path ON entities(owner,path) WHERE deleted=0 AND path IS NOT NULL;
CREATE INDEX entity_kind ON entities(owner,kind);
CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, entity_id TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL, source TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX change_owner ON changes(owner,seq);
CREATE TABLE versions (owner TEXT NOT NULL, entity_id TEXT NOT NULL, version INTEGER NOT NULL, snapshot TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(owner,entity_id,version));
CREATE TABLE receipts (principal TEXT NOT NULL, op_id TEXT NOT NULL, fingerprint TEXT NOT NULL, nonce TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(principal,op_id));
CREATE TABLE conflicts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, principal TEXT NOT NULL, op_id TEXT NOT NULL, proposed TEXT NOT NULL, created INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, UNIQUE(principal,op_id));
CREATE TABLE shares (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, root TEXT NOT NULL, root_id TEXT, password TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL);
CREATE TABLE share_tokens (hash TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares(id), expires INTEGER NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, device TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, created INTEGER NOT NULL);

-- 触发器与元数据更新处于同一事务，避免已发布版本没有增量记录。
CREATE TRIGGER entity_insert AFTER INSERT ON entities BEGIN
 INSERT INTO versions VALUES(NEW.owner,NEW.id,NEW.version,json_object('id',NEW.id,'kind',NEW.kind,'path',NEW.path,'version',NEW.version,'data',json(NEW.data),'deleted',NEW.deleted,'enabled',NEW.enabled,'source',NEW.source,'updated',NEW.updated),NEW.updated);
 INSERT INTO changes(owner,entity_id,version,snapshot,source,created) SELECT NEW.owner,NEW.id,NEW.version,snapshot,NEW.source,NEW.updated FROM versions WHERE owner=NEW.owner AND entity_id=NEW.id AND version=NEW.version;
END;
CREATE TRIGGER entity_update AFTER UPDATE ON entities BEGIN
 INSERT INTO versions VALUES(NEW.owner,NEW.id,NEW.version,json_object('id',NEW.id,'kind',NEW.kind,'path',NEW.path,'version',NEW.version,'data',json(NEW.data),'deleted',NEW.deleted,'enabled',NEW.enabled,'source',NEW.source,'updated',NEW.updated),NEW.updated);
 INSERT INTO changes(owner,entity_id,version,snapshot,source,created) SELECT NEW.owner,NEW.id,NEW.version,snapshot,NEW.source,NEW.updated FROM versions WHERE owner=NEW.owner AND entity_id=NEW.id AND version=NEW.version;
 DELETE FROM versions WHERE owner=NEW.owner AND entity_id=NEW.id AND version < NEW.version-19;
END;
