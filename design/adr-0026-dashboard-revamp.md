# ADR-0026：Dashboard 大改版实施方案（阶段 1）

- 状态：Proposed，待业主/总指挥终审；本文不授权直接施工
- 日期：2026-08-12
- 决策范围：Dashboard 信息架构、前端拆分、UI 数据接口与分期施工
- 不在范围：本 ADR 不改变 API 对外协议、会话语义、邮件/任务状态机和托管计费规则

## 背景

当前 Dashboard 的 HTML、CSS 和 JavaScript 全部以模板字符串集中在 `packages/api/src/ui/assets.ts`（3,913 行）。登录、Overview、Inbox、Tasks、Notifications、身份/token 和 Push tier 共用一套全局状态与视图切换。管理端首次登录默认到 Overview；Inbox 只有身份列表、最近邮件列表和正文详情，没有文件夹、邮件元数据栏或 URL 级路由。Tasks 和 Notifications 已能使用，但入口混在地址侧栏里。

代码事实与目标之间有四个重要差距：

1. Tasks 的权威存储不是 `DATA_DIR` 文件，而是 catch-all mailbox 中带服务端 HMAC stamp 的邮件线程；`listTasks()` 每次扫描 IMAP 后重建全部工单。现有 `/ui/api/tasks` 只有单一 state 筛选，`/ui/api/tasks/:id` 只有读取。Bearer API `/v1/tasks/:id/state` 能由任务参与者推进状态，但并不等于 admin 专用催办/关闭。
2. Notifications 的 `/ui/api/notify/messages` 是 `/v1/notify/messages` 的 cookie-session 镜像，数据来自 ntfy `cache-duration: 12h`；客户端为“All channels”逐 topic 扇出。它不是 30 天审计日志。
3. `/v1/notify/devices` 只有 admin 创建动作，返回 ntfy username/password、server URL 和两个 human topic。设备凭据“不落盘”是当前明确安全性质；没有设备名称、配对时间、列表、吊销，也没有 UI cookie-session 镜像。
4. Trust-30d 已通过 `DATA_DIR/ui-sessions.json` 持久化：remembered session 是 30 天 sliding idle，cookie `Path=/ui`、HttpOnly、SameSite=Strict。改版必须保留这一完整语义和现有 Origin/body-limit 防线。

本方案采用“邮件是默认工作面、管理能力归入 Configure、Tasks/Notifications 为一级工作导航”的方向。AgentMail 的邮箱客户端心智模型是基线，但任务、推送与设备是本产品的一等能力，不照搬其组织/计费结构。

## 决策点台账逐条响应

| 编号 | 决策 | ADR 响应与验收口径 |
|---|---|---|
| T1 | UI 可催办/关闭工单 | 新增 admin-only 的 `/ui/api/tasks/:id/remind` 和 `/ui/api/tasks/:id/close`。催办向原 task thread 写一封服务端 stamped reminder，保持 IMAP 为权威历史；关闭写 terminal `failed` 事件，并记录明确的 `closed_by_admin` reason，不做邮件删除。重复操作用当前 terminal state 返回 409，前端二次确认。 |
| T2 | 完成单留近 30 天；周期×条数+翻页 | 列表新增 period=`24h|7d|14d|30d`、limit=`20|50|100`、cursor、status group。默认 active（submitted/working/input-required）优先；terminal 只返回 `updatedAt >= now-30d`。周期是查询窗口，不授权删除 IMAP 线程；“留近 30 天”在 UI 可见性层落实，物理清理由既有邮件 retention 另行决策。 |
| N1 | 通知日志落库 30 天 | 新建 `DATA_DIR/notification-log.jsonl`，在通知真正 publish 成功后写入逻辑 target/topic、level、内容、时间和来源。单进程串行写队列、append-only、0600；每日及启动时清理，采用同目录临时文件+atomic rename 重写最近 30 天。ntfy 仍只是传输/短缓存层。详见“存储选型”。 |
| N2 | 每日推送摘要双处 | `/ui/api/notify/summary?date=today` 同一数据源返回 total、ringCount 及各 level/channel 计数。Overview 数字卡与 Notifications 顶部小结条复用，不分别计算；“今日”按显式 `tz` IANA 时区解释，响应回显区间。响铃定义为 `level=urgent`。 |
| P1 | 设备列表、吊销、添加引导 | 扩展本地设备登记表，创建时保存不可逆/非秘密元数据（device id/name、ntfy username、topics、pairedAt、revokedAt）；password 仍仅创建响应展示一次。新增列表和按 id 吊销，吊销先删除 ntfy user，成功后标记 revoked；UI 通过 `/ui/api/notify/devices` 镜像。 |
| P2 | 自托管/托管权限边界 | 自托管仅 instance admin 管理全部 identity tier 与 human devices；identity session 只读自身 tier，不得列设备。托管版仍以实例内 admin 为主管，平台运营方无跨实例读取/修改 tier、通知内容或设备的后门。未来 control plane 只接收配额/健康聚合，不接收实例内明细。 |

