# 内容指纹

内容指纹用于判断是否需要上传正文，采用 **SHA-256 的前 128 bit**：

1. 按下文规则取得输入字节。
2. 计算 SHA-256。
3. 取结果的前 16 字节。
4. 编码为 **32 个小写十六进制字符**，作为 check 请求的 hash。

文件 ID 标识文件，指纹标识内容。文件重命名不会改变内容指纹。

## 文件

直接对文件原始字节计算，不能先转换为文本或 Base64。

```js
import { bytesFingerprint } from "../src/lib/content-digest.js";

const bytes = new Uint8Array(await file.arrayBuffer());
const hash = await bytesFingerprint(bytes);
```

服务端保存文件时使用完整 SHA-256 校验和与原始 BLOB。快速比对使用前 128 bit；客户端也可以在 hash 字段提交完整 SHA-256。

## JSON 数据

仅对记录的 **value** 计算指纹，不包含 namespace、key 或 requestId。

先将 value 按下述规则编码，再计算 SHA-256 并截取前 128 bit。编码对对象属性顺序、JSON 空白和字符转义形式不敏感；直接对 JSON.stringify 的结果计算不能替代此规则。

### 编码规则

各部分直接连接，不加入额外空白。最终文本使用 UTF-8 编码。

| JSON 类型 | 编码 |
| --- | --- |
| null | `n` |
| false | `f` |
| true | `t` |
| number | `d` + IEEE 754 binary64 大端字节的 16 位小写十六进制表示 |
| string | `s` + UTF-8 字节长度 + `:` + 字符串原文 |
| array | `a` + 元素数量 + `:` + 按顺序编码各元素 |
| object | `o` + 属性数量 + `:` + 依次编码属性名字符串及属性值 |

对象属性名按 UTF-16 代码单元升序排列。长度和数量使用无前导零的十进制整数。字符串原文不做 JSON 转义，也不做 Unicode 规范化。

数字转换为 binary64，负零按正零处理，不接受非有限值。字符串及属性名必须是有效 Unicode，不接受孤立代理字符。字符串长度按 UTF-8 **字节数**计算，例如“你好🌍”为 10 字节。

### JavaScript

```js
import { valueFingerprint } from "../src/lib/content-digest.js";

const value = { title: "笔记", pinned: true };
const hash = await valueFingerprint(value);

// check 中发送 namespace、key、hash；仅在返回 upload 时发送 value。
```

### 编码示例

| value | 编码文本 |
| --- | --- |
| `null` | `n` |
| `1` | `d3ff0000000000000` |
| `1.5` | `d3ff8000000000000` |
| `"Hello"` | `s5:Hello` |
| `"你好🌍"` | `s10:你好🌍` |
| `["a",1]` | `a2:s1:ad3ff0000000000000` |
| `{"b":2,"a":"x"}` | `o2:s1:as1:xs1:bd4000000000000000` |

## 128 bit 校验向量

下表均为 JSON value 指纹：

| value | 指纹 |
| --- | --- |
| `null` | `1b16b1df538ba12dc3f97edbb85caa70` |
| `"Hello"` | `3698dca7681f48f88f5ad97df04ad2ba` |
| `"你好🌍"` | `fbbe9eb69560fbdb0395c36975c52291` |
| `{"b":2,"a":"x"}` | `39e144ee963971610cb872fd4a7f10fd` |

原始文件字节 `Hello` 的指纹为 `185f8db32271fe25f561a6fc938b2e26`。它与 JSON 字符串 `"Hello"` 的指纹不同。

参考实现：[content-digest.js](../src/lib/content-digest.js)。SDK 的完整推送会自动调用指纹函数。
