# API 参考

服务地址示例：`https://sync.example.com`。生产环境使用 HTTPS。

## 接口索引

| 分类 | 请求 | 用途 |
| --- | --- | --- |
| 服务 | `GET /api/health` | 检查服务就绪状态 |
| 服务 | `GET /api/status` | 查询管理员初始化状态 |
| 认证 | `POST /api/setup` | 创建管理员 |
| 认证 | `POST /api/login` | 管理员登录 |
| 认证 | `POST /api/logout` | 退出管理会话 |
| 设备 | `POST /api/bind` | 使用设备码绑定 |
| 用户 | `POST /api/admin/users` | 创建用户 |
| 用户 | `PATCH /api/admin/users/{userId}` | 修改用户 |
| 设备 | `POST /api/admin/users/{userId}/binding` | 签发设备码 |
| 设备 | `PATCH /api/admin/devices/{deviceId}` | 修改设备或撤销授权 |
| 数据 | `POST /api/v2/sync/push` | 推送记录、创建或确认发布会话 |
| 文件 | `PUT /api/v2/sync/file` | 上传文件 |
| 文件 | `DELETE /api/v2/sync/file` | 删除文件 |
| 恢复 | `POST /api/v2/sync/restore` | 获取和确认恢复数据 |
| 规则 | `GET /api/sync/settings` | 读取文件同步规则 |
| 分享 | `GET /share/{shareId}/info` | 读取分享信息 |
| 分享 | `POST /share/{shareId}/auth` | 获取分享授权 |
| 分享 | `GET /share/{shareId}/index.json` | 获取配置索引 |
| 分享 | `GET /share/{shareId}/files/{fileId}/{filename}` | 读取分享文件 |

详细参数：[数据与恢复](SYNC_V2.md) · [设备配置](DEVICE_CONTROL.md) · [管理员密码与重置](ACCOUNT_RECOVERY.md)

## 请求约定

| 项目 | 约定 |
| --- | --- |
| JSON 编码 | UTF-8 |
| JSON Content-Type | `application/json` |
| 文件 Content-Type | `application/octet-stream` |
| 时间 | Unix 毫秒时间戳 |
| JSON 请求上限 | 128 KiB |
| 路径参数 | URL 编码 |
| 操作标记 | 8–100 个字母、数字、下划线或连字符；可使用 UUID |

请求示例：

```http
POST /api/v2/sync/push HTTP/1.1
Host: sync.example.com
Authorization: Bearer <device-token>
Content-Type: application/json

{"requestId":"550e8400-e29b-41d4-a716-446655440000","namespace":"com.example.notes","upsert":[{"key":"welcome","value":{"text":"Hello"}}]}
```

### 鉴权

| 身份 | 凭证 | 适用接口 |
| --- | --- | --- |
| 管理员 | `Cookie: vp_session=<session>` | `/api/admin/*`、退出登录 |
| 设备 | `Authorization: Bearer <device-token>` | 同步、恢复、设备配置 |
| 分享访问者 | `Authorization: Bearer <share-token>` 或 `?token=...` | 有密码的分享资源 |

管理员 Cookie 使用 HttpOnly、SameSite=Strict，HTTPS 下启用 Secure，有效期 12 小时。管理请求携带 Origin 时，其值必须与服务地址一致。

### 错误响应

```json
{
  "error": "恢复任务已被替代，请重新开始下载",
  "detail": {
    "code": "RESTORE_SUPERSEDED"
  }
}
```

`error` 为错误说明；`detail` 为可选诊断信息。具体诊断字段以响应为准。

数据库限制使用 `detail.code=DATABASE_LIMIT`，可附 `detail.limitType=read|write|storage|queries|unknown`，分别表示读取、写入、容量、单次查询次数和未明确的限制。

| 状态码 | 含义 |
| --- | --- |
| 400 | 参数、JSON 或路径无效 |
| 401 | 凭证无效、密码错误或设备访问被撤销 |
| 403 | 管理请求来源不允许 |
| 404 | 接口、资源或会话不存在 |
| 409 | 操作标记重复但内容不同，或任务状态已变化 |
| 410 | 传输会话过期 |
| 413 | 请求、文件或空间容量超限 |
| 415 | Content-Type 不受支持 |
| 422 | 内容或目标路径不满足要求 |
| 429 | 请求过于频繁 |
| 500 | 服务内部错误；可附诊断码和请求编号 |
| 503 | 服务暂不可用；可附重试提示 |

