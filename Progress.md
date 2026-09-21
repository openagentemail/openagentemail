# Progress · #137 B1 控制台 i18n 基建

## 2026-09-20 · w137b1

### 我们实现了哪些功能？
1. `packages/api/src/ui/client/i18n-en.ts`：I18N_EN 源字典（约 480 键）+ `I18N_JS` 运行时（`t(key)` + 键集自检），拼入 `UI_JS`。
2. `packages/api/src/ui/i18n/resolve-ui-locale.ts`：单点 `resolveUiLocale`（cookie `oa_lang` → Accept-Language → en）。
3. `shellHtml(locale)`：en 与 origin/main `UI_HTML` 逐字节一致；非 en 注入 `/ui/i18n/{locale}.js` + `<html lang>`。
4. `GET /ui/i18n/:file` 挂在 `routes/ui-assets.ts` 既有树；合法 es/ja/ko/zh-CN，未知 404；B1 返回空对象骨架。
5. 客户端 pages/components/root + `ui-frame.ts` call-site → `t('…')`（en-only 零行为变化）。
6. 五组测试 `test/ui-i18n-b1.test.ts` + 既有 UI 测试断言/shim 适配。

### 我们遇到了哪些错误？
1. Hono 路由 `/ui/i18n/:locale.js` 参数名被解析成 `locale.js` 且值为 `es.js`，导致合法 locale 校验失败 → 404。
2. 抽取脚本误收入 CSP/头名等技术串进字典；`ui-frame` 标题被改成残缺 `t()` HTML。
3. 既有 `new Function` 抽片测试缺全局 `t` → `ReferenceError: t is not defined`。
4. `ui-assets.test.ts` 大量字面量 `toContain` 断言与 `t('…')` 形态不匹配。
5. 全量套件首次跑有 ENOSPC/多失败；清理后仅剩 #206 超时 1 红（与本卡无关）。

### 我们是如何解决这些错误的？
1. 改为 `/ui/i18n/:file`，剥 `.js` 后缀再校验 locale。
2. 清洗 curated-map，手写修复 `ui-frame.ts`（`tServer` + `frame.docTitle`/`frame.brandH1`）。
3. 新增 `test/support/ui-i18n-shim.ts` 注入 `globalThis.t`。
4. 将静态断言改为键/`t('…')` 形态；运行时文案断言仍期望 en 原文（shim 回落）。
5. 重跑全量：1886 pass / 9 skip / 1 fail（#206 25s timeout，预存/环境性）。

### 基线与证据
- origin/main：`b230a084`
- en UI_HTML sha256：`ba8f245b89602117ca6ceca7e270be0d43425fd75243280ba17c14ab11542a39`（与 main 逐字节一致）
- 分支：`w137-b1-console-i18n-infra`
- 材料：`/home/ops/materials/137-b1/`

## 2026-09-20 · R2（Codex P1×4）

### 我们实现了哪些功能？
1. **P1-1**：`I18N_JS` 自检改为直查 `I18N_EN[key] !== val`，不经 `t()`/`window.OAE_I18N`；假字典注入时 `t()` 返译文且不抛。
2. **P1-2**：`shellHtml(locale, dict?)` / `renderUiHtml` 非 en 路径最长优先精确字面量替换；`tServer(key, dict?)`；en 路径逐字节不变。
3. **P1-3**：notifications 摘要/诊断整句 `tFormat` 模板；同形面回扫（inbox 空态、delete announce、push tier 句、signed-in、showing latest 等）。
4. **P1-4**：`parseAcceptLanguage` 过滤 `q===0`；`'es;q=0, en'`→en、`'es;q=0'`→en。
5. 测试扩展至 11 例；全量 **1891 pass / 9 skip / 0 fail**。

### 我们遇到了哪些错误？
1. `ui-real-files` UI_JS sha 针脚需随字典/tFormat 增长更新。
2. `ui-assets` 仍断言旧 `'Showing latest ' + NOTIFY_RENDER_LIMIT` 拼接形态。