基线细节同时定稿如下：Tasks 顶部为 Active（submitted+working）、Input required、Completed、Failed、All tabs，默认 Active；submitted 超过 4 小时未出现后继事件、working 超过 24 小时未出现后继事件标红，服务端返回 `overdueReason/overdueAt`，避免各浏览器时钟口径漂移；详情保留时间线和可折叠任务原文，RESULT 的 object 渲染为键值表，非 object 采用安全的格式化值；仅 `input-required` 显示回复框，提交后写 `working` 状态事件。

Notifications 支持 channel、level 和日期区间筛选；level 3 的邮件到达内容（正文/OTP）在服务端标记 `sensitive=true`，前端默认显示 `•••`，用户逐条展开且不持久化展开状态；保留“为什么我没收到”入口，显示筛选频道最近一次成功投递时间、通知配置状态和 verify 操作。Push tier 使用三张人话卡片，tier 3 继续要求 `confirm_risk=true`，不允许仅靠前端确认。

## 新信息架构定稿

```text
Dashboard
├─ Operate
│  ├─ Inbox（默认）
│  │  ├─ 身份切换器
│  │  ├─ 文件夹：Inbox / Sent / All Mail（首版）；Scheduled / Trash（能力具备后显示）
│  │  └─ 三栏：文件夹与身份 | 邮件列表 | 正文 + 元数据抽屉（含 OTP）
│  ├─ Overview
│  ├─ Tasks
│  └─ Notifications
├─ Configure
│  ├─ Identities & Tokens
│  ├─ Push & Devices
│  ├─ Authorized Clients
│  └─ Domains（未来，未实现时显示明确 roadmap 空态）
└─ Plan & Usage（托管版预留；自托管显示实例模式说明，不伪造配额）
```

### 为什么调整基线草案

Inbox 改为所有 session 的默认页；admin 也不再以 Overview 落地。这符合“打开就是邮箱”的零学习成本目标，Overview 作为诊断入口而非门户。Tasks 和 Notifications 留在 Operate 一级，不藏入 Inbox 或 Configure，因为它们分别回答“工作卡在哪”和“人是否被触达”。

基线的 `Identities & Tokens` 保留身份和 token 生命周期；Push tiers 与设备强相关，合并命名为 `Push & Devices`，避免用户在两个页面来回对照。现成 `/ui/oauth/grants` 页面迁入 Configure 的 `Authorized Clients`；旧页面/接口保留兼容入口。Domains 与 Plan & Usage 只提供诚实空态/托管预留，不出现可点击但无效的控件。

Inbox 桌面端采用三栏：左栏为 identity switcher 与 folder，中央是邮件列表，右栏是 message detail；元数据在宽屏为右侧内嵌抽屉，在中等宽度折叠为 detail 内 tab，从而不制造四栏。正文提供 Rendered / Plain text / Source 三视图；Source 需要新增受控接口，默认按安全上限截断并永不在列表预取。OTP codes/links 位于详情顶部，保留 copy、域名提醒与隔离 HTML iframe。空态必须说明页面用途并给一个可执行下一步。

移动端不是压缩三栏，而是层级导航：全局导航 drawer → identity/folder → message list → detail；浏览器 Back/应用 Back 均返回上一层。Tasks 同样为 list → detail，Notifications 为筛选抽屉 + 单列卡片。所有 touch target 不小于 44px，敏感通知仍默认遮蔽。

