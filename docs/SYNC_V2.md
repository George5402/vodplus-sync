# 数据同步 API

基础地址：`https://sync.example.com`。

鉴权统一使用 `Authorization: Bearer <device-token>`。JSON 请求采用 `Content-Type: application/json`。设备绑定方法见 [API 参考](PROTOCOL.md#post-apibind)。

## 数据类型

### Record

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| namespace | string | 数据分区，1–120 个字符；首字符为字母或数字，其余可用字母、数字、点、下划线和连字符 |
| key | string | 分区内的记录名称，1–2000 个字符，不含控制字符 |
| value | JSON | 对象、数组、字符串、数字、布尔值或 null |

记录由 `namespace + key` 唯一定位。建议使用应用域名组织分区，例如 `com.example.notes`。`legacy.` 为系统保留前缀，不用于写入。

### Scope

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| namespaces | string[] | 是 | — | 精确匹配的数据分区，最多 32 项，可为空数组 |
| files | boolean | 否 | false | 是否包含文件 |
| roots | string[] | 否 | `[""]` | files=true 时使用，最多 32 项；空字符串表示根目录 |

至少选择一个数据分区或启用文件。目录使用相对路径，包含该目录及其子项。

### OperationId

`requestId` 和 `Idempotency-Key` 使用 8–100 个字母、数字、下划线或连字符，可直接使用 UUID。同一操作重试时保留原标记和请求内容；修改内容时生成新的标记。

## 推送记录

### POST /api/v2/sync/push

创建、覆盖或删除指定记录。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| requestId | OperationId | 是 | 本次请求标记 |
| namespace | string | 是 | 目标数据分区 |
| upsert | array | 否 | `{key,value}` 列表 |
| delete | string[] | 否 | 要删除的 key 列表 |
| session | string | 否 | 完整发布会话标记 |

`upsert` 与 `delete` 合计 1–50 项，同一个 key 不能重复出现。请求最多 128 KiB；单条记录的 namespace、key、value 序列化封装最多 16 KiB。

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "namespace": "com.example.notes",
  "upsert": [
    {"key":"welcome","value":{"text":"Hello","pinned":true}}
  ],
  "delete": ["draft"]
}
```

成功返回 `200`：

```json
{"ok":true}
```

每个 upsert 整体替换对应 value，未指定的记录保持不变。同一记录的并发请求按服务器提交顺序生效。

## 上传文件

### PUT /api/v2/sync/file

请求体为文件原始字节。

| 位置 | 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| Query | path | string | 是 | URL 编码的相对文件路径 |
| Header | Idempotency-Key | OperationId | 是 | 本次上传标记 |
| Header | X-Sync-Session | string | 否 | 完整发布会话标记 |
| Header | Content-Type | string | 是 | `application/octet-stream` |
| Body | — | binary | 是 | 文件内容，最多 1,572,864 字节 |

```http
PUT /api/v2/sync/file?path=notes%2Freadme.txt HTTP/1.1
Authorization: Bearer <device-token>
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440001
Content-Type: application/octet-stream