### 我们是如何解决这些错误的？
1. 重算并钉死 UI_JS sha `94098ec6…`。
2. 断言改为 `tFormat('notifications.copy.showingLatestOf'…)` 形态；shim 补 `tFormat`。

## 2026-09-20 · R3（Codex P1×2）

### 我们实现了哪些功能？
1. **P1-1**：废弃 `applyI18nLiteralReplacements` 全局子串替换；壳层改为 `SHELL_HTML_TEMPLATE` 键槽 `{{key}}` + `fillI18nSlots`；connect 同模板；en 填充 ≡ 历史 UI_HTML 逐字节。
2. **P1-2**：connect/Overview/Tasks/inbox/notifications 等剩余可见字面量收尾迁移；agent 粘贴指令/配置体显式 allowlist；完备性测试扫描「字典值全等裸字面量 − allowlist」，红证 `Copy setup`。
3. Codex 反例断言：mock 含 `Open` / `notice warning` 不得污染 `OpenAgent.email` / `class="notice warning"`。

### 我们遇到了哪些错误？
1. connect 地标正则 `\s*` 吞掉前导换行 → en 字节偏离。
2. 批量 wrap 误把 CSS `className` 包进 `t()`。
3. `ui-assets` 大量字面量断言需同步改为 `t('…')` 形态。

### 我们是如何解决这些错误的？
1. 地标改为固定缩进 + `data-nav`/`id`，不吞换行。
2. 还原 className；完备性 allowlist 排除 CSS/技术串。
3. 更新 `ui-assets.test.ts` 断言；UI_JS sha → `5eb29bfc…`；全量 1892 pass / 0 fail。

## 2026-09-20 · R4（总指挥 #4024 五项 · 绝对末轮）

### 我们实现了哪些功能？
1. **④**：`fillI18nSlots` 槽值一律完整 HTML 转义（`escapeHtmlText`/`escapeHtmlAttr`）；文本位与属性位分流；弃「已含实体则跳过」；负向断言覆盖 `<>"'` 与属性 breakout。
2. **②**：cookie Path/SameSite/Secure 与 `open.rel` 恢复代码常量；从 I18N_EN 删除 Bearer/Authorization/SameSite/noopener 及 CSS/技术死键（见 completion.md 删键清单）；完备性负向断言。
3. **①**：`shellHtml`/`renderUiHtml` 无真字典 → 完整 en 原样（`lang="en"`、无 i18n script）；lang 翻转留给 B2。
4. **③**：壳层 Search/aria-label/optional labels 等入键槽；模板完备性扫描 `SHELL_HTML_TEMPLATE`。
5. **⑤**：api.js recover / overview unavailable/opened 整句 `tFormat`；同形面回扫含 api.js；删碎片死键。
6. 聚焦 94 pass；UI_JS sha `0e86d196…`；en UI_HTML sha 仍绿。

### 我们遇到了哪些错误？
1. bun 多文件并行 import 时偶发 UI_JS sha 针脚读到旧模块缓存。
2. 残留 CSS 死键 `tasks.copy.quietDeleteAction` 初扫漏删。
3. 全量套件 `#206` 25s timeout（预存，与本卡无关）。

### 我们是如何解决这些错误的？
1. 聚焦三件套改为顺序跑确认针脚；sha 钉 `0e86d196…`。
2. 删净后重算 UI_JS sha。
3. 记录为环境竞态，不挡 R4 合入（R3 同口径）。

## 2026-09-20 · R4.1（#4028 定点修 · 换工法不拆卡）

### 我们实现了哪些功能？
1. `withConnectShell` 两处 `.replace` 改为回调形式，译文含 `$`/`$&`/`$$`/`$1` 一律字面插入。
2. 通知级别三 option 可见文本入槽（`levelUrgent/Normal/Low`）；`value=` 协议值不动。
3. 同族全扫 shell+connect 模板；机械化完备性（非槽非白名单即红）。
4. 新增 `R4.1` 对抗用例组（$ 字面、HTML 转义、回落、CJK、赋值负向、option 槽）。
5. 聚焦 95 pass；全量 **1896 pass / 0 fail**；en UI_HTML sha 仍绿。

