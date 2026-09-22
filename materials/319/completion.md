# #319 完工件 · 附件能力对照研究（vs AgentMail）+ Composio 附录

- **分支**：`tizerluo/w319`
- **性质**：研究文档，**零产品代码改动**
- **矩阵主件**：`materials/319/attachment-comparison-matrix.md`
- **探针脚本**：`materials/319/probe-attachments.ts`（本地 `server.fetch` / webhook sink，勿打生产）
- **原始 stdout**：`materials/319/probe-stdout.txt`（另 `probe-results.json`、`probe-run.log`）
- **官文快照**：`agentmail-attachments.snapshot.md` + meta `snapshot_at_utc=2026-09-22T10:58:06Z`
- **自审 subagent**：`c4c3fbd8-b391-4a81-9569-8d31dacf0755` → **PASS_WITH_NITS**（行数自报需校正；红线全过）

## 1. 矩阵表

见主件 `attachment-comparison-matrix.md`（8 轴 × 3 列）。摘要：

| 轴 | 对方（官文） | 我方（实测） |
|---|---|---|
| Base64 / URL 发送 | 支持 | **无**；键被剥离后仍 **200**（非 400） |
| 消息 / 线程下载 | 按 `attachment_id` | **404**，无路由 |
| 内联 / URL 上限 | 6 MB / ~30 MB | 无附件常量；text/html 1e6 + 体 16 MiB |
| URL 可达性 | 无自定义鉴权头等 | 无实现 |
| webhook | 本页未写 | **仅** `hasAttachments: true` |

## 2. 五组受控实测：预期 vs 实测

> 环境：本机 Bun + `createApp`/`server.fetch`；`DATA_DIR` 临时目录；SMTP mock。  
> 命令：`bun materials/319/probe-attachments.ts`（于仓根）。

| 组 | 预期（任务卡/R0） | 实测 | 原始摘录 |
|---|---|---|---|
| **G1** Base64 `attachments[]` | 400 strict | **200** `queued:true`（键剥离） | 见下方 G1 原文 |
| **G2** URL `attachments[]` | 400 | **200** `queued:true` | 见下方 G2 原文 |
| **G3** 无附件基线 | 201 | **200** `queued:true`（本仓成功码） | 见下方 G3 原文 |
| **G4** 尺寸 | 边界码 | G4a/c→200；G4b/d→400；G4e→413 | 见下方 G4 原文 |
| **G5** webhook 附件入站 | 仅 `hasAttachments:true`、无内容字段 | **通过**；`leaked_content_keys=[]` | 见下方 G5 原文 |
| 附 **MCP** | 同 REST、无独立入口 | 200 queued；schema 无 attachments | 见下方 MCP 原文 |

**偏差说明（事实，非返工理由）**：R0 称 `sendSchema`「`.strict()` → 多余键 400」——源码 `send.ts:41-47` **无** `.strict()`；故 G1/G2 与「预期 400」不一致。矩阵与本完工件均以原始响应为准。

### 2.1 原始 stdout 摘录（自 `probe-stdout.txt`）

```
[G1] status: 200
  body: {"queued":true,"messageId":"<probe-319@test.example>","id":"snd_1ba58753789b40394f0b89a8"}

[G2] status: 200
  body: {"queued":true,"messageId":"<probe-319@test.example>","id":"snd_21bf7c21a0ce8f20153134d2"}

[G3] status: 200
  body: {"queued":true,"messageId":"<probe-319@test.example>","id":"snd_b1fd3d8433c8f2219532ba5b"}

[G4a] text=1e6 → status: 200
[G4b] text=1e6+1 → status: 400
  body: {"error":"invalid_request","details":[{"origin":"string","code":"too_big","maximum":1000000,...,"path":["text"],...}]}
[G4c] html=1e6 → status: 200
[G4d] html=1e6+1 → status: 400 (path html / too_big)
[G4e] rawBodyBytes=17825889 → status: 413
  body: {"error":"request_too_large"}

[G5] hasAttachments_parsed=true leaked_content_keys=[]
  payload data.hasAttachments=true；data_keys 含 object/address/messageId/cursor/uid/.../hasAttachments/textPreview/...
  无 attachments / content / files 等键

[MCP] status: 200 → structuredContent.queued=true（arguments 含 attachments 仍成功）
[MCP-schema] hasAttachmentsProp=false
[ROUTE messages/.../attachments/...] status: 404
[ROUTE threads/.../attachments/...] status: 404
```

全文见 `probe-stdout.txt`（94 行）与 `probe-results.json`。

## 3. 官文快照路径与时间

| 源 | 路径 | 抓取 UTC |
|---|---|---|
| AgentMail Attachments | `materials/319/agentmail-attachments.snapshot.md` | **2026-09-22T10:58:06Z**（`agentmail-attachments.snapshot.meta.txt`） |
| 页面 URL | https://docs.agentmail.to/attachments （抓 `.md`） | 同上 |
| Composio 9-21 changelog | `materials/319/composio-changelog-2026-09-21.snapshot.md` | 同批 meta |

## 4. Composio 九项附录（P2，无迁移）

> 注：批复/简报所称「现有 Composio 对照矩阵」经亲核**不存在文件**（四仓无落点）；**本附录即其替代落点**。  
> 三列 = 发布说明 | 公开产品证据 | 本席实测。实测列一律「**无我方依赖，未测**」。  
> 主来源：https://docs.composio.dev/docs/changelog/2026/09/21.md（快照文件同上）。

