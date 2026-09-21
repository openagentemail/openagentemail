# Task lease release-reason 传输面指引（8k bound）

[Back to operator guide](operator-guide.md) · [Task lease journal](task-lease-journal.md)

本页是操作者指引（guidance only）：说明 `TASK_LEASE_REASON_MAX_CHARS = 8_000`
（`packages/api/src/lib/tasks-internal.ts`）在邮件传输头上的体积账与互操作风险。
**不改协议 bound、不做 truncate、不新增 telemetry。**

载荷形态是 **canonical JSON → base64url**，放在 `X-OA-Task-Lease-Payload`
（解析名 `x-oa-task-lease-payload`）。这是结构化 lease 事件编码，**不是**
header injection。

## 量化账：8k reason → 头体积

双闸按 `reason.length`（JS 字符串长度 ≈ UTF-16 code units）计量，**不是**
UTF-8 字节数。满 8_000 时，头体积随字符的 UTF-8 宽度剧烈变化：

| 量 | 全 ASCII（如 `r`×8000） | 全 BMP 多字节最坏（如 `界`×8000） | 说明 |
| --- | --- | --- | --- |
| `reason.length`（双闸） | 8_000 | 8_000 | core `invalid_request` + REST zod `.max(8_000)`；超限 **reject-not-truncate**。两种字符集**都过闸** |
| `reason` UTF-8 字节 | 8_000 | ≈ 24_000（每字 3 bytes） | JSON 字符串按 UTF-8 编码进 canonical 体 |
| Canonical JSON 体 | ≈ 8.1–8.3 KiB | ≈ **24.1 KiB** | 另含 `version` / `event` / `actor` / `at` / `generation` / `tokenVerifier` 等定长字段 |
| `X-OA-Task-Lease-Payload` base64url | **≈ 10.9 KiB** | **≈ 32.2 KiB** | `ceil(jsonBytes / 3) * 4` |
| 折行后线上行数 | 视 MTA/客户端折行宽 | 同左，行数更多 | nodemailer 出站常按 ≈76–78 列折；解析侧须 unfold 后再 base64url 解码 |

演算核对：

- ASCII：`8100 * 4 / 3 ≈ 10800` → ≈ **10.55–10.9 KiB**（仓库 R17 回归对满 bound ASCII reason 实测 payloadChars=10908）
- BMP 最坏：`24000 * 4 / 3 ≈ 32000` → ≈ **32.2 KiB**（`界` 等 U+4E00 区汉字每 UTF-8 字 3 字节；非 ASCII 满 bound **未**在本仓 CI 对商用 hop 实测）

## 自部署 Postfix：`header_size_limit`

捆绑栈 / 常见自托管 Postfix 默认：

- 参数：`header_size_limit`
- **默认 102400 字节（100 KiB）**（单个逻辑头，含已折叠续行）
- 公开来源：[Postfix postconf(5) `header_size_limit`](https://www.postfix.org/postconf.5.html)

相对 ASCII ≈10.9 KiB **与** BMP 最坏 ≈32.2 KiB，**默认 102400 仍足够**。若操作者把
`header_size_limit` **调小到接近或低于** max-bound payload（再加其它头），
cleanup 会丢弃超额头文本，lease 解析失败或 stamp 校验失败。调小前请用
`postconf header_size_limit` / `postconf -d header_size_limit` 核对，并在
dogfood 路径做满 bound（含非 ASCII）release 往返（本仓 CI 不代替现场 hop）。

## 常见商用中继 / 邮箱商头上限（公开文档；**未实测**）

下表摘自各厂商**公开文档**，仅作风险提示。本仓库**未**对下列商用路径做
满 8k reason 实弹投递；**一律标注「未实测」**，不得当作交付承诺。

| 路径 | 公开口径（摘要） | 来源 | 对 8k reason 头的粗判 | 实测状态 |
| --- | --- | --- | --- | --- |
| Google Gmail / Workspace | 单头 value 上限 32KB；全头合计 500KB；头字段数 5000 | [Gmail message header limits](https://support.google.com/a/answer/14016360) | ASCII ≈10.9KiB 低于 32KB；**BMP 最坏 ≈32.2KiB 已贴/超过单头 32KB**——满 bound 多字节 reason 经 Gmail 有真实丢信风险；建议运营避免或先实测 | **未实测** |
| Microsoft Exchange / 文档化 Receive connector | 全部头字段合计默认 **256 KB**（`MaxHeaderSize`） | [Message size and recipient limits (Exchange)](https://learn.microsoft.com/en-us/exchange/mail-flow/message-size-limits) | 合计 256KB 对 ≈32.2KiB 通常仍够用；Exchange Online 现场是否同值以租户为准 | **未实测** |
| Amazon SES | 公开配额主写**整信**大小（含附件）；SNS 通知路径另有「headers 10KB」类限制（通知面，非 SMTP 出站主路径） | [SES service quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html) | SMTP/API 出站整信配额远大于 32KiB；勿与 SNS header 配额混读 | **未实测** |
| 其它 SMTP 中继（SendGrid / Mailgun 等） | 多数公开材料写整信/附件上限，**少有**单独的单头 KiB 表 | 各厂商当前 docs | 遇拒信时查 SMTP 应答与中继状态页；不要假设与 Postfix 默认相同 | **未实测** |

## 存储增长账

每条 **max-bound** release 回执（满 8k `reason.length`）相对短 reason：

- 出站 MIME / IMAP 存档（payload 头；另加折行 CRLF/WSP）：
  - 全 ASCII：约 **+10.9 KiB** 级
  - 全 BMP 多字节最坏：约 **+32.2 KiB** 级
- Durable rebuild（`taskFromMessages` 等从信箱重建）：同步放大——长 reason 进入
  `releasedLease.reason` 与相关持久化视图；历史越长、满 bound 回执越多，磁盘与
  rebuild CPU 线性上升（最坏按 UTF-8 膨胀计）
- Pending journal / 其它 lease 旁路：本页不展开；见 [task-lease-journal.md](task-lease-journal.md)

## 操作建议（短）

1. 保持双闸 8k；不要在中继侧「截断 reason」冒充成功。
2. 自托管 Postfix 勿盲目下调 `header_size_limit`（按最坏 ≈32.2KiB 留余量）。
3. 经商用中继前，用公开表做风险预判；**避免对 Gmail 等 32KB 单头上限路径使用满 bound 多字节 reason**，或在目标 hop **自行**实测（**未实测**条目不得省略）。
4. 回归：`packages/api` 内 `task-lease-core` 对 8k reason 的 folding/unfolding
   走 **mailparser 生产解析路径**（非 mock）；见该文件 R17 / #82 语料用例（ASCII 满 bound）。
