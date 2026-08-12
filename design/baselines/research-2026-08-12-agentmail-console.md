# AgentMail Console 对标调研 v2（#26 Dashboard 大改版设计输入）

> 2026-08-12 Kimi@MBP2。v2 升级：基于业主实拍的 19 张逐页截图（`~/Kimi-workspace/AgentMail Dashboard/`）+ 实操（建收件箱/API 发信）。
> v1 结论不变，本版补齐**页面逻辑架构**与逐页细节。

## 一、页面逻辑架构（信息架构全图）

### 导航三层分组（左侧栏，固定）

```
AgentMail
├─ [组织切换器]  Tizer's organization · FREE TIER
│
├─ Operate（运营——每天看的）
│   ├─ Overview      数字总览 + 活动图 + Unified Inbox 预览
│   ├─ Inboxes       收件箱列表 + 配额进度条
│   └─ Metrics       收发时间图 + 投递诊断
│
├─ Configure（配置——开发者用的）
│   ├─ Domains       自定义域（免费档锁→升级引导）
│   ├─ Webhooks      事件回调
│   ├─ API Keys      组织级密钥
│   └─ Lists         组织级 Allow/Block
│
├─ Organization（组织——管钱管人的）
│   ├─ Plan & Billing   套餐 + PLAN LIMITS 用量表
│   └─ Upgrade          转化页
│
└─ [底部] Discord / Documentation / Feedback / 用户头像
```

### 页面跳转逻辑（面包屑体现的层级）

```
Dashboard
 └─ Inboxes（列表）
     └─ {inbox}（如 oae-research@agentmail.to）—— 完整邮箱客户端
         ├─ 邮件区：Compose / Inbox / Sent / Drafts / Scheduled / All Mail / Trash
         │          └─ Other ▸ Starred / Important / Spam / Blocked / Unauthenticated
         ├─ 邮件详情：三栏 = 列表 | 正文(RENDERED/PLAINTEXT/SOURCE) | 元数据(msg/thread ID, labels)
         ├─ API Keys（**收件箱级**：key 只能以该箱身份调 API）
         └─ Allow/Block Lists（**收件箱级**：RECEIVE/SEND/REPLY 三方向）
```

### 双作用域设计（重要）

| 资源 | 组织级 | 收件箱级 |
|---|---|---|
| API Keys | Full access 全组织 | "can authenticate only as this inbox" |
| Allow/Block Lists | Organization > Lists | Inbox > Allow/Block Lists |
| 视图 | Unified Inbox（跨箱聚合） | 单箱文件夹 |

——与我们的 admin / identity token 分级完全同构，说明这个分级是行业共识做法。

## 二、逐页观察（19 张截图索引）

| # | 页面 | 关键细节 |
|---|---|---|
| 1 | Overview | 5 数字卡（SENT 1 / DELIVERED 100% / RECEIVED / BOUNCED / INBOXES 2 of 3）+ 引导卡×2 + 活动图 + Unified Inbox 预览 |
| 2 | Inboxes | 配额条"1 remaining"+COMPARE PLANS；行内显示 display name + 地址 + created |
| 3 | Inbox 空态 | "Your inbox is ready"+三个动作（复制地址/SEND IT AN EMAIL/USE API）——**空态即引导** |
| 4 | Sent 文件夹 | 标准邮件列表（收件人/主题+摘要/时间） |
| 5 | 邮件详情 | RENDERED/PLAINTEXT/**SOURCE** 三视图 + 右侧元数据（Msg/Thread ID）+ REPLY/FORWARD + USE API |
| 6-10 | Drafts/Scheduled/All Mail/Trash/Other | 每个空态都有定制文案（搜索框占位符都跟着变："Search unavailable for drafts"） |
| 11 | Other 展开 | Starred/Important/Spam/Blocked/**Unauthenticated**（未验证邮件单列一类——反钓鱼视角） |
| 12 | 收件箱级 API Keys | 空态+"create an API key scoped to this inbox" |
| 13 | 收件箱级 Lists | RECEIVE/SEND/REPLY 三方向各一对 Allow/Block |
| 14 | Metrics | 收件箱筛选下拉 + 四指标 + 时间/时区选择；下接 Operational Diagnostics（held outside inbox / affected domains） |
| 15 | Domains | 免费档锁定提示+COMPARE PLANS（转化点位） |
| 16 | Webhooks | （空态） |
| 17 | 组织级 API Keys | Name/Scope/Key 前缀/Permissions/Created/**Last Used**（我的 key 12 分钟前刚用过，准确） |
| 18 | 组织级 Lists | RECEIVE/SEND 两组 |
| 19 | Plan & Billing | BILLING RECORD（Plan/Status/SEATS 1 of 2）+ **PLAN LIMITS**（INBOXES 2/3、DOMAINS 0/0 AT LIMIT）+ ADD MORE |

## 三、UX 机制清单（它好懂的根因）

1. **邮箱客户端是主视图**：点进收件箱就是 Gmail 式界面（文件夹/搜索/三栏详情）——用户零学习成本。
2. **空态即引导**：每个空页面都回答"这是什么+下一步做什么"（附按钮）。
3. **配额全程可视**：Inboxes 进度条、Plan & Billing 的 LIMITS 表、"AT LIMIT" 警示。
4. **双作用域一致**：组织级/收件箱级同一套心智模型。
5. **数字与诊断先行**：Overview 回答"业务在跑吗"，Metrics 回答"信投出去了吗"。
6. **开发者直达**：每个页面右上角 USE API（看当前页面对应的 API 用法）。
7. **SOURCE 视图**：邮件源码直接可看（调试送达问题刚需）。
8. **转化路径自然**：锁功能页（Domains）+ COMPARE PLANS 散在各处，不弹窗打扰。

## 四、实测发现的短板（我们的机会）

- UI 建收件箱**静默失败**（非法字符无提示，API 才报错）
- 新收件箱 Console 邮件视图初始化期报错（Failed to load mail）
- 没有 task/工单概念、没有手机推送、没有通知分档——**我们独有的三块**

## 五、对 #26 的设计建议（升级为信息架构方案）

```
我们的 Dashboard 重构草案：
├─ Inbox（默认页）—— 邮箱客户端主视图
│   ├─ 身份切换器（现 Addresses 改为收件箱语义）
│   ├─ 文件夹：Inbox / Sent /（后续 Scheduled?）
│   └─ 邮件详情三栏（列表/正文/元数据+OTP 提取结果）
├─ Overview —— 数字卡（身份数/今日收发/通知数/活跃工单）+ 活动图
├─ Tasks —— 工单板（现有，升一级导航）
├─ Notifications —— 推送历史（现有，升一级导航）
├─ Configure
│   ├─ Identities & Tokens（现有管理 + token 列表/轮换——业主之前提过要观察界面）
│   ├─ Push tiers（现有推送分档设置）
│   └─ Domains（托管版多后缀管理，未来）
└─ Plan & Usage（托管版）：配额/出站限额/实例状态
```

原则：邮件是主视图，管理收侧栏；我们独有的 Tasks/Notifications 变一级；空态全配引导文案；数字卡打头。