### 我们遇到了哪些错误？
1. 对抗断言 initially 期望输出含裸 `$&`，但文本位 HTML 转义后为 `$&amp;`。

### 我们是如何解决这些错误的？
1. 断言改为期望 `$&amp;`，同时保留 `$1`/`$$` 字面计数——证明既未被 replace 语义吞掉，又经 R4④ 转义。

## 2026-09-20 · B-R2（Codex P1×3 · API 令牌显示映射）

### 我们实现了哪些功能？
1. **P1-1**：`notifications.js` 级别可见值经 `notifyLevelLabel`→`t('notifications.level.*')`（urgent/normal/low/unknown）；日志+缓存同修；`data-tier` 保留协议令牌。
2. **P1-2**：`tasks.js` 全状态 `t('tasks.state.<state>')`（含 submitted/working/completed/failed）；新增 `taskStateDisplay` 供 timeline badges；`data-state` 仍用协议 token。
3. **P1-3**：`push-devices.js` 已知话题一律 `t('push.copy.userAlerts'|'userLow')`，服务端英文 display 不作可见源；未知话题原样。
4. 字典键入 `i18n-en.ts`；en 值=原可见串；三路径聚焦测试；UI_JS sha 更新。

### 我们遇到了哪些错误？
1. `makeAdminTaskDetailHarness` 未注入新函数 `taskStateDisplay` → `ReferenceError`。
2. `ui-assets.test.ts` 仍断言旧 `t('tasks.copy.waitingForYou')` / `t('tasks.action.closed')` 字面。
3. 全量偶发 `#91` dist 竞态 1 红（单测重跑绿）。

### 我们是如何解决这些错误的？
1. harness 增加 `taskStateDisplay` 桩参。
2. 静态断言改为 `tasks.state.closed` / `tasks.state.` 动态键形态。
3. 记录为预存/环境竞态；聚焦 160 pass；不挡 B-R2。

## 2026-09-20 · B-R3（Codex P1×1 · 空态 filter 显示映射）

### 我们实现了哪些功能？
1. `taskFilterDisplay`：`t('tasks.filter.'+token)`，en 四键值=原令牌（active/input-required/completed/failed）。
2. 空态句改 `taskFilterDisplay(filter)` 再内插；`all` 仍整句键。
3. 全仓同形面终扫 17 条清单入 completion.md（仅 #1 需修；其余不适用/已合规）。
4. 聚焦测试：空态×四 filter 断言走 `tasks.filter.*` 且 en 句逐字=`No tasks in "<token>" for this period.`。

### 我们遇到了哪些错误？
1. 无阻断错误；`tasks.state.input-required`=`Waiting for you` 与空态引号内原令牌冲突，故另开 `tasks.filter.*` 钉令牌。

### 我们是如何解决这些错误的？
1. 徽章继续用 `tasks.state.*`；空态/filter 引号用 `tasks.filter.*`（同源协议令牌、异展示面）。

## 2026-09-20 · B-R4（Codex P1×2 · allowlist + sentAt）

### 我们实现了哪些功能？
1. 完备性删 `/^[a-z0-9_.@:-]+$/`；协议标识显式枚举；`looksLikeUiCopy` 认 `unseen|msgs`。
2. `countParts` 单位词 `t('inbox.unit.*')`；en=原令牌；红证修前形禁止。
3. `inbox.label.sentAt` 专用于 send-log 时间戳；文件夹键不动。
4. 一键多用清单入 completion.md。

### 我们遇到了哪些错误？
1. 无阻断；catch-all ∩ looksLikeUiCopy 实测为空（死门），但仍构成过宽风险。

### 我们是如何解决这些错误的？
1. 删除 catch-all 并显式列协议令牌；单位词走字典 + 红证双保险。

## 2026-09-20 · w280（#280 redeliver 裸 Error 500→404）