### URL 与视图状态

采用 History API 的真实子路径，而不是只存在内存中的 `state.scope`：

- `/ui` 与 `/ui/inbox`：默认 Inbox；`/ui/inbox/:address/:folder` 可深链，地址必须服务端 ACL 校验。
- `/ui/overview`、`/ui/tasks`、`/ui/tasks/:id`、`/ui/notifications`。
- `/ui/configure/identities`、`/ui/configure/push`、`/ui/configure/clients`、`/ui/configure/domains`。
- `/ui/plan`。

服务端对上述 GET 统一返回 app shell，资源和 `/ui/api/*` 路由优先注册。query 只存非敏感筛选（如 task period/status）；通知内容、token、pair password 不进 URL。旧 `/ui` 书签继续有效；旧 `/ui/oauth/grants` 先 302 到 `/ui/configure/clients`，至少保留两个 minor release，同时 `/ui/api/oauth/*` 不改。

## 组件与文件拆分

### 目标结构

```text
packages/api/src/ui/
├─ shell.ts                    # HTML shell、SVG defs、静态资源标签
├─ styles/
│  ├─ tokens.ts               # 颜色/间距/字体变量
│  ├─ base.ts                 # reset、表单、可访问性、modal
│  ├─ layout.ts               # app shell、sidebar、响应式层级
│  └─ pages.ts                # 各页面样式的显式汇总
├─ client/
│  ├─ app.ts                  # 启动、session gate、全局错误边界
│  ├─ router.ts               # /ui 路径解析、History/Back、ACL fallback
│  ├─ api.ts                  # same-origin fetch、401、AbortController
│  ├─ store.ts                # 单一小型 observable store + session reset
│  ├─ dom.ts                  # 安全 DOM helper；禁止 innerHTML 拼用户数据
│  ├─ components/
│  │  ├─ app-nav.ts
│  │  ├─ identity-switcher.ts
│  │  ├─ empty-state.ts
│  │  ├─ modal.ts
│  │  ├─ paginator.ts
│  │  └─ sensitive-content.ts
│  └─ pages/
│     ├─ inbox.ts
│     ├─ overview.ts
│     ├─ tasks.ts
│     ├─ notifications.ts
│     ├─ identities.ts
│     ├─ push-devices.ts
│     ├─ authorized-clients.ts
│     └─ plan.ts
└─ assets.ts                   # 仅聚合并导出 UI_HTML/UI_CSS/UI_JS/LOGO
```

### 构建与状态决策

阶段 2 仍保持零新增运行依赖、零 bundler、零构建链变化。每个模块继续导出字符串片段，由 `assets.ts` 按固定顺序拼成现有的 `/ui/styles.css` 和 `/ui/app.js` 单资源；浏览器端仍是 CSP `script-src 'self'` 下的 plain ES2019 IIFE，不引入 React/Vue、npm CSS 工具或动态 CDN。理由是当前 API 直接托管资源、测试会钉静态安全契约，引入 bundler 会把 Dashboard 改版与部署/供应链风险绑定，且此规模尚不需要虚拟 DOM。

拆分边界是源码维护边界，不改变对外资产 URL。后续只有在实测证明单 bundle 的解析/缓存成为瓶颈时，另起 ADR 评估原生 ESM 或 bundler。

全局 store 只收跨页状态：principal、identity summaries、route、global navigation；Inbox、Tasks、Notifications 的 filter/page/loading/error/abort controller 都归各 page controller，离页即 cancel。`api.ts` 统一处理 credentials、401 后完整清空所有 principal-bound cache，保留当前“换 token 不闪上一主体数据”的安全性质。组件接受数据和 callback，不直接 fetch。CSS tokens/base 只有一份；页面样式不能重新定义安全颜色、breakpoint 或 modal 语义。

OAuth server-rendered consent page继续独立，因为它承担外部 OAuth handoff 与特定 CSP；Authorized Clients 的列表/吊销改由新 app page 调已有 JSON API，旧 HTML 页面留作兼容 fallback。

## 存储选型：通知日志与设备登记

