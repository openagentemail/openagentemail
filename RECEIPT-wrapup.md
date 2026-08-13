# RECEIPT — #26 阶段2 · 收官单

日期：2026-08-13  
工位：`/home/ops/orca/workspaces/openagentemail/worker-34-pr1`  
分支：`tizerluo/worker-34-wrapup`（从 `origin/main` @ `ef880a9` 开出；禁动 main；禁止自 merge）  
债项台账正源：`/home/ops/fleet-roles/state/CURRENT.md`「抛光单债项台账」1–15（第一节）

## 交付

阶段 2 收官：A 记债清理 4 条 + B UI 抛光 5 条。Trust-30d / cookie `Path=/ui` / Origin / 全局 body-limit 未改。UI 仍是 CSP `script-src 'self'` 下的 JSON 字符串 IIFE 拼接。

`cd packages/api && bun test`：**810 pass / 0 fail**；`bun run build`：Bundled 568 modules，全绿。

## A. 记债清理（代码债 4 条）

| 台账 | 处置 | 证据 / 测试名 |
|---|---|---|
| **#8** A1 `allowedDocsHref` 补 `data:` | **fixed** | 前置黑名单与 `javascript:`/`vbscript:` 对称：`lowered.indexOf('data' + ':') === 0` 返回 `''`（字面量拆开，以免三资产闸命中连续 `data:`）。测试：`allowedDocsHref permits http(s)…` — `allowed('data:text/html,hi')===''`、带 script、`DATA:` 大写 |
| **#13** A2 `parseFile` 顶层 forbidden-key | **fixed** | 解析后的整个 `body` 先跑 `registryHasForbiddenSecretKey`，再看 schema/devices。投毒 `{"schemaVersion":1,"token":"...","devices":[]}` fail-closed。测试：`top-level token sibling on an otherwise valid registry is refuse-closed`；原 `payload with password or token keys is still refused` 仍绿 |
| **#11** A3 `recoverPushTier` | **fixed** | `api.ts` 抽出 `recoverPushTier`（`bumpIdentityEpoch` → GET `/ui/api/identities` → 代际校验 → 权威档 announce）。`handlePushTierChange` 与 `handleConfigurePushTier` 两处调用。测试：`recoverPushTier is the shared fuzzy-failure helper…`；`handlePushTierChange fuzzy failure… (F51)`；`Configure push renders three human-language…` |
| **#12** A4 `confirmModalOnCancel` | **fixed（小改，未动拼接架构）** | `var confirmModalOnCancel = null` 迁入 `modal.ts`（与 `closeAllModals` 同模块）。`api.ts` / `push-devices.ts` 只赋值。同 IIFE 内 `var` 提升，拼接顺序不用改。测试：`modals record the opener…` 含声明；`PR1 P2 stubs…` 断言 `API_JS` 不再 `var confirmModalOnCancel`；F107 仍绿 |

## B. UI 抛光（5 条）

| 台账 | 处置 | 证据 / 测试名 |
|---|---|---|
| **#1** B1 1280 详情主题中文竖排 | **fixed** | 根因：220 nav + 240 身份 + 360 列表后，1280 详情剩余约 460px，再减 padding 与 240 抽屉，主题列 &lt;100px + `overflow-wrap: anywhere` → 中文逐字竖排。修复：`.detail-main-col { min-width: 12em }`；`h2` 改为 `overflow-wrap: break-word; word-break: normal`；**≤1440** 收起 metadata 抽屉（算术含 app-nav）。1100 仍只管 overview 轨 / 侧栏收窄。独立自审指出 `.meta` 误加 `minmax(12em,1fr)` 会在 Headers tab 撑爆——已撤回，`.meta` 保持 `58px minmax(0,1fr)`。测试：`1280 detail subject wraps as a row…` |
| **#2** B2 桌面文件夹切换器 | **fixed** | 1280 下 Inbox/Sent/All Mail 本就在左栏；对比度：`.folder-nav-title` `--ink-faint` → `--ink-dim`。长地址列表会把 Folders 顶出视口：`.identity-panel` 改 column flex，地址 `nav` 滚动，`.folder-nav { flex: none; margin-top: auto }` 钉在栏底。375 folders 层同样 flex + `max-height: calc(100vh - 66px)`。测试：同上 CSS 闸 |
| **#3** B3 Tasks RESULT 形态 | **kept 键值表（结论）** | 现码已是：普通对象 → `.task-result-table` 键值表（与 notify/identity 行风格一致）；数组/标量 → `<pre>` JSON。嵌套对象仍 `JSON.stringify` 进单元格，不擅自改成递归表。源码中文注释记下该口径。测试：`task RESULT prefers a key-value table for plain objects` |
| **#14** B4 revoke transient 重拉 | **fixed** | `handleRevokeDevice` catch 在 `session_expired` 之后 `loadPairedDevices()`（一行级；未 await，与成功路径相同）。ntfy 503 落 `pending_revoke` 后「Revoking…」立刻可见。disabled/unconfigured 也会重拉（行仍 active，多一次 GET）。测试：`revoke transient failure immediately reloads paired devices` |
| **B5** ZCode P2 余债中属 UI 的 | **见下表** | 属 UI 的两条即 A3/A4，本单已关。其余不属 UI，记债不改 |