| # | 项 | 发布说明 | 公开产品证据 | 本席实测 |
|---|---|---|---|---|
| 1 | Python SDK **0.22.0** | changelog 发布表列 Python `composio` 0.22.0 | PyPI `composio==0.22.0` upload ~2026-09-21T19:11:57Z（`composio-pypi-0.22.0.evidence.json`） | **无我方依赖，未测** |
| 2 | TypeScript **0.19.0** | `@composio/core` / `@composio/slim` 0.19.0 | npm `@composio/core@0.19.0` published 2026-09-21T19:22:34.667Z（`composio-npm-core-0.19.0.evidence.json`）；`dist-tags.latest=0.19.0` | **无我方依赖，未测** |
| 3 | auth-config 单次获取 **50→200** | 「Auth Configs Fetch Limit Raised to 200」 | 同上 changelog 节 | **无我方依赖，未测** |
| 4 | `session.config` | TS session 暴露服务器返回配置 | changelog「Sessions expose more state…」 | **无我方依赖，未测** |
| 5 | `ensureConnected()` 连接复用 | 复用已有连接、避免重复授权 | 同上节 | **无我方依赖，未测** |
| 6 | allowlist 保留 | Py/TS MCP 保留 tool-only allowlist、auth config 选择、手动连接意图 | 同上节 | **无我方依赖，未测** |
| 7 | 跨源重定向凭据剥离 | 跨源重定向移除凭据 | 「Network safeguards…」 | **无我方依赖，未测** |
| 8 | IPv4+IPv6+过渡段阻断 | 拒绝额外 IPv4/IPv6/过渡网络范围 | 同上 | **无我方依赖，未测** |
| 9 | 可选严格 SSRF 模式 | TypeScript 提供可选严格 SSRF（连接钉在已校验地址） | 同上 | **无我方依赖，未测** |

## 5. 第六节 · 要不要做附件能力（只写事实与代价）

**不做承诺、不给倾向性结论。** 产品级决定由总指挥另呈业主。

### 对方有什么（官文口径，非我方复现）

- 发送：`attachments[]` 支持 Base64 `content` 与可抓取 `url`
- 下载：消息 / 线程两侧按 `attachment_id` 取原始字节
- 上限：内联整请求 6 MB；URL 附件合计约 30 MB
- URL：无自定义 header/cookie；允重定向与预签名；最终 2xx

### 我方没有什么（本卡实测 + 源码锚点）

- 无 attachments 请求字段（键存在则**静默丢弃**，调用方可能误以为已附上）
- 无 SMTP 附件投递、无 blob/存储、无 attachment_id、无消息/线程下载路由
- webhook **只有** `hasAttachments` 布尔，无内容、无 id、无 URL
- MCP `mail_send` 与 REST 同面，无独立附件工具

### 若做，大致动哪些面（代价清单，非方案）

| 面 | 可能触及 |
|---|---|
| Schema | `sendSchema` / MCP `mail_send` inputSchema；是否 `.strict()`；Base64 vs URL 两种形态校验 |
| SMTP | `smtp.ts` `sendMail` 增加 nodemailer attachments；错误码与限流 |
| 下载端点 | `messages`（及是否引入 threads）+ 鉴权/scope |
| webhook 表示 | 仅布尔 vs 元数据列表 vs 内容/URL；payload 尺寸与敏感字段 |
| 尺寸常量 | 与现有 text/html 1e6、整请求 16 MiB、webhook payload 上限的关系 |
| 存储 / blob | 持久化、保留期、病毒扫描、磁盘配额（今日无 blob 子系统） |
| 文档 / 对外表 | 公开能力表、website compare（**本卡明确不动**；若产品决定另卡） |
| 安全 | URL 抓取 SSRF、重定向、预签名、私网阻断 |

## 6. 未验证清单

- AgentMail：一切运行时行为（发送、超限、下载、webhook 附件字段）
- 我方：生产环境、真实 SMTP 投递后对端是否收到「被剥离的附件」、IMAP 入站以外的 webhook 传输层落盘原文（本探针断言的是 sink→`formatMailPayload` 形态）
- Composio：全部九项运行时（无依赖）
- 「现有 Composio 对照矩阵」文件本体（确认不存在）

## 7. 行数统计（`wc -l`，终稿）

| 文件 | 行数 |
|---|---|
| `attachment-comparison-matrix.md` | **51** |
| `completion.md`（本文件） | **156** |
| 文档合计（矩阵+完工） | **207**（目标带 200–350；未超 600） |
| `probe-attachments.ts` | 561（脚本；不计文档额度） |

## 8. 红线自检

- [x] 零产品代码改动（仅 `materials/319/**`）
- [x] 不写公开 docs、不动 website
- [x] 未实测标「未验证」；未据官文写我方兼容结论
- [x] 只本地/开发态 API
- [x] 第六节无承诺句

## 9. Subagent 自审

- **agent id**：`c4c3fbd8-b391-4a81-9569-8d31dacf0755`
- **结论**：**PASS_WITH_NITS**
- **要点**：红线全过；产品 diff 空；G1/G2 与预期 400 的偏差已如实记录；G5 仅元数据；Composio 九项实测列合格。Nit：初稿行数自报偏高、合计略低于 200——本修订补原始摘录并校正 §7。