## 服务接口

### GET /api/health

鉴权：无。检查数据库结构，返回 `200` 或 `503`。

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

### GET /api/status

鉴权：无。返回管理员是否已创建。

```json
{"initialized":true}
```

## 管理员认证

### POST /api/setup

鉴权：无。仅在没有管理员时可调用。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| username | string | 是 | 账号，1–80 个字符 |
| password | string | 是 | 密码，5–200 个字符 |

成功返回 `200`、`{"ok":true}`，并设置登录 Cookie。

### POST /api/login

鉴权：无。参数同 `setup`。验证成功返回 `200`、`{"ok":true}`，并设置登录 Cookie。

### POST /api/logout

鉴权：管理员。无请求参数。成功返回 `200`、`{"ok":true}`，当前会话失效。

## 用户与设备

以下管理接口使用管理员 Cookie。

### POST /api/admin/users

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| name | string | 是 | 用户名称，1–80 个字符，同服务内唯一 |

返回 `201`：`{"id":"<userId>"}`。

### PATCH /api/admin/users/{userId}

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| name | string | 否 | 用户名称 |
| enabled | boolean | 否 | 是否启用 |

返回 `200`：`{"ok":true}`。

### POST /api/admin/users/{userId}/binding

为启用状态的用户签发一次性设备码，无业务参数，JSON 请求体可使用 `{}`。

返回 `200`：

```json
{"code":"<binding-code>","expires":1800000000000}
```

设备码有效期 10 分钟，只能使用一次。

### POST /api/bind

鉴权：设备码。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| code | string | 是 | 设备码，最多 256 个字符 |
| deviceName | string | 是 | 设备名称，1–80 个字符 |
| expectedUserId | string | 否 | 限定设备码必须属于该用户 |

返回 `201`：

```json
{
  "deviceId": "<deviceId>",
  "userId": "<userId>",
  "token": "<device-token>",
  "username": "家庭成员"
}
```

`expectedUserId` 不匹配时返回 `409` 和 `USER_MISMATCH`，设备码不被消费。

### PATCH /api/admin/devices/{deviceId}

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| name | string | 否 | 设备名称 |
| revoked | boolean | 否 | 设为 true 撤销访问 |

返回 `200`：`{"ok":true}`。撤销后的设备需要重新绑定。

## 分享接口

### POST /api/admin/shares

鉴权：管理员。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| name | string | 是 | 分享名称，1–80 个字符 |
| owner | string | 是 | 用户 ID 或 `public` |
| root | string | 否 | 已存在的相对目录；空字符串表示整个空间 |
| password | string | 否 | 空字符串为公开访问；设置时为 5–200 个字符 |

返回 `201`：`{"id":"<shareId>","entry":"https://sync.example.com/s/<shareId>"}`。

### PATCH /api/admin/shares/{shareId}

鉴权：管理员。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| name | string | 否 | 修改名称 |
| enabled | boolean | 否 | 是否开放访问 |
| password | string | 否 | 设置密码；空字符串取消密码 |
| revokeTokens | boolean | 否 | 撤销已签发的分享凭证 |

返回 `200`：`{"ok":true}`。设置 password 时会撤销已签发凭证。

### GET /share/{shareId}/info

鉴权：无。返回 `{name,passwordRequired,url}`；需要密码时 `url` 为 null。

### POST /share/{shareId}/auth

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| password | string | 按需 | 分享密码；公开分享可提交空对象 |

返回 `200`：

```json
{
  "token": "<share-token>",
  "expires": null,
  "url": "https://sync.example.com/share/<shareId>/index.json?token=<share-token>"
}
```

公开分享的 `token` 为 null，URL 不带凭证。分享授权无固定到期时间。

管理员可以调用 `POST /api/admin/shares/{shareId}/token` 获取相同结构的访问链接。

### GET /share/{shareId}/index.json

鉴权：公开分享无需凭证，有密码的分享使用分享令牌。返回目录生成的配置索引，含 `sites`、`lives`，或 `urls`、`lives`。

### GET /share/{shareId}/files/{fileId}/{filename}

鉴权同上。读取发布范围内的文件。JSON 文件返回解析后的配置，并将可识别的本地资源引用转换为对应分享 URL；其他文件返回内容字节。
