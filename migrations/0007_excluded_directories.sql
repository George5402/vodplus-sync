-- 增加默认目录排除；提升规则版本促使设备重新核对，不删除已有内容。
ALTER TABLE sync_settings ADD COLUMN excluded_directories TEXT NOT NULL DEFAULT '["_cache","__pycache__","pycache"]';
UPDATE sync_settings SET revision=revision+1;