选择 DATA_DIR 下 owner-only JSONL/JSON 的单写者模式，不引入 SQLite。

理由：本项目现有 `identities.json`、`notifications.json`、`ui-sessions.json` 已采用小型私有文件、临时文件+rename、0600；部署假设是单 API 写者。通知保留仅 30 天，主要访问模式是时间倒序和低复杂度筛选，先做按日内存索引足够。SQLite 会新增运行依赖、镜像和 migration/backup 语义，超出 Dashboard 阶段的必要风险。若 30 天日志达到配置上限（建议 100k 行或 64 MiB）并导致查询 p95 超过 200ms，再以独立 ADR 迁 SQLite。

`notification-log.jsonl` 每行含 schemaVersion、id、publishedAt、source（watcher/manual/task/verify）、logicalTarget、logicalChannel、level、title、message、tags、sensitive、identityAddress（可选）、delivery=`sent`。埋点位于具体 publish 实现内部，在 ntfy 成功响应后、publish 返回前记录；失败不冒充历史，另由 scrubbed audit/metrics 观测。所有发布调用（包括 `verify()` 内部的 `this.publish(...)` 自调用）因此都经过同一成功路径。写入由进程内 promise queue 串行化，启动时验证每行，末尾半行可隔离并报警，中间损坏 fail closed。每日 UTC 维护以及每次启动清理 `publishedAt < now-30d`，在同目录写 `.tmp`、fsync 后 atomic rename；查询同时硬性加 30 天下界，因此即使定时清理延迟也不会泄漏过期行。日志和临时文件均 0600、目录 0700，不写物理 ntfy topic 或 reader secret。

`notification-devices.json` 是小型 atomic JSON 表，保存 id、displayName、ntfyUsername、topic labels、pairedAt、lastSeenAt（当前拿不到则为 null）、revokedAt。password/token 永不保存；吊销依赖保存的 ntfy username。创建与本地登记是一个受控流程：ntfy user 建成后登记失败则 best-effort 删除该 user并返回 502，避免不可管理的幽灵设备。吊销 ntfy user 成功后才写 revokedAt；网络失败保持 active 并允许重试。所有 mutate 仍服从单写者队列。

## UI 数据接口清单

以下均以 cookie-session `/ui/api` 为 Dashboard 主入口；对应 Bearer API 仅在已有或确有外部客户端价值时说明。所有 mutation 继续经过 `requireUiOrigin`、body limit 和 server-side ACL。

### Session、Inbox、Overview、Configure 复用

| 路径 / 方法 | 用途 | 复用/新增 |
|---|---|---|
| `/ui/api/session` POST/DELETE；`/ui/api/me` GET | 登录、Trust-30d、登出、恢复 principal | **原样复用**。不得改变 remembered timeout、cookie 属性、持久化或 Origin gate。 |
| `/ui/api/identities` GET/POST | identity switcher、身份列表/创建 | **复用**；GET projection 已有 token 是否存在与 push tier。 |
| `/ui/api/identities/:address/token` POST | token 轮换，一次展示 | **复用**；不会也不得提供旧 token 明文列表。“token 列表”定稿为每 identity 的 credential slot/status + rotate，而非伪造多 token。多 token 要另做数据模型 ADR。 |
| `/ui/api/identities/:address` DELETE | 删除 identity | **复用**，Configure 中加二次确认。 |
| `/ui/api/identities/:address/push-tier` PUT | 修改 1/2/3 档 | **复用**；tier 3 继续服务端强制 `confirm_risk`。 |
| `/ui/api/oauth/grants` GET；`/ui/api/oauth/grants/:id` DELETE | Authorized Clients 列表/吊销 | **原样复用**。现有 HTML `/ui/oauth/grants` 为 fallback。 |
| `/ui/api/overview` GET | 现有 identity/message window 卡片 | **复用**；通知摘要单独取，避免把快 IMAP 缓存和日志存储绑定为一个失败域。 |
| `/ui/api/messages?address=&limit=` GET | Inbox 邮件列表 | **复用首版 Inbox folder**；当前只按收件身份过滤和最近 N 条。 |
| `/ui/api/messages/:id?address=` GET | 安全文本/HTML 可用性/OTP/links | **复用**。 |
| `/ui/api/messages/:id/seen` POST | 已读/未读 | **复用**。 |
| `/ui/frame/:id?address=` GET | sandbox HTML 正文 | **复用**，不把 HTML 注入 app DOM。 |
| `/ui/api/messages?address=&folder=&cursor=&limit=` GET | Sent/All Mail 与游标分页 | **扩展现有**，folder=`inbox|sent|all`；未知/尚无服务器能力的 folder 返回 400，不显示假入口。响应加 `nextCursor`。 |
| `/ui/api/messages/:id/source?address=` GET | Source 调试视图 | **新增**；同 message ACL，`text/plain` JSON 字段或受控 JSON，大小上限、截断标记、no-store。 |