### B5 对照（RECEIPT-pr5 / pr6 + 台账 #4）

| 来源 | 条目 | 是否 UI | 本单 |
|---|---|---|---|
| PR5 ZCode P2-1 | `recoverPushTier` 两处重复 | 是 | **A3 已修** |
| PR5 ZCode P2-3 | `confirmModalOnCancel` 跨模块 | 是 | **A4 已修**（声明迁入 modal.ts，未动 IIFE 拼接顺序） |
| PR5 ZCode P2-4 | zcode-review-gate mimosa 过期 checkout | 否（工具链） | 台账 **#10**，指挥另案 |
| PR6 ZCode P2-1…P2-5 | dest+.bak / 双 DELETE / 幽灵 user / 全量 reconcile / 首次 tmp | 否（registry/ntfy） | 保持记债 |
| PR6 UI 向 | revoke transient 不立刻重拉 | 是 | **B4 / 台账 #14 已修** |
| PR4 余债 | reminder overlay / list stampede | 否（IMAP/缓存） | 保持记债 |
| PR3 | JSONL append O(n) | 否 | 台账 **#5** |
| 台账 #6 | 375px/键盘焦点实机 | 手测 | 收官统一过；指挥拍屏 |
| 台账 #7 | Tasks 读路径 docs | docs | 不在本单 A/B 必做 |
| 台账 #9 | bun test 偶发 | 测试 | 不在本单 |
| 台账 #15 | QR 真扫码 CI | 工具 | 不在本单 |

## 独立自审（禁止自审自）

| 轮 | agent id | 结论 | 过程 |
|---|---|---|---|
| 初审 | `dffb2545-b13b-4585-9e48-b0e05781dbbd` | **mergeable**；P0/P1=0；**P2×2** | 只读对照 `origin/main` @ `ef880a9`；抽出 JSON 模块语义差；跑 `ui-assets` / `notification-devices` / `ui-modal-buttons`。P2-1：`.meta` `12em` 会在 821–1100 Headers 溢出（已撤回）。P2-2：当时尚未写 RECEIPT/B5（本文即结案） |
| 复审 | `3efdb0b2-d23a-4491-9f3b-e4b67cfb6731` | **mergeable**；P0/P1/P2=**0** | 新 agent。确认 `.meta` 已回到 `58px minmax(0, 1fr)`；B5 表与 Progress 收官段在位；A1–A4/B1–B4 抽查成立。未改码 |

## 布局自测（1280 / 375，不拍屏）

未开真浏览器。依据 shell + CSS：

- **1280 桌面：** 全局 nav 220 + 身份 240 + 列表 360 + 详情剩余。详情 ≤1440 不再并排 240 抽屉，主题 `h2` 占满主列，中文按词/行横排（`break-word`，非 `anywhere`）。Folders 钉在身份栏底部，标题 `--ink-dim`，按钮 `--ink` / 当前 `--gold`。Tasks 详情 RESULT 仍为键值表。
- **375（≤820）：** 仍 folders → list → detail 单层；folders 层身份栏 flex，Folders 不随长列表滚出。wordmark 隐藏。未改 Back 栈 / 44px 触控。

指挥请拍：① Inbox 详情中文主题 1280；② 左栏 Inbox/Sent/All Mail 1280；③ Tasks 详情 RESULT 键值表；④ 375 folders + 详情。

## 本地起服务拍屏指引（相对 PR6 的变化）

工位仓库不变。**改用分支 `tizerluo/worker-34-wrapup`**，不要切 `main`。mock ntfy / `PORT=3100` / `DATA_DIR` / cookie `oae_ui Path=/ui` 与 `RECEIPT-pr6.md` 相同。

新增拍镜（PR6 设备镜仍有效）：

1. **1280 Inbox 详情：** 打开一封中文主题信，确认主题横排、不是逐字竖排；右侧 metadata 抽屉在 1280 应收起，Headers 走 tab。
2. **1280 文件夹：** 左栏底部 Inbox / Sent / All Mail 可见；地址很多时 Folders 仍钉在栏底。
3. **Tasks RESULT：** 打开带 `result` 对象的工单，确认键值表而非整块 JSON（数组/标量才是 `<pre>`）。
4. **Revoking…：** mock DELETE 改 503 后点 Revoke，**不必再手动刷新**，列表应立刻出现 pending 行。

造 pending 样例、磁盘零明文 grep，仍按 PR6 第 3–4 节。
