-- 保留的配置授权改为永久有效；已撤销的凭证不会恢复。
UPDATE share_tokens SET expires=0;