### Notifications（N1/N2）

| 路径 / 方法 | 用途 | 复用/新增 |
|---|---|---|
| `/ui/api/notify/messages?topic=&since=` GET | 旧 12h ntfy 历史 | **兼容保留但新页面不再作为主数据源**；迁移期可作为日志尚未上线时的 fallback，并明确标“transport cache”。 |
| `/ui/api/notifications?channel=&level=&from=&to=&cursor=&limit=` GET | 30 天日志筛选分页 | **新增**；limit 20/50/100，时间倒序，opaque cursor；identity session 强制为自身 agent channel，admin 可查本实例所有逻辑 channel。响应包含 `sensitive`，但服务端仍返回授权可读内容供显式展开。 |
| `/ui/api/notify/summary?date=today&tz=` GET | Overview 卡与 Notifications 今日小结 | **新增**；返回区间、total、ringCount、byLevel、byChannel、lastSuccessfulAt。仅从本地日志聚合。 |
| `/ui/api/notify/diagnostics?channel=` GET | “为什么我没收到”自查 | **新增**；返回 enabled/configured、该逻辑频道最近成功时间、可执行 verify 权限；不返回物理 topic/secret。 |
| `/ui/api/notify/verify` POST | 主动测试 human push | **新增 UI 镜像，复用** Bearer `/v1/notify/verify` 的 service、权限与 rate limit 语义；仅 admin 或现有可通知授权主体。 |

日志捕获点不是只改 watcher，也不放在外部 `NotifyService.publish()` decorator：必须落在具体 publish 实现的成功路径内，即 ntfy 成功响应后、方法返回前；输入额外携带 `source/logicalChannel/sensitive` 元数据但不进入 ntfy payload。watcher、manual `/v1/notify`、task trusted delivery 和 `verify()` 内部的 `this.publish(...)` 自调用都经过该埋点。这样 N2 不会漏掉非邮件到达推送，也不会因重试先写出未成功记录。

### Tasks（T1/T2 与 input-required）

| 路径 / 方法 | 用途 | 复用/新增 |
|---|---|---|
| `/ui/api/tasks/:id` GET | 详情、timeline、RESULT | **复用**；响应展示层新增 derived result model 可在前端安全转换。 |
| `/ui/api/tasks?status=&period=&limit=&cursor=` GET | status tabs、周期、条数、分页 | **扩展现有**。status=`active|submitted|working|input-required|completed|failed|all`；默认 `active`。响应 `{tasks,nextCursor,totalApprox,queryNow}` 并为每项返回 `overdueReason/overdueAt`。 |
| `/ui/api/tasks/:id/reply` POST | 人在 input-required 时补料 | **新增 UI 专用动作，底层复用** `taskService.update`；body `{body}`，服务端仅允许当前 state=input-required，sender：identity 为自身，admin 必须显式选择任务中的本方 `from`，写 `working` 事件。 |
| `/ui/api/tasks/:id/remind` POST | admin 催办 | **新增**；admin-only，body 可含有上限短文案，底层新增 stamped reminder event。提醒不改变 task state，须扩展 task event kind，不能冒充一次 `working` 转移。幂等 key/最短冷却防双击刷信。 |
| `/ui/api/tasks/:id/close` POST | admin 关闭 | **新增**；admin-only，body `{reason}`，写 terminal `failed` + structured close reason；已 terminal 返回 409。 |
| `/v1/tasks/:id/state` POST | participant 状态推进 | **现有 Bearer API，UI 不直接拿 cookie 调用**；reply/close 的底层状态语义复用它的 task service 与 stamp。 |

