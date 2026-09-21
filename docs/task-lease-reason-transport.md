# Task lease release-reason 传输面指引（8k bound）

[Back to operator guide](operator-guide.md) · [Task lease journal](task-lease-journal.md)

本页是操作者指引（guidance only）：说明 `TASK_LEASE_REASON_MAX_CHARS = 8_000`
（`packages/api/src/lib/tasks-internal.ts`）在邮件传输头上的体积账与互操作风险。
**不改协议 bound、不做 truncate、不新增 telemetry。**

载荷形态是 **canonical JSON → base64url**，放在 `X-OA-Task-Lease-Payload`
（解析名 `x-oa-task-lease-payload`）。这是结构化 lease 事件编码，**不是**
header injection。

## 量化账：8k reason → 头体积

双闸按 `reason.length`（JS 字符串长度 = **UTF-16 code units**）计量，**不是**
UTF-8 字节数。满 8_000 units 时，头体积随字符编码 **与 JSON 转义** 剧烈变化。

分层说明（勿混层）：

- **不是**「8000 个 4-byte 字符 → ≈43KiB」：astral/emoji 每字占 **2** UTF-16 units → 8000 units 最多 4000 字 = 16_000 UTF-8 B，小于 BMP 层。
- **BMP 层最坏**（如 `界`×8000）：每字 3 UTF-8 字节 → JSON ≈24.1KiB → payload ≈**31.3KiB**。
- **JSON 转义层最坏**（之上还有一层）：`JSON.stringify` 对 NUL（`\u0000`）/ lone surrogate 等每单元输出 **6** ASCII 字节（`\uXXXX` 形）→ 双闸 `.length` **照样放行**。

| 量 | 全 ASCII（`r`×8000） | 全 BMP 3-byte（`界`×8000） | **JSON 转义最坏**（`\u0000`×8000） | 说明 |
| --- | --- | --- | --- | --- |
| `reason.length`（双闸，UTF-16 units） | 8_000 | 8_000 | 8_000 | core + REST zod `.max(8_000)`；超限 **reject-not-truncate**；三列**都过闸** |
| reason 单字段 `JSON.stringify(reason)` | ≈8_002 B | ≈24_002 B | **48_002 B** | 仅 reason 字符串字段，**不是**完整 lease 事件体 |
| 完整事件 canonical JSON 体 | ≈ 8.1–8.3 KiB | ≈ **24.1 KiB** | **48_181 B**（#82 NUL 用例实测） | 含 `version` / `event` / `actor` / `at` / `generation` / `tokenVerifier` + reason |
| `X-OA-Task-Lease-Payload` base64url | **≈ 10.9 KiB** | **≈ 31.3 KiB** | **64_242 chars ≈ 62.7 KiB**（#82 NUL 用例实测） | `ceil(jsonBytes / 3) * 4` |
| 折行后线上行数 | 视 MTA 折行宽 | 同左 | 同左，显著更多 | 生产解析 **接受 MIME 中介重折**（strip 空白后再严格 base64url） |

演算核对（写全；估算式仅辅助，权威以用例实测为准）：

- ASCII：`ceil(8100 / 3) * 4 = 10800` → ≈ **10.55–10.9 KiB**（#82 ASCII 回归 payloadChars=10908）
- BMP：`ceil(24100 / 3) * 4 ≈ 32134` → ≈ **31.3 KiB**（#82 CJK 活证据 payloadChars=**32242** ≈31.49KiB——**BMP 层实测；JSON 转义层更高见上行 / NUL 用例**）
- **JSON 转义最坏**：
  - reason 单字段 stringify = **48_002** B（`JSON.stringify('\u0000'.repeat(8000))`）
  - 完整事件体 + payload：**48_181** B / **64_242** chars（`8k NUL reason dual-gate + production payload length` 用例，与 CJK 同路径读 `sent[1].headers['X-OA-Task-Lease-Payload']`）
  - 粗算：`48000 * 4 / 3 = 64000` 仅作数量级估算，**勿**与单字段 48002 直接拼成「64112」冒充完整 payload
- 对照：8000 units 全 astral → ≤16_000 UTF-8 B → payload ≪ 31.3KiB，**不是**最坏

## 自部署 Postfix：`header_size_limit`

捆绑栈 / 常见自托管 Postfix 默认：