Hello
```

成功返回 `200`：

```json
{"ok":true,"path":"notes/readme.txt","size":5}
```

父目录自动创建；同路径文件被覆盖，内容相同的文件在用户空间内去重。

路径应使用 NFC 规范化文本，最长 500 个字符，以 `/` 分隔。禁止绝对路径、`.`、`..` 路径段、反斜杠、控制字符和文件系统保留字符。

被规则排除时返回 `200`，不写入文件：

```json
{"ok":true,"skipped":true,"reason":"DIRECTORY_EXCLUDED"}
```

`reason` 可为 `DIRECTORY_EXCLUDED` 或 `FILE_TYPE_NOT_ALLOWED`。

## 删除文件

### DELETE /api/v2/sync/file

| 位置 | 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| Query | path | string | 是 | 相对文件路径 |
| Header | Idempotency-Key | OperationId | 是 | 本次删除标记 |
| Header | X-Sync-Session | string | 否 | 发布会话标记 |

成功返回 `200`：`{"ok":true,"path":"notes/readme.txt"}`。

目标不存在时仍成功。该接口删除普通文件，不递归删除目录。规则排除项返回 skipped 结果。

## 完整发布

完整发布包含创建会话、摘要比对、按需上传和确认清单。一致项和上传成功项都计入服务端清单。

### 1. 创建会话

`POST /api/v2/sync/push`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| action | string | 是 | 固定值 `start` |
| requestId | OperationId | 是 | 本次发布标记 |
| scope | Scope | 是 | 发布范围 |

```json
{
  "action": "start",
  "requestId": "550e8400-e29b-41d4-a716-446655440002",
  "scope": {
    "namespaces": ["com.example.notes"],
    "files": true,
    "roots": ["notes"]
  }
}
```

返回 `200`：

```json
{"session":"<publish-session>","expiresAt":1800000000000}
```

### 2. 比对内容

`POST /api/v2/sync/push`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| action | string | 是 | `check` |
| session | string | 是 | 发布会话标记 |
| items | array | 是 | 1–1000 项摘要清单，其中数据记录最多 100 项；请求总大小不超过 128 KiB |

| 项目 | 字段 |
| --- | --- |
| 数据记录 | `type=data, namespace, key, hash` |
| 文件 | `type=file, path, hash, size` |

`hash` 推荐使用 **32 个小写十六进制字符**，即 SHA-256 的前 **128 bit**。也可传入完整的 64 字符 SHA-256，比对时取前 128 bit。文件指纹按原始字节计算；数据指纹仅对 `value` 计算，规则见 [内容摘要规范](CONTENT_DIGEST.md)。`size` 为文件字节数。

```json
{
  "action": "check",
  "session": "<publish-session>",
  "items": [
    {
      "type": "data",
      "namespace": "com.example.notes",
      "key": "welcome",
      "hash": "3698dca7681f48f88f5ad97df04ad2ba"
    }
  ]
}
```

返回 `200`，items 与请求同序：

```json
{"items":[{"type":"data","namespace":"com.example.notes","key":"welcome","status":"unchanged"}]}
```

| status | 处理 |
| --- | --- |
| unchanged | 云端当前内容一致，已计入清单，不上传正文 |
| upload | 新项目或内容不同，需要上传 |
| skipped | 被文件规则排除，不上传；附 `reason` |

`reason` 可为 `DIRECTORY_EXCLUDED` 或 `FILE_TYPE_NOT_ALLOWED`。比对可以重复调用；失败时不能假定项目已登记。客户端不需要保存服务器版本或上次发布清单。

### 3. 上传内容

将全部当前项目分批完成比对，只上传返回 upload 的记录和文件：

- 记录请求增加 `session` 字段。
- 文件请求增加 `X-Sync-Session` 请求头。
- 规则排除项可以省略。

### 4. 确认清单

`POST /api/v2/sync/push`

```json
{"action":"finish","session":"<publish-session>"}
```

返回 `200`：`{"ok":true}`。

确认后，服务端删除范围内未出现在本次清单中的记录和文件。范围外数据及文件规则排除项保持不变。空清单表示删除该范围内全部符合条件的项目。

存在待上传项目，或云端内容在比对后发生变化时，返回 `200`：

```json
{"ok":false,"upload":[{"type":"data","namespace":"com.example.notes","key":"welcome"}],"hasMore":false}
```

此时尚未执行清单删除。上传所列项目后再次 finish，直到 ok=true。每次最多返回 100 项；hasMore 表示还有待处理项。补传使用新的操作标记，同一次传输的网络重试保留标记。

会话有效期为 24 小时。没有确认时不按清单缺失执行删除；已经成功上传的项目可见。确认可重复提交。

## 恢复数据

### POST /api/v2/sync/restore

使用同一接口完成开始、分页、文件读取和成功确认。所有会话及资源标记仅供发起设备使用。

### 1. 开始恢复

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| action | string | 是 | — | `start` |
| requestId | OperationId | 是 | — | 本次恢复标记 |
| scope | Scope | 是 | — | 恢复范围 |
| full | boolean | 否 | false | 强制完整恢复 |

```json
{
  "action": "start",
  "requestId": "550e8400-e29b-41d4-a716-446655440003",
  "scope": {"namespaces":["com.example.notes"],"files":true},
  "full": false
}
```

返回 `200`：

```json
{
  "session": "<restore-session>",
  "mode": "delta",
  "page": "<page-marker>",
  "total": 3,
  "expiresAt": 1800000000000,
  "policy": {
    "fileExtensions": ["txt","json"],
    "includeExtensionless": true,
    "excludedDirectories": ["_cache","__pycache__","pycache"],
    "revision": 1
  }
}
```

| 字段 | 说明 |
| --- | --- |
| mode | `full` 为完整恢复，`delta` 为变化恢复 |
| page | 第一页标记；没有项目时为 null |
| total | 本次需要处理的项目数 |
| expiresAt | 会话到期时间 |
| policy | 本次恢复使用的文件规则 |

显式指定 full，或存在尚未完成应用的任务时，使用 full。服务端按用户、设备和规范化 scope 保存成功恢复状态，并按项目记录设备已确认持有的内容。

所选分区和文件规则未变化时，返回轻量空会话（mode=delta、page=null、total=0），不复制逐项快照。客户端仍提交 ack；空结果没有待应用数据，未确认就重新请求也不强制全量。

发布成功的已比对项目可在不同恢复范围间复用，因此推送后首次恢复也可能返回 delta；没有恢复基线和已持有项目时返回 full。客户端完成推送后应保存用于组装增量恢复的本地数据。

### 2. 获取恢复包

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| action | string | 是 | `page` |
| session | string | 是 | 恢复会话 |
| page | string | 是 | 返回的页面标记 |

```json
{"action":"page","session":"<restore-session>","page":"<page-marker>"}
```

返回 `200`：

```json
{
  "items": [
    {"type":"data","op":"put","namespace":"com.example.notes","key":"welcome","value":{"text":"Hello"}},
    {"type":"file","op":"put","path":"notes/readme.txt","size":5,"content":"<content-marker>"},
    {"type":"file","op":"delete","path":"notes/draft.txt"}
  ],
  "next": null,
  "done": true
}
```

| 项目 | 字段 |
| --- | --- |
| 写入记录 | `type=data, op=put, namespace, key, value` |
| 删除记录 | `type=data, op=delete, namespace, key` |
| 写入文件 | `type=file, op=put, path, size, content` |
| 删除文件 | `type=file, op=delete, path` |

每页最多 25 项。`next` 为后续页面标记，为 null 时结束。页面可以重复读取，内容固定于本次恢复快照。

### 3. 获取文件内容

```json
{"action":"content","session":"<restore-session>","content":"<content-marker>"}
```

返回 `200`、`Content-Type: application/octet-stream` 和原始文件字节。

客户端完整下载后替换目标文件。数据 put 覆盖对应记录，delete 删除对应项目。

### 4. 确认成功

```json
{"action":"ack","session":"<restore-session>"}
```

返回 `200`：`{"ok":true}`。

必须获取全部分页，并成功应用所有项目后再确认。确认后才更新恢复进度；重复确认幂等。

### 恢复语义

- full 下，客户端先清空所选数据分区，再应用完整记录；其他分区保留。
- 文件 full 下发全部允许文件和服务端已知的删除项。未进入云端管理范围的本地文件保留。
- 文件规则排除造成的消失不生成删除通知。
- 会话开始后的云端变化在后续恢复中获取。
- 普通恢复跳过本设备已确认持有且云端未变化的项目；其他设备的新增、改动和删除仍会下发。
- 会话有效期 24 小时。过期返回 410，使用新的 requestId 重新开始。
- 未确认任务重新开始时执行 full，包含必要删除通知。
- 被其他恢复任务替代的任务确认返回 409，诊断码为 `RESTORE_SUPERSEDED`。

## 文件规则

### GET /api/sync/settings

返回 `200`：

```json
{
  "fileExtensions": ["py","js","txt","json","m3u8","jar","php","html"],
  "includeExtensionless": true,
  "excludedDirectories": ["_cache","__pycache__","pycache"],
  "revision": 1
}
```

目录排除忽略大小写，匹配任意路径层级及其子树。后缀取文件名最后一个点之后的部分；以单个点开头且没有其他点的文件视为无后缀。

## 容量

| 项目 | 限制 |
| --- | --- |
| JSON 请求 | 128 KiB |
| 单条记录封装 | 16 KiB |
| 每次记录推送 | 50 项 |
| 每次摘要比对 | 最多 1000 个文件或 100 条数据记录，总数不超过 1000 |
| 单文件 | 1.5 MiB |
| 每个文件清单 | 5000 项，含目录和删除标记 |
| 每个用户的结构化记录 | 5000 条 |
| 恢复包 | 每页 25 项 |
| 发布、恢复会话 | 24 小时 |