分页不能先全量 `listTasks()` 再在 UI 截断作为最终实现。第一版服务端可在单次 IMAP scan 后按 `queryNow` 过滤/排序/切页，并设置 30 秒短缓存；cursor 编码 `(updatedAt,id,query fingerprint)`，签名或 server-generated opaque，避免重复/跳页。后续性能基线若失败，再建立 task summary index，但 IMAP stamped thread 仍是权威。超时判定：submitted 以 createdAt/最后 submitted 事件 +4h；working 以进入 working 的最后事件 +24h；input-required 不按该两条标红。`queryNow` 由服务端一次取值，避免页间漂移。

### Push & Devices（P1/P2）

| 路径 / 方法 | 用途 | 复用/新增 |
|---|---|---|
| `/ui/api/identities` GET + push-tier PUT | 每身份当前档位、三卡切换 | **复用**，权限为 admin 修改；identity 只看到自身 projection。 |
| `/v1/notify/devices` POST | 生成 human device username/password | **现有但需兼容扩展**：请求加入 `displayName`，成功登记 device id；仍要求 publicUrl 精确匹配和 HTTPS，密码只显示一次。旧请求保持可用，可生成默认名称。 |
| `/ui/api/notify/devices` GET | 已配对设备列表 | **新增**，admin-only；仅返回非秘密登记元数据。 |
| `/ui/api/notify/devices` POST | Dashboard 添加设备/一次性凭据 | **新增 UI 镜像，复用扩展后的 create service**；admin-only，响应包含一次性 password 与 QR 所需最小 payload，并 `Cache-Control: no-store`。 |
| `/ui/api/notify/devices/:id` DELETE | 吊销 | **新增**，admin-only；删除 ntfy user 后标记 revoked，重复吊销幂等 204。 |
| `/v1/notify/devices` GET；`/v1/notify/devices/:id` DELETE | CLI/外部管理 | **新增 Bearer 等价接口**，admin-only；与 UI 共用同一 device service，避免两套权限/事务实现。 |

接口复用结论：现有 session、identity CRUD/token rotate/push tier、OAuth grants、Overview、邮件读/seen/frame、task detail 共 14 个 method-level 能力直接复用；旧通知历史 1 个兼容保留；扩展 3 个现有接口族（messages list、tasks list、device create）；新增 13 个 method-level 能力，集中在 30 天日志/摘要/诊断、task 人工动作、device 生命周期和 source view。新增不是重写既有 `/ui/api`，而是补齐当前数据模型不存在的能力。

## 分期 PR 施工计划

每期合入即能独立上线、可回滚；后一期增强前一期，但不存在“必须等后一期页面才可用”的隐藏半成品。功能在其数据/API/UI/测试齐备的同一 PR 内启用；必要 schema 采用向后兼容读取。

### PR 1：前端模块化与新壳（低行为风险）

范围：按上述结构拆 `assets.ts`，保持输出契约；加入全局 nav、真实 `/ui/*` shell 路由、旧 URL fallback；Inbox 作为默认页，现有 Inbox/Overview/Tasks/Notifications/identity 操作全部接入新 nav，不增加后端能力。

验收：同一套现有 API 功能无回归；admin/identity 登录落 Inbox；刷新所有新路径不 404；OAuth 回跳、401 cache 清理、CSP、375px 导航、键盘焦点通过；静态资源仍零依赖。改动面：`src/ui/**`、UI asset/shell routes、相关 UI tests。

### PR 2：Inbox 邮箱客户端闭环

范围：identity/folder/list/detail 三栏；Inbox/Sent/All Mail、游标；Rendered/Plain/Source、元数据与 OTP；定制空态。若 Scheduled/Trash 后端未具备则不显示。

验收：admin 切身份、identity 只能读自身；三 folder 返回正确集合；Source 限长/no-store；HTML 仍 sandbox；桌面三栏、移动逐层 Back；首屏邮件可读。改动面：IMAP query、`routes/ui.ts`、frame/source、Inbox modules/tests。