- 参数：`header_size_limit`
- **默认 102400 字节（100 KiB）**（单个逻辑头，含已折叠续行）
- 公开来源：[Postfix postconf(5) `header_size_limit`](https://www.postfix.org/postconf.5.html)

注：该上限按**单个逻辑头**独立约束——其他头（Received/DKIM 等）各自独立受同一上限，非与 lease 头共享一个池；整信总大小另受 `message_size_limit` 约束。

相对 JSON 转义最坏 ≈**62.7 KiB**（64242 chars），`header_size_limit` 的纸面预算 102400 理论上能容纳——**但绑定栈实测推翻了这个余量观感**：单头实际 ~**59,820 字符**即被静默截断（见下文「绑定栈实物实测」小节），勿按 1.6× 余量做容量规划。若操作者把
`header_size_limit` **调小到接近或低于** max-bound payload（再加其它头），
cleanup 会丢弃超额头文本。调小前请用 `postconf header_size_limit` /
`postconf -d header_size_limit` 核对，并在 dogfood 做满 bound（含控制字符）往返。

### 绑定栈实物实测（2026-09-21，OAE↔OAE 同实例往返，3 档满 bound）

在同一条真实出站链（API → 绑定 docker-mailserver/Postfix 3.7.11 → 本域投递 → catch-all 信箱）上，
用产品真实 task lease `release` 事件（`X-OA-Task-Lease-Payload`）发三档满 8_000 UTF-16 单位的 reason：

| 档 | canonical JSON（签名） | payload（签名字符数） | 实际到达 | 结论 |
| --- | --- | --- | --- | --- |
| 全 ASCII | 8_188 B | 10_918 | 10_918（11 续行） | 完整送达 |
| 全 BMP（`界`） | 24_188 B | 32_251 | 32_251（33 续行） | 完整送达 |
| JSON 转义最坏（NUL） | 48_188 B | **64_251（≈62.7 KiB）** | **59_820（60 续行，尾部丢失）** | **被静默截断** |

- 单头**实际上限 59_820 字符**（60 续行 × 997 payload 字符）：实测 64_252 与 61_000 字符的单头诊断信（无产品载荷）同样落在 59_820；32_251 字符档完整。
- 截断发生在 **mailserver 侧**（postfix 队列体积 `size=60683` 已小于完整体量；nodemailer 本地对照证明发信侧发出的是完整值；发信侧 HMAC `X-OA-Task-Stamp` 覆盖的是**完整** 64_251 字符载荷）。
- postfix 只记录折行（`breaking line > 998 bytes with <CR><LF>SPACE`），**没有任何截断告警** → 操作者无法从中继日志察觉。
- 推论：本页上文「默认 102400 仍能容纳 62.7 KiB、余量 ≈1.6×」在绑定栈上**不成立**；`header_size_limit` 不是这条路径的真实天花板。

同批实测的收件侧解析（决定「送到 ≠ 能还原」）：

- mailparser 交出的头值会保留折行空白（空白数 = 续行数 − 1）；**payload ≳997 字符起必带空白**，短载荷（单续行）不带。
- 未含重折容忍的解析器（≤13ea2ca）对三档**全部拒收**（`roundtrip_mismatch`）；含重折容忍的解析器（≥33a2cc1 / 本页所述 strip 空白实现）对 ASCII/BMP 档**逐字节还原成功**（长度 + sha256 一致），对完整 64_251 字符的 NUL 档也能还原（反事实验证）。
- 因此：**部署早于 33a2cc1 的实例，8k reason 的 release 事件会「送达但永久不被承认」**（进程内 overlay 会短暂显示成功，重启/重读后 lease 仍在）。

## 常见商用中继 / 邮箱商头上限（公开文档；**未实测**）

下表摘自各厂商**公开文档**，仅作风险提示。本仓库**未**对下列商用路径做
满 8k reason 实弹投递；**一律标注「未实测」**，不得当作交付承诺。

（2026-09-21 更新：**自托管绑定栈**一行已完成实测并写回上表；下列四行**商用**路径仍为未实测——
#301 的商用半边需要业主提供的测试账号。）

| 路径 | 公开口径（摘要） | 来源 | 对 8k reason 头的粗判 | 实测状态 |
| --- | --- | --- | --- | --- |
| **自托管绑定栈（docker-mailserver/Postfix 3.7.11，OAE↔OAE 同实例）** | 单头 `header_size_limit` 默认 102400 | 本仓实测（#301 前半） | ASCII/BMP 档完整；**JSON 转义最坏档被静默截断到 59_820 字符**（实际单头上限 59_820，非 102400） | **已实测 2026-09-21**（同机同镜像沙箱 API 进程 + 真实 postfix + 真实 mailserver，见本页实测小节） |
| Google Gmail / Workspace | 单头 value 上限 32KB；全头合计 500KB；头字段数 5000 | [Gmail message header limits](https://support.google.com/a/answer/14016360) | ASCII ≈10.9KiB 低于 32KB；**BMP ≈31.3KiB 贴线**；**JSON 转义最坏 ≈62.7KiB（64242）明确超其单头 32KB——满 bound 控制字符 reason 经 Gmail 必丢** | **未实测**（仓内 #82 NUL 用例仅证 wire 体积，非 Gmail hop） |
| Microsoft Exchange / 文档化 Receive connector | 全部头字段合计默认 **256 KB**（`MaxHeaderSize`） | [Message size and recipient limits (Exchange)](https://learn.microsoft.com/en-us/exchange/mail-flow/message-size-limits) | 合计 256KB 对 ≈62.7KiB 通常仍够用；Exchange Online 现场是否同值以租户为准 | **未实测** |
| Amazon SES | 公开配额主写**整信**大小（含附件）；SNS 通知路径另有「headers 10KB」类限制（通知面，非 SMTP 出站主路径） | [SES service quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html) | SMTP/API 出站整信配额远大于 62KiB；勿与 SNS header 配额混读 | **未实测** |
| 其它 SMTP 中继（SendGrid / Mailgun 等） | 多数公开材料写整信/附件上限，**少有**单独的单头 KiB 表 | 各厂商当前 docs | 遇拒信时查 SMTP 应答与中继状态页；不要假设与 Postfix 默认相同 | **未实测** |

## 存储增长账

每条 **max-bound** release 回执（满 8k UTF-16 units）相对短 reason：

- 出站 MIME / IMAP 存档（payload 头；另加折行 CRLF/WSP）：
  - 全 ASCII：约 **+10.9 KiB** 级
  - 全 BMP 3-byte：约 **+31.3 KiB** 级
  - **JSON 转义最坏**（NUL / lone surrogate）：约 **+62.7 KiB** 级（#82 NUL 用例 payloadChars=**64242**）
- Durable rebuild（`taskFromMessages` 等从信箱重建）：同步放大——长 reason 进入
  `releasedLease.reason` 与相关持久化视图；历史越长、满 bound 回执越多，磁盘与
  rebuild CPU 线性上升（最坏按 JSON 转义膨胀计）
- Pending journal / 其它 lease 旁路：本页不展开；见 [task-lease-journal.md](task-lease-journal.md)

## 操作建议（短）

1. 保持双闸 8k；不要在中继侧「截断 reason」冒充成功。
2. 自托管 Postfix 勿盲目下调 `header_size_limit`；同时**勿按其纸面预算做容量规划**——绑定栈实测单头 ~59,820 字符即静默截断（纸面 102400 不是真实天花板，见实测小节），满 bound 多字节/控制字符档按「可能被判丢」设计。
3. 经商用中继前，用公开表做风险预判；**勿对 Gmail 使用满 bound 多字节或控制字符 reason**（62.7KiB 必超 32KB 单头）；BMP 贴线亦应实测（**未实测**条目不得省略）。
4. 回归：`packages/api` 内 `task-lease-core` 对 8k reason 的 folding/unfolding
   走 **mailparser 生产解析路径**（非 mock）；见该文件 R17 / #82 语料（ASCII + CJK + NUL 满 bound）。
   生产 `readLeaseEventPayload` **接受 MIME 中介重折**：对头值 strip 全部空白后再做
   严格 base64url round-trip 校验。安全性：base64url 字母表不含空白，删除无歧义；
   非法非空白字符（如 `!!!!`）strip 后仍拒——容忍重折 ≠ 容忍垃圾。

5. 绑定栈上**单头 ~59_820 字符即被静默截断**（2026-09-21 实测）：不要假设 `header_size_limit`
   一定生效；满 8k reason 的多字节 / 控制字符档在自托管路径上要按「可能被判丢」设计——收件侧至少
   应把「解析失败」与「从未发生」在可观测面上区分开，并避免单条坏事件把整条 task 拖成不可读。
6. 收件侧解析器必须 ≥ 33a2cc1（重折容忍）；**升级读取端先于任何满 bound 实测**，否则量到的是
   「解析器丢」而不是「传输丢」（页首三档量化账的完成度也依赖这一点）。
