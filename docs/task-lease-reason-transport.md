# Task lease release-reason 传输面指引（8k bound）

[Back to operator guide](operator-guide.md) · [Task lease journal](task-lease-journal.md)

本页是操作者指引（guidance only）：说明 `TASK_LEASE_REASON_MAX_CHARS = 8_000`
（`packages/api/src/lib/tasks-internal.ts`）在邮件传输头上的体积账与互操作风险。
**不改协议 bound、不做 truncate、不新增 telemetry。**

载荷形态是 **canonical JSON → base64url**，放在 `X-OA-Task-Lease-Payload`
（解析名 `x-oa-task-lease-payload`）。这是结构化 lease 事件编码，**不是**
header injection。

## 量化账：8k reason → 头体积

Release 事件的 canonical JSON 含 `reason` 字段。当 `reason` 取满 8_000 字符时：

| 量 | 约值 | 说明 |
| --- | --- | --- |
| `reason` UTF-8 字符 | 8_000 | 双闸：core `invalid_request` + REST zod `.max(8_000)`；超限 **reject-not-truncate** |
| Canonical JSON 体 | ≈ 8.1–8.3 KiB | 另含 `version` / `event` / `actor` / `at` / `generation` / `tokenVerifier` 等定长字段 |
| `X-OA-Task-Lease-Payload` base64url | **≈ 10.9 KiB** | `ceil(jsonBytes / 3) * 4`；仓库回归（`task-lease-core` R17）对满 bound reason 实测 payload 展开后回放一致 |
| 折行后线上行数 | 视 MTA/客户端折行宽 | nodemailer 出站常按 ≈76–78 列折；解析侧须 unfold 后再 base64url 解码 |

演算核对（数量级）：`8100 * 4 / 3 ≈ 10800` 字符 ≈ **10.55–10.9 KiB**（视 JSON 定长字段长度略浮动）。

## 自部署 Postfix：`header_size_limit`

捆绑栈 / 常见自托管 Postfix 默认：

- 参数：`header_size_limit`
- **默认 102400 字节（100 KiB）**（单个逻辑头，含已折叠续行）
- 公开来源：[Postfix postconf(5) `header_size_limit`](https://www.postfix.org/postconf.5.html)

相对 ≈10.9 KiB 的单头 payload，**默认 102400 足够**。若操作者把
`header_size_limit` **调小到接近或低于** max-bound payload（再加其它头），
cleanup 会丢弃超额头文本，lease 解析失败或 stamp 校验失败。调小前请用
`postconf header_size_limit` / `postconf -d header_size_limit` 核对，并在
dogfood 路径做满 bound release 往返（本仓 CI 不代替现场 hop）。

## 常见商用中继 / 邮箱商头上限（公开文档；**未实测**）

下表摘自各厂商**公开文档**，仅作风险提示。本仓库**未**对下列商用路径做
满 8k reason 实弹投递；**一律标注「未实测」**，不得当作交付承诺。

| 路径 | 公开口径（摘要） | 来源 | 对本 8k→≈10.9KiB 头的粗判 | 实测状态 |
| --- | --- | --- | --- | --- |
| Google Gmail / Workspace | 单头 value 上限 32KB；全头合计 500KB；头字段数 5000 | [Gmail message header limits](https://support.google.com/a/answer/14016360) | 单头 32KB ≫ 10.9KiB，名义上宽松 | **未实测** |
| Microsoft Exchange / 文档化 Receive connector | 全部头字段合计默认 **256 KB**（`MaxHeaderSize`） | [Message size and recipient limits (Exchange)](https://learn.microsoft.com/en-us/exchange/mail-flow/message-size-limits) | 合计 256KB 通常够用；Exchange Online 现场是否同值以租户为准 | **未实测** |
| Amazon SES | 公开配额主写**整信**大小（含附件）；SNS 通知路径另有「headers 10KB」类限制（通知面，非 SMTP 出站主路径） | [SES service quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html) | SMTP/API 出站整信配额远大于 10.9KiB；勿与 SNS header 配额混读 | **未实测** |
| 其它 SMTP 中继（SendGrid / Mailgun 等） | 多数公开材料写整信/附件上限，**少有**单独的单头 KiB 表 | 各厂商当前 docs | 遇拒信时查 SMTP 应答与中继状态页；不要假设与 Postfix 默认相同 | **未实测** |

## 存储增长账

每条 **max-bound** release 回执（满 8k reason）相对短 reason：

- 出站 MIME / IMAP 存档：多出约 **+10.9 KiB** 级（payload 头；另加折行 CRLF/WSP 开销）
- Durable rebuild（`taskFromMessages` 等从信箱重建）：同步放大——长 reason 进入
  `releasedLease.reason` 与相关持久化视图；历史越长、满 bound 回执越多，磁盘与
  rebuild CPU 线性上升
- Pending journal / 其它 lease 旁路：本页不展开；见 [task-lease-journal.md](task-lease-journal.md)

## 操作建议（短）

1. 保持双闸 8k；不要在中继侧「截断 reason」冒充成功。
2. 自托管 Postfix 勿盲目下调 `header_size_limit`。
3. 经商用中继前，用公开表做风险预判，并在目标 hop **自行**做满 bound 往返（**未实测**条目不得省略）。
4. 回归：`packages/api` 内 `task-lease-core` 对 8k reason 的 folding/unfolding
   走 **mailparser 生产解析路径**（非 mock）；见该文件 R17 / #82 语料用例。
