# 部署指南

部署需要 Cloudflare 和 GitHub 账号。项目使用一个 Worker 提供接口与管理页面，一个 D1 数据库保存业务数据和文件内容。

**存储重建会清空业务数据。** 当前重建迁移 `0013_compact_file_storage.sql` 会建立空的 JSON 清单与 BLOB 存储；部署到有数据的数据库前，应先导出需要保留的内容。重建后重新创建管理员和用户、绑定设备。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2F0o755%2Fvodplus-sync)

1. 打开部署页面，连接 GitHub。
2. 按页面提示创建部署仓库，填写 Worker 名称。
3. 为 `DB` 选择新建或已有的 D1 数据库，位置可保持 Automatic。
4. 确认下面的构建配置，点击部署。
5. 打开部署生成的服务地址，创建管理员账号。

| 配置项 | 值 |
| --- | --- |
| 根目录 | 仓库根目录 |
| 构建命令 | `npm run build` |
| 部署命令 | `npm run deploy` |
| 数据库绑定 | `DB` |
| 静态资源绑定 | `ASSETS` |

管理员密码为 5–200 个字符。数据库已经有管理员时，使用该账号登录。

## 连接现有仓库

已经创建服务时，在 Cloudflare 的 **Workers 和 Pages → 目标 Worker → 设置 → 构建** 中连接仓库，选择生产分支，并填写上述命令。

之后向关联分支推送代码即可自动发布。首次部署按钮用于创建服务；日常更新直接使用已有 Worker 的构建功能。

## 部署过程

部署脚本按顺序完成：

1. 根据数据库 ID 或名称查找 D1，必要时创建数据库。
2. 应用数据库结构变更。
3. 使用同一数据库配置发布 Worker。
4. 清理本次部署的临时配置。

存储格式建立后，常规代码发布保留管理员和业务数据。格式标记与迁移记录会阻止重复重建；首次 API 请求会检查并补齐所需结构。

## 验证服务

访问 `GET /api/health`：

```json
{
  "ok": true,
  "requiredSchema": 13,
  "syncApi": 2,
  "capabilities": ["push-check","device-held-content","compact-sync-state","json-file-catalog","blob-files","fingerprint-128"],
  "automaticMigration": true,
  "code": "OK",
  "missingMigrations": []
}
```

`ok: true` 表示数据库结构就绪。该接口只读；打开管理页面会触发正常的初始化检查。

## 自定义域名

在 Worker 的 **设置 → 域和路由 → 添加 → 自定义域** 中，选择已接入 Cloudflare 的域名。配置完成后，通过 HTTPS 访问，并将客户端的服务器地址设置为该域名。

域名可用性受 DNS、网络运营商和访问地区影响，部署后应在目标网络实际测试。

## 本地开发与命令行部署

需要 Node.js 22 或以上版本。

```sh
npm ci --ignore-scripts
npm run dev
```

发布到自己的 Cloudflare 账号：

```sh
npx wrangler login
npm run deploy
```

数据库配置位于 [wrangler.jsonc](../wrangler.jsonc)。指定数据库 ID 后，部署脚本会核对该数据库，不会在 ID 无效时改用其他数据库。

## 免费额度与容量

Cloudflare D1 免费计划的主要额度：

| 项目 | 额度 |
| --- | --- |
| 单数据库大小 | 500 MB |
| 账号总存储 | 5 GB |
| 每日读取 | 500 万行 |
| 每日写入 | 10 万行 |

依据：[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)与 [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)。额度和套餐以 Cloudflare 公布的内容为准。

项目单文件限制为 1.5 MiB，每份正文存为一行原始 BLOB。目录清单、文件比对状态和文件恢复快照保存为 JSON，通常一份文档只占一行；文档超过安全行大小时自动分片。历史内容、索引和恢复快照也占用空间。

免费计划超过每日读写额度时，数据库查询会失败，需等待额度恢复或调整套餐。

每日额度在 UTC 00:00（北京时间 08:00）重置。读取额度按 SQL 实际读取的行计算，不是请求次数；查询返回少量结果，也可能扫描大量行。

`DATABASE_LIMIT` 可附带 `limitType`：`read` 为读取额度、`write` 为写入额度、`storage` 为容量、`queries` 为单次请求查询次数。每日读取额度不足不代表存储空间已满。

## 常见问题

| 现象 | 检查项 |
| --- | --- |
| 构建未触发 | 仓库、生产分支与 Git 授权是否正确 |
| 部署失败 | 构建详情中的错误、D1 绑定和部署命令 |
| 健康检查失败 | `code`、`missingMigrations` 与数据库状态 |
| 打开后显示登录页 | 当前数据库中已经创建管理员 |
| 客户端返回 401 | 设备令牌、设备撤销状态和用户启用状态 |
| 数据库额度不足 | D1 控制台中的容量、读取与写入用量 |

部署按钮的工作方式见 [Cloudflare 官方说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。