### PR 3：30 天 Notifications 完整闭环

范围：notification log store、具体 publish 实现成功路径内的统一埋点、30 天清理、查询/摘要/诊断/verify UI API；Notifications 筛选、遮蔽、小结；Overview 两张通知数字卡。埋点须覆盖 `verify()` 的 `this.publish(...)` 自调用。部署后从零开始积累日志，不回填 ntfy 12h（避免无法证明来源/敏感标记的伪审计）。旧 history 保留。

验收：各 publish 来源成功才恰好写一行；失败/取消不写；重启保留、31 天清理、损坏处理、权限隔离；Overview 与 Notifications 对同一日/时区数字一致；tier 3 默认遮蔽；未启用 ntfy 给诚实诊断。改动面：新 log store、notify service/watcher/tasks、UI routes/pages/tests、DATA_DIR 运维文档。

### PR 4：Tasks 工单板闭环

范围：服务端筛选/周期/游标/超时字段；Active 默认 tabs；RESULT 键值表；input-required reply；admin remind/close 和 stamped reminder event。

验收：24h/7d/14d/30d × 20/50/100 每个组合可翻页且无跨筛选 cursor；terminal 超 30 天不可见；4h/24h 边界用注入时钟测试；identity ACL、admin-only remind/close、重复/并发 terminal 409；reply 只在 input-required；邮件线程可完整重建所有新事件。改动面：tasks lib/routes/UI/tests，必要的短缓存；不迁移权威存储。

### PR 5：Configure 完整闭环

范围：Identities & Tokens 页面（单 token slot 诚实展示与 rotate）、Authorized Clients 迁入、Push tier 人话卡；Domains/Plan 诚实预留。旧 OAuth grants 页面继续兼容。

验收：创建/删除/rotate 的一次性 token 仪式；tier 3 服务端确认不可绕过；identity session 无越权 controls；OAuth grant 吊销即时有效；自托管不显示虚假套餐/升级。改动面：Configure pages、少量 shell/UI route、现有接口集成 tests；后端业务能力基本复用。

### PR 6：设备管理完整闭环

范围：device registry/service、create 补登记、list/revoke 的 UI/Bearer API、Push & Devices 面板与添加引导/一次性 QR payload。

验收：创建凭据只展示一次且磁盘无 password/token；列表有名称/频道语义/配对时间；吊销后 ntfy user 立即失效；登记失败不留幽灵 user；identity 和平台运营主体不能访问；旧 POST client 兼容。改动面：notify lib/routes、UI pages、DATA_DIR migration/tests、ntfy integration tests。

排序理由：先解除 4k 单文件的施工冲突，再交付核心 Inbox；日志必须尽早开始积累，所以在视觉 Configure 之前；Tasks 和 Configure 各自使用现有后端可独立上线；设备涉及 ntfy 跨存储事务，最后单独隔离风险。若业务要求优先设备，可交换 PR 5/6，不影响独立验收。

## 风险、兼容与缓解

### Trust-30d 与认证

不修改 `UiSessionStore` 的 timeout、sliding lastSeen、5 分钟持久化节流、hash-only disk 格式、cookie 名/Path/SameSite/Secure/HttpOnly。新 shell 和所有子路径都在 `/ui` 下，因此 cookie Path 继续覆盖。所有新 unsafe UI API 仍位于 `/ui/api/*`，沿用 body limit 和 `requireUiOrigin`；不得绕到 server-rendered page handler 做 mutation。回归测试必须包含容器重启后 remembered session、普通 browser-session、过期和 token 吊销。

### DATA_DIR 单写者

JSONL/JSON 方案明确依赖单 API writer；不得在共享 DATA_DIR 上水平启动多个写实例。所有 append、compaction、device mutation 走进程内同一 serial queue，temp 与目标同目录以保证 rename 原子性。崩溃恢复、磁盘满、只读卷、corrupt file 都必须有启动/运行测试和明确健康告警。日志内容可能含 OTP/正文，权限固定 0600，不进普通 console log、audit 或托管 control plane；备份/删除策略必须同步 30 天要求。

### 任务性能与语义

