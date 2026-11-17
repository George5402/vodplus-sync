-- 文件内容改存 D1；内部小块避免大行限制，客户端仍整文件上传。
CREATE TABLE file_contents (
 owner TEXT NOT NULL,
 hash TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 1572864),
 created INTEGER NOT NULL,
 PRIMARY KEY(owner,hash)
);
CREATE TABLE file_chunks (
 owner TEXT NOT NULL,
 hash TEXT NOT NULL,
 part INTEGER NOT NULL,
 content TEXT NOT NULL,
 PRIMARY KEY(owner,hash,part),
 FOREIGN KEY(owner,hash) REFERENCES file_contents(owner,hash)
);