### 我们实现了哪些功能？
1. `redeliverWebhookDelivery` 两处裸抛补 `err.code`：`task_not_found` / `missing_task_id`（镜像 :2836–2856 兄弟模式）。
2. `routes/webhooks.ts` redeliver catch 补 `missing_task_id` → **404** `{"error":"missing_task_id"}`（总指挥 #4009；非 409）。
3. 路由级测试两件：ghost-task → 404 `task_not_found`；缺 taskId → 404 `missing_task_id`。
4. 死信内部记账路径未动；未改 message 匹配（B 案已驳）。

### 我们遇到了哪些错误？
1. 无本卡阻断错误；全量套件预存红：#206 25s timeout、#272 kill-9 锁释放失败（环境性，非本路径）。

### 我们是如何解决这些错误的？
1. 本卡路径聚焦 2 pass + webhooks-route 47 pass；预存红编号记入 completion.md，不挡合入。
2. 独立 subagent 自审 PASS（`356cc45c-126a-4fcb-9933-765dca5a8260`）。

### 基线与证据
- origin/main：`d35e011ff022a3ffbf957fc79c7fe2d91631012e`
- HEAD：`2f7860dd96539e8d45f397c85e10ddf3c33d5d67`
- 分支：`w280-redeliver-404` · PR #295
- 材料：`/home/ops/materials/280/completion.md`

## 2026-09-20 · w285（#285 租约 journal O(N²) 索引化）

### 我们实现了哪些功能？
1. `tasks-internal.ts` 同代 renew/expiry 去重改为键控 Set（`canonicalLeaseEvent` / `claimedUntil`），追加改为 map 持有数组后原地 `push`。
2. `expiryReceipts` 可观察插入序保真（`Map.values().flat()`）；`isSame*` 与 journal 写策略零改动。
3. 聚焦测试三件：去重键 vs `.some()` 等价、索引与主结构一致性、expiryReceipts 顺序快照。
4. Bench 复测：N=10⁴ m2=off slice log-log slope **1.015**（基线 1.998）；满链重建 83.5ms（基线 57–70s）。

### 我们遇到了哪些错误？
1. 聚焦顺序测试初版 `parseCaptured` 得 null（续约未先重建 durable / leaseSec 未拉长窗）。
2. 全量套件预存红：`#206` 25s timeout（与本卡无关）。

### 我们是如何解决这些错误的？
1. 对齐 `#156 claimThenRenew` 夹具：claim 后重建 durable、`leaseSec: 600` 拉长窗后再 parse。
2. 预存 flake 编号记入 completion.md；不挡合入。独立 subagent 自审（`3b7424c7-c543-4ccd-960f-76302329e632`）。

### 基线与证据
- origin/main：`dde584540a3884e8f4e4339870f38bebfb5497ed`
- HEAD：`b2be6a16de2de7c5c3cd01e29beb9c71061d8e5e`
- 分支：`w285-lease-index` · PR #296
- 材料：`/home/ops/materials/285/completion.md`

## 2026-09-20 · w284（#284 release.yml mcp-publisher 供应链加固）

### 我们实现了哪些功能？
1. `release.yml` Install mcp-publisher：URL 从 `releases/latest/download` pin 到 `releases/download/v1.8.1`。
2. 内联 sha256 主锚 `a06c9096…cf2cc`；下载后 `sha256sum -c` 通过才 `tar xz`，失配 `::error::` 退出。
3. 架构守卫：`uname -m` 非 `x86_64` 直接 `::error::` 退出（不预置 arm64）。
4. 注释记升级口径：升上游版须重测 hash 改内联值，升级 PR 必附下载+sha256sum 原始输出。

### 我们遇到了哪些错误？
1. 无阻断错误；yaml.safe_load 与本地下载/sha256sum/解压模拟均一次通过。

### 我们是如何解决这些错误的？
1. 无代码修复；hash 与官方 `registry_1.8.1_checksums.txt` 互证一致（见 materials/284/completion.md 原始输出）。

### 基线与证据
- origin/main：`18dd9421df22b445b93cb4618aa339ceae652156`
- 分支：`w284-publisher-pin`
- 材料：`/home/ops/materials/284/completion.md`