IMAP 全扫描是分页最大的性能风险。服务端短缓存和先过滤切页只能减少重复解析，不能让首次 scan 成为真正 O(page)。每个施工 PR 要记录 1k/10k task messages 基准；超过预算时另建可重建 summary index，不能悄悄把 JSON index 变成第二权威。催办必须是 event kind，不伪装状态；关闭映射 `failed` 是现有状态机兼容选择，UI 显示“Closed”原因而不是误称执行失败。

### 通知一致性

成功 publish 与本地 append 无跨系统原子事务：ntfy 成功而落盘失败会产生少量漏记。选择“先发送、后记录”，因为通知送达优先且日志不能声称失败推送成功；append 失败触发高优先级本地健康告警。不得先记后发。日志 id 使用本地 UUID 并可保存 provider response id（若未来提供）来支持重试去重。

### URL、用户习惯与渐进发布

`/ui` 永远有效并落 Inbox；新 deep link server fallback 必须在 API/assets/frame/OAuth routes 之后注册，防止吞路由。首次上线提供 Overview 原位置的迁移提示与 nav 高亮；筛选默认值按新设计，但用户可一键选 All。旧 `/ui/oauth/grants` 和 `/ui/api` 契约保留。History state 不放 credential/message 内容，刷新/Back 有端到端测试。

### 移动端、可访问性与安全

移动端一次只显示一个层级，不能横向滚动模拟桌面表格；列表筛选收进 drawer，主要动作保持 44px。焦点在导航、详情、modal 关闭后有确定回位，loading/error 用 `aria-live`，状态不能只靠颜色。通知敏感内容默认遮蔽；展开按钮需明确 aria label，切换频道/登出立刻清除展开与缓存。HTML 邮件仍只进 sandbox iframe，Source 以 text node 展示；所有用户数据继续用 `textContent`。

### 托管边界与预留页面

Plan & Usage 在没有真实 control-plane contract 前只显示 deployment mode 和文档链接，不在实例内推算账单。未来托管数据接口必须是 instance-scoped aggregate；运营方凭据不得被 instance API 解释为 admin，也不得读取 tier/device/notification/task 明细。Domains 同理需待多后缀路由、证书和 identity scope 另行 ADR 后启用。

## 被明确割舍的内容

- 不引入 React/Vue/bundler/SQLite：当前收益不足以覆盖部署、迁移与供应链变化。
- 不承诺多 token 列表：现状每 identity 只有一个 hash slot；本期做状态与 rotate，不能把一次性历史 token 冒充可管理列表。
- 不回填 ntfy 12h 到 30 天日志：缺少可靠 source/sensitive/逻辑 channel 元数据，回填会降低审计可信度。
- 不在本 ADR 同时做 Compose、Drafts、Scheduled、Trash、搜索、Metrics 图表、Domains 或计费：后端能力尚不完整，空控件会破坏“每期可上线”。
- 不物理删除 30 天前 task 邮件：它会改变邮件 retention 与 IMAP 权威历史；本决策只约束 Dashboard terminal task 可见窗口。
- 不把 OAuth consent page 强塞进 SPA：外部 handoff/CSP/未登录回跳的独立安全边界应保留。

## 附录：基线与实现依据

设计基线：

- `/home/ops/design-26/research-2026-08-12-agentmail-console.md`，尤其 §一、§三、§五。
- `/home/ops/design-26/design-26-panels.md`，Tasks / Notifications / Push & Devices 详细逻辑与 2026-08-12 业主拍板项。

实现核对（基于分支起点 `5836d5f`）：

- `packages/api/src/ui/assets.ts`
- `packages/api/src/routes/ui.ts`
- `packages/api/src/lib/ui-session.ts`
- `packages/api/src/lib/notification-watcher.ts`
- `packages/api/src/lib/notify.ts`
- `packages/api/src/routes/notify.ts`
- `packages/api/src/routes/identities.ts`
- `packages/api/src/routes/tasks.ts`
- `packages/api/src/lib/tasks.ts`（仓库不存在 `task-store.ts`；任务权威存储为 IMAP）
- `packages/api/src/routes/ui-oauth.ts`
- `packages/api/src/app.ts`
