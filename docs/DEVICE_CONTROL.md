# 设备配置 API

用于读取设备当前配置、下发修改和请求设备重新上报。配置按设备独立保存。

## 配置值

`values` 为对象，支持以下字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| vod | string | 点播配置 |
| live | string | 直播配置 |
| theme | string | 主题设置 |
| wallpaper | string | 壁纸设置 |

每项最多 4096 个字符，不含控制字符，首尾空白会被去除。空字符串表示清空。设备负责加载配置值并回报实际结果。

## 设备接口

鉴权：`Authorization: Bearer <device-token>`。

### GET /api/sync/device-config

获取待应用配置和回报状态，无请求参数。

```json
{
  "revision": 2,
  "values": {"theme":"dark"},
  "appliedRevision": 1,
  "refreshRevision": 3,
  "reportSeq": 5,
  "pollAfterMs": 5000
}
```

| 返回字段 | 类型 | 说明 |
| --- | --- | --- |
| revision | integer | 当前下发配置序号 |
| values | object | 待应用字段；没有待办时为 {} |
| appliedRevision | integer | 设备已确认成功的配置序号 |
| refreshRevision | integer | 实时取值请求序号 |
| reportSeq | integer | 服务端已接受的回报序号 |
| pollAfterMs | integer | 轮询间隔提示，单位毫秒 |

### POST /api/sync/device-config/report

上报设备的实际配置和应用结果。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| sequence | integer | 是 | 从 1 开始递增的回报序号 |
| values | object | 是 | 四个配置字段的实际值 |
| appliedRevision | integer | 是 | 已成功应用的配置序号，至少为 0 |
| refreshRevision | integer | 是 | 本次响应的取值请求序号，至少为 0 |
| error | string | 否 | 应用失败原因，最多 500 个字符 |

```json
{
  "sequence": 6,
  "values": {"vod":"","live":"","theme":"dark","wallpaper":""},
  "appliedRevision": 2,
  "refreshRevision": 3,
  "error": ""
}
```

成功返回 `200`：`{"ok":true}`。

相同 sequence 与相同内容重试幂等。已使用序号携带不同内容，或回报状态超出服务端下发范围时，返回 409。

应用失败时，保留最后成功的 appliedRevision，并填写 error。确认当前配置成功时，实际值必须与待确认字段一致。

## 管理接口

鉴权：管理员 Cookie。

### GET /api/admin/devices/{deviceId}/config

读取配置指令与设备实际回报。

| 返回字段 | 类型 | 说明 |
| --- | --- | --- |
| revision | integer | 下发序号 |
| desired | object | 下发配置 |
| appliedRevision | integer | 已确认序号 |
| current | object \| null | 实际回报；null 表示尚未回报 |
| reportedAt | integer \| null | 回报时间 |
| reportSeq | integer | 回报序号 |
| refreshRevision | integer | 取值请求序号 |
| reportedRefreshRevision | integer | 设备已响应的取值序号 |
| requestedAt | integer \| null | 配置请求时间 |
| error | string | 最近应用错误 |

### PUT /api/admin/devices/{deviceId}/config

下发所选配置字段。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| opId | string | 是 | 操作标记，8–100 个字母、数字、下划线或连字符 |
| baseRevision | integer | 是 | 最近读取的 revision |
| values | object | 是 | 至少包含一个配置字段 |

```json
{
  "opId": "550e8400-e29b-41d4-a716-446655440004",
  "baseRevision": 1,
  "values": {"theme":"dark"}
}
```

成功返回 `200`：`{"revision":2}`。基础序号已变化时返回 409，重新读取后再提交。

### POST /api/admin/devices/{deviceId}/config/refresh

请求设备重新采集当前值。无业务参数，JSON 请求体可使用 `{}`。

成功返回 `200`：`{"refreshRevision":4}`。

## 处理流程

1. 设备读取配置状态。
2. 存在待应用字段时，调用相应加载器。
3. 重新采集四项实际值。
4. 持久化本次回报，发送 report。
5. 网络失败时，重发相同序号和内容。

取值请求序号变化时，重新采集并上报。客户端可根据 pollAfterMs 轮询；仅轮询到状态不代表配置已经应用。

设备配置用于单设备控制。客户端应区分设备控制与用户共享数据，避免把单设备指令再次发布到全部设备。
