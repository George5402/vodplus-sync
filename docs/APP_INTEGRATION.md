# 客户端接入指南

客户端负责组织应用数据、读取本地文件并应用恢复结果。接入流程为：绑定设备 → 组织数据 → 推送 → 下载恢复。

接口参数见 [API 参考](PROTOCOL.md)和 [数据同步 API](SYNC_V2.md)。

## 1. 绑定设备

管理员创建用户并生成设备码后，客户端请求：

```http
POST /api/bind
Content-Type: application/json

{"code":"<binding-code>","deviceName":"我的电脑"}
```

保存响应中的 `deviceId`、`userId` 和 `token`。后续请求使用：

```http
Authorization: Bearer <device-token>
```

不同服务器和用户的凭证、本地数据应分别保存。收到 401 时，检查授权状态并引导重新绑定。

## 2. 组织数据

为应用选取明确的命名空间，并使用普通字符串 key 表示记录。

| 数据 | namespace | key 示例 |
| --- | --- | --- |
| 偏好设置 | `com.example.notes.settings` | `preferences` |
| 笔记 | `com.example.notes.entries` | `note-1001` |
| 应用扩展 | `com.example.notes.extensions` | `editor-layout` |

单条 value 更新是整体替换。需要独立修改的内容应拆成不同记录；不同应用的扩展分别存放，避免互相覆盖。

数据较大时，按记录拆分并分批提交。二进制内容使用文件接口。容量限制见 [数据同步 API](SYNC_V2.md#容量)。

## 3. 映射本地文件

云端路径使用 `notes/readme.txt` 这样的相对路径。客户端选择本地根目录，将相对路径映射到该目录下。

恢复时应校验目标路径仍位于所选根目录内。文件先完整写入临时文件，成功后替换目标文件；I/O 失败应中止确认并显示原因。

## 4. 选择推送方式

| 方式 | 适用场景 | 删除行为 |
| --- | --- | --- |
| 指定项目推送 | 保存部分记录或文件 | 仅删除请求中明确指定的项目 |
| 完整发布 | 将所选范围更新为本次备份 | finish 后删除该范围清单中缺失的项目 |

完整发布先遍历当前数据生成摘要清单，批量调用 check，再上传返回 upload 的项目。unchanged 项已经计入清单，不发送正文。上传时附带发布 session。

finish 返回 ok=false 时，按 upload 列表补传后再次确认。任意读取或上传失败时，不将任务标记为完成。摘要函数与校验向量见 [内容摘要](CONTENT_DIGEST.md)。

指纹使用 SHA-256 前 128 bit，输出 32 个小写十六进制字符。文件按原始字节计算，JSON 仅对 value 按规定编码计算。SDK 已封装 `bytesFingerprint` 和 `valueFingerprint`。

finish 成功后，持久保存此次推送对应的本地数据缓存。服务端会记录设备已持有的具体项目；后续增量恢复可能省略这些内容，即使恢复 scope 与推送 scope 不同。

文件规则排除项可以跳过。文件上传返回 `skipped: true` 时，将其显示为已跳过，不计为传输失败。

## 5. 应用恢复结果

1. 提交 scope 开始恢复，保存返回的 session 和 page。
2. mode 为 full 时，清空所选的数据分区。
3. 按 page 获取恢复包，逐项应用 put 和 delete。
4. 文件 put 使用 content 标记取得完整字节，再替换本机文件。
5. 使用 next 读取后续页面。
6. 所有项目成功后发送 ack。

同一范围的恢复按顺序执行。页面可以重取；未完成就重新开始时，服务端会提供完整恢复及必要删除项。

文件恢复不会删除从未进入云端管理范围的本地文件。

## JavaScript SDK

参考实现位于 [examples/sync-v2-client.js](../examples/sync-v2-client.js)，支持浏览器和具备 Fetch API 的 JavaScript 环境。使用时同时引入其内容摘要模块，或通过构建工具打包。

### 创建客户端

```js
import { SyncClient } from "./sync-v2-client.js";

const sync = new SyncClient({
  server: "https://sync.example.com",
  token: deviceToken,
  onProgress(progress) {
    renderSyncProgress(progress);
  }
});
```

`onProgress` 返回任务类型和累计进度，包括已上传的 records、files，内容一致的 unchanged 和规则排除的 skipped。界面可以在同一行更新状态。

### 完整推送

```js
const scope = {
  namespaces: ["com.example.notes.entries"],
  files: true,
  roots: ["notes"]
};

await sync.pushAll({
  scope,
  records: [
    {
      namespace: "com.example.notes.entries",
      key: "note-1001",
      value: { title: "第一条笔记", text: "Hello" }
    }
  ],
  files: [
    {
      path: "notes/readme.txt",
      read: async () => new TextEncoder().encode("Hello")
    }
  ]
});
```

`records` 和 `files` 支持普通或异步可迭代对象。文件的 read 函数按需读取内容。

### 下载恢复

```js
await sync.download({
  scope,
  full: false,
  beginFull: async namespaces => store.clearNamespaces(namespaces),
  putData: async (namespace, key, value) => store.put(namespace, key, value),
  deleteData: async (namespace, key) => store.remove(namespace, key),
  putFile: async (path, bytes) => files.replaceAtomically(path, bytes),
  deleteFile: async path => files.removeIfExists(path)
});
```

`store` 和 `files` 由客户端实现。写入失败时回调应抛出异常，SDK 不会提交成功确认。

### 指定项目操作

```js
await sync.pushRecords(
  "com.example.notes.settings",
  [{ key: "preferences", value: { theme: "dark" } }]
);

await sync.pushFile(
  "notes/readme.txt",
  new TextEncoder().encode("Hello")
);

await sync.deleteFile("notes/draft.txt");
```

## 处理失败

| 情况 | 处理 |
| --- | --- |
| 网络中断 | 保留操作标记重试，或重新开始完整任务 |
| 本地应用失败 | 显示实际原因，不确认恢复成功 |
| 401 | 检查授权并重新绑定 |
| 409 / RESTORE_SUPERSEDED | 重新开始恢复 |
| 410 | 生成新的 requestId，重新创建会话 |
| 413 | 拆分数据或减小文件 |
| 429 / 503 | 按服务端提示延迟重试 |

SDK 完整任务重新调用会创建一个新会话。需要精确续传时，可按 API 参考自行保存 session、page 和操作标记。

## 接入检查

- 两台设备绑定同一用户后，推送的数据能够互相恢复。
- 不同用户的记录和文件互不可见。
- 完整发布只删除所选范围内的缺失项目。
- 其他应用的命名空间及文件规则排除项保持不变。
- 下载失败、写入失败和应用中断不会确认成功。
- 完全一致的重复推送不发送记录正文和文件内容；只修改一项时只上传该项。
- 成功恢复后，再次下载只获取服务端计算出的变化。
