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

## 2026-09-20 · w278（#278 ntfy 去根化·窗前备货）

### 我们实现了哪些功能？
1. `packages/api/src/lib/notify.ts` `writeServerConfigBody`：生成 `listen-http: ":2587"`（>1024，随 server.yml 生成器走）。
2. `compose.yaml` ntfy 节三项锁步：`user: "1000:1000"`；ports `127.0.0.1:${NTFY_PORT:-2586}:2587`；healthcheck wget 打 `:2587`；注释保留原意图并标 #278。
3. `notify-route-cascade.test.ts` 新增 `7d`：断言生成的 server.yml 含 `listen-http: ":2587"`。

### 我们遇到了哪些错误？
1. 本地无 `.env` 时 `docker compose config` 因 `env_file: .env` 直接失败。
2. 全量 api 套件预存红：`#206` 25s timeout（与本卡无关，Progress 既有记载）。

### 我们是如何解决这些错误的？
1. 冒烟用临时 env 软链为项目 `.env`，校验后立即拆除；不落盘、不改真 `.env`。
2. 预存 flake 记入 completion；不挡合入。窗内执行（chown/up/id 验）留给 FC，本卡不动产线。

### 基线与证据
- origin/main：`fd4135935c5308e6af4b6a531f529db4b39149e0`
- HEAD：`40147a4e4ac0549fecb4400e7252e95de0c7d527`
- 分支：`w278-ntfy-nonroot` · PR #298
- 材料：`/home/ops/materials/278/`
- subagent 自审：`be1c3f15-83dd-4bc6-8243-f2d8b75913f7` · verdict PASS
- 全量 api：1915 pass / 9 skip / 1 fail（#206 预存 timeout）

## 2026-09-20 · w278 R2（Codex P1×1 · NTFY_INTERNAL_URL 层序漏点）

### 我们实现了哪些功能？
1. `compose.yaml` api：`NTFY_INTERNAL_URL: http://ntfy` → `http://ntfy:2587`（与 listen-http/ports/healthcheck 锁步）。
2. `config.ts` 缺省 `envUrl('http://ntfy')` **不动**（env 驱动；compose 注入覆盖）。
3. `7d` 旁中文说明部署面锁步；compose 非单测面 → completion 记 grep 证据。

### 我们遇到了哪些错误？
1. R0/窗前卡漏改内部 URL：healthcheck 绿但 API 仍打 :80 → 配对/发布断连（FC 亲验属实）。
2. 全量套件偶发 `list-rate isolate parent` 红（预存 flake，与本修无关）。

### 我们是如何解决这些错误的？
1. 只改 compose 注入面一行 + 注释；不动代码缺省。
2. 预存 flake 记 completion，不挡合入。

### 基线与证据
- 分支：`w278-ntfy-nonroot` · PR #298
- HEAD：`e5b4e0952d14c2241dedfdd2109eb8eace62b223`
- 聚焦 `7d`：1 pass；全量：1915 pass / 9 skip / 1 fail（list-rate isolate flake）
- grep：`compose.yaml` 仅 `NTFY_INTERNAL_URL: http://ntfy:2587`；`config.ts:211` 仍 `envUrl('http://ntfy')`

## 2026-09-20 · w278 R3（Codex P1×2 · bare 缺省 + 升级注释）

### 我们实现了哪些功能？
1. **P1-2**：`config.ts` `NTFY_INTERNAL_URL` 缺省 → `envUrl('http://ntfy:2587')`（与 listen-http 锁步；显式 env 仍覆盖）。
2. **P1-1 文档锚**：compose ntfy 节补升级 chown 注释；PR/completion 写明 sweep→chown→up 次序。
3. `notify.test.ts` mock URL 针脚随缺省更新；`7d` 旁说明同步。

### 我们遇到了哪些错误？
1. 改缺省后既有 `http://ntfy/v1/...` 断言必红（两处）。

### 我们是如何解决这些错误的？
1. 针脚改为 `http://ntfy:2587/v1/...`；全量 **1916 pass / 0 fail**。

### 基线与证据
- 分支：`w278-ntfy-nonroot` · PR #298
- HEAD：`04976a4854abf5abfcf0b7fb49b6c50c29acba56`
- 材料：`/home/ops/materials/278/completion.md`（R3 追记）
- 部署面：compose 已显式注入；bare 缺省现与 :2587 自洽
- 全量 api：**1916 pass / 9 skip / 0 fail**

## 2026-09-20 · w278 R4（README 用户面 ntfy chown runbook）

### 我们实现了哪些功能？
1. README `#93` 迁移节后增 `### ntfy non-root upgrade (#278)`：升级前对 `/data/ntfy` 一次性 chown（命令风格对齐既有 `docker run -v <project>_api-data`）；否则 ntfy UID 1000 起不来且 API `depends_on` healthy 连带挂。

### 我们遇到了哪些错误？
1. 无；Codex 第三次同条裁为半成立——compose comment 不执行 chown，正解=用户面 README 注记。

### 我们是如何解决这些错误的？
1. 只加 README 一段；不动代码/compose。

### 基线与证据
- 分支：`w278-ntfy-nonroot` · PR #298
- HEAD：`69f4b38258a5e2abe1ba8e71680fbb99649512fa`
- 材料：`/home/ops/materials/278/completion.md`（R4 追记）

## 2026-09-21 · wmisc-229-82-199（#229+#82+#199）

### 我们实现了哪些功能？
1. **#229**：`SeatSerializer` 排队段 AbortSignal 弃队；已开跑 send 不打断；弃队不消费 dedup；README Timer/参数表同步；阴性+正例测试。
2. **#82**：`docs/task-lease-reason-transport.md`（8k→≈10.9KiB 账、Postfix/商用头风险表标源+未实测）；task-lease-core 常开 folding 语料（76/78/998 等）。
3. **#199**：矩阵夹具改导入 `MAIL_CURSOR_V1_PREFIX`。

### 我们遇到了哪些错误？
1. 多折行语料直接喂 `parseTaskMessageForTests` 时 mailparser `.get()` 保留续行 WSP，打断 base64url。
2. `npm run typecheck` 对 `as const` / 字面量 code 类型一度报 TS1355/TS2322（缓存与赋型纠缠）。
3. PR #77 R17 folding 遗产挂在 `TASK_LEASES_R6_RED=1` 门控内，默认 `bun test` 发现不了。

### 我们是如何解决这些错误的？
1. 语料经 mailparser `headerLines` + 与 R17 相同的 unfold（去 CRLF+WSP）后重建单行头，再走生产 parse；并保留 nodemailer 线正对照。
2. 错误工厂改为 `code: string`；清增量缓存后 typecheck 绿。
3. #82 语料放在门控外常开 describe，并在完工报写明遗产 file:line（:1933）。

### 基线与证据
- 分支：`wmisc-229-82-199` · PR #300
- HEAD：`bdf948c55fb4abb3809f44fb47927de90a1c3206`
- 材料：`/home/ops/materials/229-82-199/completion.md`
- api：**1917 pass / 9 skip / 0 fail**；webhook-wake：**178 pass** + typecheck clean
- subagent：`243a953e-10f1-4a84-8c37-7901283c2714` PASS

## 2026-09-21 · wmisc R1（PR #300 P1×2）

### 我们实现了哪些功能？
1. **P1-1**：`ShareWaiterAggregate`——同 dedup key 多 waiter 动态聚合；共享 `seats.run` 仅在全部 waiter 放弃时 abort；README 同步；两例回归。
2. **P1-2**：`task-lease-reason-transport.md` 拆 ASCII≈10.9KiB / BMP 最坏≈32.2KiB；Gmail 行重判贴/超 32KB；存储账补最坏。

### 我们遇到了哪些错误？
1. 无新运行时错误；聚焦与全量测试一次绿。

### 我们是如何解决这些错误的？
1. N/A。

### 基线与证据
- HEAD：`36209bfaf5cae73f03d77b84834e3ed162b46a64`
- PR #300；材料 completion.md R1 节
- api 1917 pass；wake 180 pass + typecheck clean

## 2026-09-21 · wmisc R1+ZCode（PR #300）

### 我们实现了哪些功能？
1. SEAT_QUEUE_ABORTED catch 纵深防御（headersSent||aborted 才静默）+ metric `shareAbandoned`
2. 文档最坏口径勘误为 ≈31.3KiB（ceil(24100/3)*4）；否决 43KB
3. 测试 headroom 注释；wake 启动改事件驱动；CJK 8000 满长语料（payloadChars=32242）

### 我们遇到了哪些错误？
1. 无。

### 我们是如何解决这些错误的？
1. N/A。

### 基线与证据
- HEAD：`b8bd7ee5872eb9c26527f7a7f8cdeba8a2dd9bb6`
- api 1918 pass；wake 180 pass + typecheck；CJK ≈31.49KiB

## 2026-09-21 · wmisc R1 第二追加（#4171 P2-a）

### 我们实现了哪些功能？
1. 单 waiter 超时阴性对照；生产 `readLeaseEventPayload` strip 空白；foldedRaw 直过；`!!!!` 负例；submitted 序列化。

### 我们遇到了哪些错误？
1. foldedRaw 直过未修前 RED（mailparser 留 WSP）。
2. 全量 api #206 25s timeout flake。

### 我们是如何解决这些错误的？
1. strip `\s+` 后严格 base64url → GREEN。
2. 单文件复跑 wait-precedence-r9 2 pass；完报注明 flake。

### 基线与证据
- HEAD：`072e2c116008143dd58766d15827372932bb756d`
- subagent：`d3883c4a-c6f9-46b7-b36f-20a42424ff59` PASS
- api 1918(+#206 flake复跑绿)；wake 181+typecheck

## 2026-09-21 · wmisc R3（PR #300 P2×2 · JSON 转义真实测）

### 我们实现了哪些功能？
1. **P2-2**：#82 语料新增 NUL×8000 生产路径用例；权威数字 reasonFieldJsonBytes=48002 / eventJsonBytes=48181 / payloadChars=**64242**（≈62.74KiB）；文档三层账 JSON 转义列改钉实测，删除旧「48002/64112」口径。
2. **P2-1**：`operator-guide.md` + `task-lease-journal.md` 挂链摘要同步 ASCII/BMP/JSON 转义三层最坏口径。

### 我们遇到了哪些错误？
1. R2 沿用的「FC 实测 48002/64112」把单字段 stringify 与猜测 wrapper 演算混成同一权威——Codex/FC 确认不自洽。

### 我们是如何解决这些错误的？
1. 与 CJK 同路径从 `X-OA-Task-Lease-Payload` 读真实 `payloadValue.length=64242`；断言钉死；文档分层写清「单字段 vs 完整事件体+payload」。

### 基线与证据
- 分支：`wmisc-229-82-199` · PR #300
- HEAD：`501fe40603d74575be8616a8c01a243733c4dbf3`
- 材料：`/home/ops/materials/229-82-199/completion.md` R3 节
- #82 聚焦：**4 pass**

## 2026-09-21 · w137b2（#137 B2 四语落串 + 语言选择器）

### 我们实现了哪些功能？
1. 四字典 `i18n-es.ts` / `i18n-ja.ts` / `i18n-ko.ts` / `i18n-zh-cn.ts`（508 键，与 I18N_EN 全等）；术语对齐 `docs/i18n-glossary.md`（补 es/ja/ko 列）。
2. `i18n-preserved.ts` + 保真扫描测试：产品名标题 / CLI 指令块 / API token·MCP 标签 / 任务状态枚举字面量 —— 四字典值与 en 逐字节相同。
3. `getUiI18nDict` + `i18nLocaleScript` 真译文；`shell()` 非 en 传 dict → lang + `/ui/i18n/:locale.js`。
4. Settings 组语言选择器（en/es/ja/ko/zh-CN）：`document.cookie` 写 `oa_lang`（Path=/ui; Max-Age=1y; SameSite=Lax）+ 刷新；零新 API。
5. ui-oauth 随会话 locale 归一（a 案）；废除 handoff 钉死 zh-CN。
6. 测试 `ui-i18n-b2.test.ts`；走查单 `materials/137-b2/walkthrough-{es,ja,ko,zh}.md`。

### 我们遇到了哪些错误？
1. B1 壳模板 allowlist 把语言 option 的 `en/es/ja/ko/zh-CN` 判为未槽化英文。
2. OAuth 既有测试钉死中文 handoff「已授权」，缺省 locale=en 后红。
3. UI real-file 金标（UI_JS/UI_CSS sha）因选择器与样式变更需更新。
4. worktree 缺 `node_modules` → `Cannot find module 'hono/cookie'`。

### 我们是如何解决这些错误的？
1. R4-③ allowlist 显式加入五 locale 代码（卡规定可见文本=代码本身）。
2. handoff 断言改为 `/已授权|Authorized/`；zh-CN 路径仍由 cookie/ACL 覆盖。
3. 更新 `ui-real-files.test.ts` 与 en UI_HTML sha 针脚并注释 #137 B2。
4. 在 worktree `packages/api` 执行 `bun install`。

### 基线与证据
- 开工基线 origin/main：`07c75461`
- 分支：`w137b2-console-locales`
- HEAD：`fc371bcb053eba61f3501049e3c0a09fad2d2819`
- PR：https://github.com/openagentemail/openagentemail/pull/306
- 材料：`/home/ops/materials/137-b2/`
- subagent：`70cd1a41-1e16-42d7-b099-9b950aec1491` PASS（P1 From/To 已修）
- >600 行预授权：总裁定 #4241

## 2026-09-21 · w137b2 R1（Codex P1×2）

### 我们实现了哪些功能？
1. **P1-1**：`ui-frame` 随会话 locale 传字典给 `tServer`，`<html lang>` 跟随；错误页本地化。
2. **P1-2**：`preflightAuthorizeRequest` 增加 page `code`；五字典 `oauth.error.*`；GET/POST 错误页映射键，不直渲英文 `pre.message`。

### 我们遇到了哪些错误？
1. UI_JS 金标随 I18N_EN 增键需刷新。
2. 并行跑 oauth-as 与其他套件时偶发 `createIdentity` 撞址（与本修无关；单文件重跑绿）。

### 我们是如何解决这些错误的？
1. 更新 `ui-real-files` UI_JS pin 为 `10af954a…`。
2. 聚焦/全量串行确认；全量 1932 pass / 9 skip / 1 fail（#206 flake）。

### 基线与证据
- HEAD：`fc371bcb053eba61f3501049e3c0a09fad2d2819`
- 材料：`/home/ops/materials/137-b2/completion.md` R1 节

## 2026-09-21 · w137b2 R2（Intl 跟随 html lang）

### 我们实现了哪些功能？
1. `uiLang()` + `formatDate`/`formatDay`/`formatClock`/`formatNumber` 传 `document.documentElement.lang`，选择器 locale 驱动日期/数字格式。

### 我们遇到了哪些错误？
1. 无功能性错误；金标 UI_JS 需随 api.js 变更刷新。

### 我们是如何解决这些错误的？
1. 更新 `ui-real-files` pin；R2 单测钉死源码面 + en/de 运行面。

### 基线与证据
- HEAD：`06563a5a4789093239f81abc1fe74891a098d910`
- 全量：1933 pass / 9 skip / 1 fail（#149 flake）
- 材料：`completion.md` R2 节

## 2026-09-21 · w137b2 R3（shell Vary）

### 我们实现了哪些功能？
1. `/ui` shell 响应补 `Vary: Authorization, Cookie, Accept-Language`，与 frame 对齐，防共享反代串染 locale 变体。

### 我们遇到了哪些错误？
1. 无。

### 我们是如何解决这些错误的？
1. N/A

### 基线与证据
- 材料：`completion.md` R3 节

## 2026-09-21 · w251 README 大改（#251 first PR / R0 A）

### 我们实现了哪些功能？
1. 自 `origin/main`=`b4fb8841` 建分支 `w251-readme-overhaul`；四件已验素材原样 `cp` 入 `docs/assets/251/`（sha256 与 materials 一致）。
2. 根 README / README.zh-CN：See it work（封面+MP4 相对链、脚手架披露）；Human visibility 挂 tasks 截图；架构 Mermaid 补齐 DATA_DIR/lease journal/执行在外。
3. `tools.ts` 头注释 16→25；`docs/architecture.md` 基线注刷新；`DESIGN.md` 资产路径；`docs/i18n-glossary.md` 锚「看它工作」。
4. PR #307 Addresses #251；completion 落盘 `/home/ops/materials/251-readme/completion.md`；subagent 自审 PASS-WITH-NOTES。

### 我们遇到了哪些错误？
1. 未装依赖时 `bun test` 大量 fail（缺 hono / MCP SDK）。
2. 全量 api 测试 #206 `wait-precedence-r9` 偶发 25s 超时（已知 flake）。
3. markdownlint 对 GitHub 英雄 HTML 报 MD033（既有形态，非本卡引入）。

### 我们是如何解决这些错误的？
1. `packages/api` + `packages/mcp` 执行 `bun install` 后复跑。
2. 单文件复跑 `bun test ./test/wait-precedence-r9.test.ts` → 2 pass；完报注明 flake。
3. 不改英雄 HTML 去过 lint；link/anchor 自检 123/0 + JSON 示例 OK。

### 基线与证据
- Baseline：`b4fb884147f8613c2f858e9d1e726daa732e3fbd`
- HEAD：`7de6e009c057e7af0142d36741a25aaa587e4ecd`（rebase 到 `c756ee2` 后；此前 `7fbb2e94` 系 rebase 前旧 sha，已废弃仅存历史）
- PR：https://github.com/openagentemail/openagentemail/pull/307
- 测试：api 1933p/9s/#206 flake 复跑绿；mcp 48p/0f
- Subagent：`b2a13616-dafb-4779-bc2c-078ebdf62d95` → `~/.cursor/projects/home-ops-orca-workspaces-openagentemail-w251/agent-transcripts/b2a13616-dafb-4779-bc2c-078ebdf62d95/`

## 2026-09-21 · w305 #305 读取层降级修复

### 我们实现了哪些功能？
1. `taskFromMessages` claim 分支：已鉴权但与残留权威时间窗冲突的 claim，从整卡 `return null` 改为按无效事件出账（不推进权威、`duplicateLeaseMessages` 隐藏、继续重建）。
2. 结构类检查（state / generation 序 / 时间有限性 / 窗方向）仍 fail-closed，一行未改语义。
3. audit：`task.lease.claim_window_conflict_degraded` + `taskId`/`leaseGeneration` 白名单最小扩展；同键进程内去重（cap 1024）。
4. 测试：`task-lease-claim-window-conflict-305.test.ts` 覆盖正 1–3、负 1–3。

### 我们遇到了哪些错误？
1. 冷启动缺 `zod` 等依赖，`bun test` 无法 import。
2. `setFindTaskMessagesForTests` 未从 `task-test-seams` 导出；且 `getTaskForTests` 仍注入时会绕过 find 路径。
3. 全量套件 `#206` 25s timeout（预存 flake，与本卡无关）。

### 我们是如何解决这些错误的？
1. 在 `packages/api` 执行 `bun install` 后复跑。
2. 测试改为直引 `tasks-internal.setFindTaskMessagesForTests`，并在 snapshot 断言前 `setTaskGetForTests(null)`。
3. 完报注明 #206 flake；聚焦 5/5 绿；全量 1938 pass / 9 skip / 1 fail(#206)。

### 基线与证据
- Baseline：`6dc4368`（origin/main）
- HEAD：`3da97f9f87f9daaa8074adeb3e2eca2c323453f0`
- PR：https://github.com/openagentemail/openagentemail/pull/309
- Subagent：`2d66df28-0749-4696-8e77-efa904018ee3` → `~/.cursor/projects/home-ops-orca-workspaces-openagentemail-w305/agent-transcripts/2d66df28-0749-4696-8e77-efa904018ee3/2d66df28-0749-4696-8e77-efa904018ee3.jsonl`
- 完工报：`/home/ops/materials/305/completion.md`

## 2026-09-21 · w305 #305 R2 闸变返工

### 我们实现了哪些功能？
1. **P1**：降级冲突 claim 以证据记账——`appliedClaims.set` + `recordAcceptedWindow`；不写 `leaseAuthority`/`firstClaimedAt`；`previousGeneration` 作代际游标推进（同 tombstone），否则下一代 claim 仍整卡 null。
2. **P2**：降级 audit 加全局限频（`CLAIM_WINDOW_CONFLICT_DEGRADED_AUDIT_INTERVAL_MS`），防 >cap FIFO 击穿整批重写。
3. **测试**：冲突 claim + renew/release/expired/next-claim 四场景正/负控参数化；>cap 审计有界；公开面断言改为 `claim2.at`（CR nitpick）。
4. **P3**：Progress 路径 `~` 化；`leaseGeneration` 非有限静默丢弃补注释。

### 我们遇到了哪些错误？
1. FC 卡字面「不动 previousGeneration」与测试④「下一代 claim 可读」冲突——不推进游标则 gen 序仍整卡 null。
2. 全量偶发 `#272` dist-build-lock / `#206` wait-precedence 超时（预存/环境，与本卡无关）。

### 我们是如何解决这些错误的？
1. 游标推进、权威字段不动；完工报写明偏离与理由（Codex P1 / tombstone 同型）。
2. 聚焦 14/14 绿；完报注明全量 flake。

### 基线与证据
- HEAD：`b1dcf29` · PR #309 · diff vs main：+554/−3（未越 600）
- 聚焦 14 pass；全量 1947p/9s/1f(#272 flake)
- Subagent R2：`6673b8c2-0697-4c6b-9e44-a4baad7f4f2f` → `~/.cursor/projects/home-ops-orca-workspaces-openagentemail-w305/agent-transcripts/6673b8c2-0697-4c6b-9e44-a4baad7f4f2f/`
- 完工报：`/home/ops/materials/305/completion.md`（含 R2 节）

## 2026-09-21 · w305 #305 R3 降级代复用编号

### 我们实现了哪些功能？
1. `degradedClaimGenerations` 区分降级证据 vs 已接受证据。
2. dup gate：已接受异容仍整卡 null；降级异容下落重评估。
3. generation 门：降级代 `generation===previousGeneration` 可重评；跨代跳号仍 fail-closed。
4. 重评估：`claimedAt>=权威窗` 接受并清降级标记；`<窗` 再降级、权威不推进。
5. 边界测试：接受 gen2' 后迟到旧 verifier renew → 保守 null（显式声明）。

### 我们遇到了哪些错误？
1. R2 证据记账后写路径过期复用 gen2 → dup gate 整卡 null（R1 无此回归）。

### 我们是如何解决这些错误的？
1. 按上列语义修 + RED→绿；聚焦 18/18；全量 1952p/9s/0f。

### 基线与证据
- HEAD：`f33ec0a` · PR #309 · diff vs main：**+693/−7（已越 600；测试 538 行主体）**
- 自审 R3：`f57b57c5-32de-4c45-aa0a-35bed0889d3e` → `~/.cursor/projects/home-ops-orca-workspaces-openagentemail-w305/agent-transcripts/f57b57c5-32de-4c45-aa0a-35bed0889d3e/`
- 完工报：`/home/ops/materials/305/completion.md`（R3 节）

## 2026-09-21 · w305 #305 R3 追加（高水位+E2E+计数器+PR 描述）

### 我们实现了哪些功能？
1. **并用** `leaseGenerationHighWater` 计入 `claimTask` durableGen（与读侧重评估双保险）。
2. `claimTask` 端到端：seam 降级 → 真实分配 gen3 → 重建。
3. `claimWindowConflictDegradedCount` + take 缝（限频吞键可观测）。
4. PR #309 描述补「回归点名」「偏离声明」；completion 映射表；越 600 总指挥已核准。

### 我们遇到了哪些错误？
1. E2E 初版 `sent.length===1` 在 M3-off expiry 物化下收到 2 封。

### 我们是如何解决这些错误的？
1. 按 `X-OA-Task-Lease-Event===claim` 取签发信。聚焦 19/19；全量 1952p/#206 flake。

## 2026-09-21 · w305 #305 R4（Codex 2×P1：release 残渣 + 多降级代）

### 我们实现了哪些功能？
1. **P1-B**：`clearDegradedGenerationResiduals(G)`——重评估接受与重新降级覆盖时清理同代 `appliedReleases`/`appliedRenews`/`seenRenewCanonical`（保留 `acceptedDeadlineWindows`）。旧实例 historical release 不再挡住新 token release。
2. **P1-A①**：连续降级 gen2+gen3 → highWater=3 → `claimTask` E2E 分配 **gen4**。
3. **P1-A②**：读侧重评估门 **保** `gen === previousGeneration`（不放宽 ≤prev）；更早代 gen2' 在 prev=3 时整卡 null（显式声明+钉测）。理由：放宽会使 prevGen 回退并与更高降级代残渣交错。
4. **P1-1（Codex e8ec6aa 复审）**：`Task.degradedLeaseClaims` 私有降级身份全史；`eventIsIndexed` claim 分支精确身份匹配决退 overlay/journal——**不授权**；不用 high-water 代际短路。
5. ZCode P2 限频计数器：e8ec6aa 已补；本轮未改限频结构。

### 我们遇到了哪些错误？
1. RED：降级 gen2 + 旧 release → gen2' 接受 → 新 release → 整卡 null（priorRelease 异容门在权威判定前）。
2. 推演放宽重评估门：接受 gen2' 会把 previousGeneration 从 3 回退到 2，与 gen3 降级残渣/高水位语义冲突。
3. RED P1-1：durable 已降级 gen2 后，queued/journal 同身份 claim 永不退休 → `applyOverlayMessages` 复现为活跃权威 gen2。

### 我们是如何解决这些错误的？
1. 证据换代时清同代 release/renew 残渣（accept + re-degrade 同清）。
2. 保 tip 门 + 写路径 highWater 覆盖多降级；钉测 gen2'→null。
3. 重建填充 `degradedLeaseClaims`；`eventIsIndexed` 身份匹配退休；TaskView Omit；①合并权威=前窗+队列空②非降级回归③journal fate=indexed；②b high-water  alone 不误退。
4. 聚焦 **28 pass**；全量 1961p/9s/1f(#206 flake)；自审 PASS-WITH-NITS（已补②b）。

### 基线与证据
- HEAD：`3d61162`
- 自审 R4：`42f6b61a-fa6d-463c-9c21-48b42e15a284`（P1-A/B）
- 自审 R4 P1-1：`571c93b9-4815-4299-9e24-e256a3bd86f0`
- 完工报：`/home/ops/materials/305/completion.md`（R4 节）

## 2026-09-21 · w305 #305 R5（同代替换流已消费重放幂等）

### 我们实现了哪些功能？
1. **R5-1 renew**：`clearDegradedGenerationResiduals` **不再清** `seenRenewCanonical`/`appliedRenews`（grep 确认 appliedRenews 无读方；新实例 renew key 不同不受影响）。
2. **R5-1 release**：清门前把 prior release 身份迁入 `consumedReleaseCanonical`；release 分支早段精确命中 → dup no-op；`appliedReleases` 门照旧清（保 P1-B 新 token release）。
3. **R5-2 claim**：在 `!priorIsDegraded → null` 前，精确命中 `degradedLeaseClaims` → dup no-op（不放宽异容全新 vs 已接受 → null）。
4. **R5-3**：评估后**不改**限频结构（见下）。

### 我们遇到了哪些错误？
1. RED：已消费 renew/release 在替换后精确重放 → 去重表被清 → verifier 失配 → 整卡 null。
2. RED：已消费降级 claimV1 在 accept 后精确重放 → priorIsDegraded=false → 整卡 null。
3. R5-2(b) 弱断言曾假绿：V1 dup 经降级路径重记账；加强为 STILL renew 探针。

### 我们是如何解决这些错误的？
1–2. 按上列语义修；聚焦 **34 pass**；全量 api **1968p/9s/0f**；mcp **48p/0f**。
3. R5-3 评估（≤300 字）：`noteClaimWindowConflictDegraded` 先 `seen.set` 再过 60s 限频 → 被吞键永不补写 audit。若「吞掉时不记 seen」：第二轮同序在窗内会对未入 seen 键反复 count，破坏 pin `count=(cap+1)×2`（现依赖 FIFO 淘汰后整轮再 miss）；若同时改 count 口径则动既有 >cap 钉。count 已暴露 ops 可读（`takeClaimWindowConflictDegradedCountForTests`）。**记债：保持先 seen 后限频 + count 兜底；不改 pin/60s 上界。交 FC 呈裁是否另开「限频失败不入 seen + 调整 count 语义」卡。**

### 基线与证据
- HEAD：`b3834496c29115a040d4bcfa59438d1e732e3c6d`（功能 `d2398c5` + Progress）
- 自审 R5：`258af8a9-ea6f-4c3a-8538-7fa4d028fb76` → PASS-WITH-NITS（已补 R5-3 债）
- 完工报：`/home/ops/materials/305/completion.md`（R5 节）

## 2026-09-21 · w305 #305 R6（historical renew/release overlay 决退）

### 我们实现了哪些功能？
1. `Task.historicalRenewReceipts` / `historicalReleaseReceipts`（TaskView Omit）——对称 `degradedLeaseClaims`/`expiryReceipts`。
2. 填充：Late historical renew/release 记账路径；R5 `clearDegradedGenerationResiduals` 迁出的 release 一并暴露。
3. `eventIsIndexed`：精确身份命中即退休（renew 在 generic 尾前；release 在 release 分支）；**无代际短路**；不碰 expired/claim 既有逻辑。

### 我们遇到了哪些错误？
1. RED：durable 消费降级代 historical renew/release 后，queued 行不退休 → `applyOverlayMessages` 无条件延长权威窗 / 清空权威。

### 我们是如何解决这些错误的？
1. 证据暴露 + 精确决退；聚焦 **39 pass**；M1 overlay 全绿；R6(a–e) 钉污染/误退/journal。
2. 全量 api 1972p/9s/1f(#206) → 复跑一次留证；mcp 48p。

### 基线与证据
- HEAD：`04419f2416331d7d9bdee1e94a05c02da23ce699`
- 自审 R6：`0e736c72-dd30-49d1-ba4e-4895d04a0172` → PASS-WITH-NITS
- 完工报：`/home/ops/materials/305/completion.md`（R6 节）

## 2026-09-21 · w305 #305 R7（pending 降级 follow-on 抑制投影）

### 我们实现了哪些功能？
1. `degradedInstanceFollowOn`：renew|release 且 degradedLeaseClaims **gen+verifier** 精确匹配（无代际短路）。
2. `mergeQueuedEvents` 分流：写回全量 `stillLagging`（保 pending）；投影只用 `applicable`；空 applicable → 原样返回；publicRead 有界同样喂 applicable。
3. **不改** `eventIsIndexed` / journal / applyOverlayMessages 内部语义。
4. claim_lost：无 verifier、服务器对权威租约签发，降级代不可达 → 不扩（评估一句）；expired 既有 authority 匹配守卫确认未动。

### 我们遇到了哪些错误？
1. RED：降级 claim 已索引、follow-on renew/release 未进 durable → pending 行被投影并进前一代权威。

### 我们是如何解决这些错误的？
1. 抑制投影、保留 pending；R6 已消费路径仍精确退休；聚焦 **44 pass**；M1 全绿；api 1977p/1f(#206)→复跑绿；mcp 48p。

### 基线与证据
- HEAD：`ee49e7095754c44b0b6e2616bce99f774cc2ccb5`
- 自审 R7：`ac7eb955-9fa2-49b4-a7a7-7f8395f69494` → PASS-WITH-NITS
- 完工报：`/home/ops/materials/305/completion.md`（R7 节）

## 2026-09-21 · w305 #305 R8（矩阵收口 · test-only）

### 我们实现了哪些功能？
1. 钉测 GAP?-1a/1b/1c、GAP?-2（乐观 overlay / 索引 fail-closed / 同队列收敛）。
2. completion + PR「矩阵产物 · 已声明边界」节。
3. **未改生产代码**；可选证据缺口 5 处本轮未补（缺矩阵原文，避免误判）。

### 我们遇到了哪些错误？
无（四钉先跑现状均与声明一致）。

### 我们是如何解决这些错误的？
N/A。聚焦 **48 pass**；api **1982p/9s/0f**；mcp **48p**。

### 基线与证据
- HEAD：`9dd39360f16ce8a625afe979b294af99dffac6ca`
- 自审 R8：`61c9bee6-d5f7-464c-852d-e89f01558a23` → PASS-WITH-NITS（docs 本轮补齐）
- 完工报：`/home/ops/materials/305/completion.md`（R8 + 矩阵边界节）
## 2026-09-21 · w289x3 合批 #289+#290+#302

### 我们实现了哪些功能？
1. **#289**：`WEBHOOK_URL_REJECT_DETAILS_WHITELIST` 前 8 条；create/update 拒绝响应白名单内附 `details:'<reason>'`，白名单外响应逐字节同现状；两拒绝点 `console.warn` 单行 JSON `{kind:'webhook_url_rejected', reason, address, webhookId?}`，URL 原文不入。
2. **#290**：`executeWebhookTestProbe` 熔断置位后对齐主路径——补 `webhook.disabled` audit；retryable 就地转 permanent（`reason=webhook_disabled`）；不调 `deliveryQueue.schedule`；RFC §8.5 增补懒清理有意声明（结算时刻死信时间戳）。
3. **#302**：`readApprovalPayloadHeader` 同款 `value.replace(/\s+/g,'')` 后严格 round-trip；`docs/task-lease-reason-transport.md` 两解析器共述；lease 解析器未动。
4. 聚焦测试 `packages/api/test/w289x3-batch.test.ts`（10 例）。

### 我们遇到了哪些错误？
1. 未 `bun install` 时缺 hono，聚焦测试无法启动。
2. 全量 api 套件 `#206`「直跑无父标记时不动既有 DATA_DIR」偶发 25s 超时（已知 flake；同文件矩阵例绿）。

### 我们是如何解决这些错误的？
1. `packages/api` + `packages/mcp` 执行 `bun install` 后复跑。
2. 单文件复跑 `bun test ./test/wait-precedence-r9.test.ts` → 2 pass；完报注明 flake 隔离照旧。

### 基线与证据
- Baseline：`origin/main` = `6dc43682f6b5855fe0fa081c311b2fd61e177401`
- 分支：`tizerluo/w289x3`
- 聚焦：`bun test test/w289x3-batch.test.ts` → **10 pass / 0 fail**
- 全量 api：`1943 pass / 9 skip / 1 fail`（#206 flake；隔离复跑绿）
- mcp：`48 pass / 0 fail`
- Diff：`577 insertions / 18 deletions`（<600）
- 材料：`/home/ops/materials/289-290-302/`（r0.md + completion.md）

### 交付钉（完工后补）
- HEAD：`d0949bae8500e1301b755bcd5a3b8ff19d01d838`
- PR：https://github.com/openagentemail/openagentemail/pull/310
- Subagent：`b9d1edb7-1a76-4ed0-ab9c-bc4ba71ad000` → PASS（R0 七点）
- completion：`/home/ops/materials/289-290-302/completion.md`

## 2026-09-21 · w289x3 R2（P1-2 ping 假重复 audit）

### 我们实现了哪些功能？
1. **R2-1 / P1-2**：`executeWebhookTestProbe` 熔断段改为「已 disabled 则跳过 +1」；仅 `trippedThisAttempt`（本次实际 threshold→disabled）才写 `webhook.disabled` audit + retryable→permanent；中途已禁用则只抑制 attempt-2（permanent/`webhook_disabled`），不重复 audit。
2. RED：`in-flight ping + manual disable`——audit 恰好 1、计数不 +1、disabledReason 保持 manual、无 attempt-2；既有阈值触发例仍绿。
3. **R2-2 / P1-1**：malformed_url REST 不可达——本轮**不动路由 schema**，候总指挥裁定。

### 我们遇到了哪些错误？
1. 首跑 RED 时 import `recordAuditEvent` 与测试体写入竞态 → ReferenceError（复跑即绿）。
2. 全量 api `#206` 偶发 25s flake（隔离复跑绿）。

### 我们是如何解决这些错误的？
1. 确认 import 落盘后单测/聚焦复跑全绿。
2. flake 隔离照旧，完报注明。

### 主路径存量同族（不修）
主路径 `runExecuteJob`（webhook-delivery.ts ~2437-2459）同款「更新器内守卫 + 外层 `updated?.state === 'disabled'` 终态判定」仍在；#290 红线「不动主路径」，本轮仅修 ping，记债不扩。

### 基线与证据
- 父头：`d0949bae`
- 聚焦：11 pass（+1 R2 RED）
- api：1944p / 9s / #206 flake；隔离 2p
- mcp：48p

### 交付钉（R2）
- HEAD：`e7ad15337fc580b0c7112515ffba9b2f1b2c2191`
- Subagent：`2866aafe-9b6e-4c38-9ff2-9da08719e2b6` → PASS

## 2026-09-21 · w289x3 R3（P1-1 schema a + afterAll + RFC）

### 我们实现了哪些功能？
1. **A / P1-1 方案 a**：create/update `url` 去掉 `.url()`，保留 `.max(2048)`；`not-a-url` → `invalid_webhook_url` + `details: malformed_url`（create+update）；dns_empty 负控不变；超长仍 `invalid_request`（Item 4 绿）。
2. **B**：`w289x3-batch.test.ts` afterAll：`deleteIdentity` 先于恢复 `config.dataDir`。
3. **C**：RFC §8.5 懒清理限定 threshold；明写 manual disable / delete 为 eager `cancelForWebhook`。
4. **D**：PR #310 描述落痕契约变更 + 主路径同族债三要素。

### 我们遇到了哪些错误？
1. #206 全量偶发 25s flake（隔离复跑绿）。

### 我们是如何解决这些错误的？
1. flake 隔离照旧。

### 超长 URL 证据（A-2）
- `packages/api/test/webhooks-route.test.ts`「Item 4 & Item 8」：`overlongCreate` / `overlongUpdate` 断言 `error === 'invalid_request'` → **pass**（R3 后复跑）。

### 基线与证据
- 父头：`e7ad1533`
- HEAD：（完工后补）
- 聚焦：13 pass
- api：1946p / 9s / #206 flake
- mcp：48p

### 交付钉（R3）
- HEAD：`cfa29f9b5685d7537a3d34088ef901f8c1eed41c`
- Subagent：`4159a841-6619-4285-a132-5479828a6261` → PASS
- PR #310 描述已更新（契约变更 + 主路径债）

## 2026-09-21 · w289x3 R4（rebase → origin/main 30155ea0）

### 我们实现了哪些功能？
1. 提交 Progress 后 rebase 到 `#305` 并入后的 `30155ea0`；Progress 冲突保双侧；其余自动合并。
2. 自核 a–d 全过；force-with-lease 推送。

### 我们遇到了哪些错误？
1. 仅 Progress.md content conflict（预期）。

### 我们是如何解决这些错误的？
1. 保 #305 段 + 本卡 R0–R3 段顺序拼接，去冲突标记。

### 基线与证据
- HEAD：`5000dbd682f11e84bebc7eebf02cfe3e0b41aa31`
- 聚焦 13p；api 1995p/9s/0f；mcp 48p
- 完工件：`/home/ops/materials/289-290-302/completion.md` R4 节

## 2026-09-21 · w289x3 R5（update 空 URL）

### 我们实现了哪些功能？
1. update 路径 `url` 门改为 `!== undefined`；空串 400 + `malformed_url`。
2. 测试 create+update `url:""` 同形验收。

### 我们遇到了哪些错误？
无。

### 我们是如何解决这些错误的？
N/A。

### 基线与证据
- HEAD：`7e8acb27b8509bd8fc8405a7ef1b771f687d1646`
- 聚焦 14p；api 1996p/9s/0f；mcp 48p
- Subagent：`c8b3a09d-a98e-4406-98d7-592c10aa4d8a` → PASS

## 2026-09-21 · w289x3 R6（#302 dataDir 隔离）

### 我们实现了哪些功能？
1. #302 改 `config.dataDir` 临时目录；afterEach 恢复+删除；afterAll alice 守卫。
2. filtered `-t '#302'` 实证真实 `./data/identities.json` 前后不变（exists=false）。

### 我们遇到了哪些错误？
无。

### 我们是如何解决这些错误的？
N/A。

### 基线与证据
- HEAD：`8ee8625175ffc444a7bb59aa411b8be0b3cd0031`
- 聚焦 14p；filtered 2p；api 1996p；mcp 48p
- Subagent：`f0335d8c-4a7c-4ba8-a987-421cd9ed89e1` → PASS

## 2026-09-21 · w289x3 R7（afterAll webhook 清理作用域）

### 我们实现了哪些功能？
1. afterAll 方案 b：文件清理钉 `TEST_DATA_DIR` 后再 `resetWebhooksStoreForTests` + `deleteIdentity`。
2. filtered 四文件探针（identities + webhooks 三件套）前后一致。

### 我们遇到了哪些错误？
1. 全量 api #206 偶发 25s flake（隔离复跑绿）。

### 我们是如何解决这些错误的？
1. flake 隔离照旧。

### 基线与证据
- HEAD：`7d3b7b3cd049d4f91887d9c408578d339ce8f716`
- Subagent：`b36d38dd-2fe4-479b-a968-6744e599fda4` → PASS

## 2026-09-22 · w308（B2 非 journal pending-index fence）

### 我们实现了哪些功能？
1. `claimTask`（`tasks-internal.ts`）在 journal 门控 **else** 分支加 pending-index fence：queued 中存在未 durable 吸收的 `release`/`renew` 时抛 `lease_overlay_pending_index`（复用既有 409 码）。
2. 吸收判定用 `getTaskSnapshot(..., { mergeOverlay: false })` + `eventIsIndexed`（durable 语义，镜像 `mergeQueuedEvents`）。
3. 新测 `task-lease-write-side-fence-308.test.ts`：release/renew 各一组「pending→409」+「吸收后重试成功」；对照「无 release/renew 零误伤」与「未索引 claim1 → lease_already_claimed」。
4. 适配 R12 既有「release→reclaim」用例：先吸收 release 再 reclaim（对齐 #308 语义）。
5. README / README.zh-CN / packages/mcp/README 记明 journal-off 下的瞬态 409 重试窗。

### 我们遇到了哪些错误？
1. 测试调用 `queuedLeaseOverlayCountForTests()` 未传 `taskId` → 恒为 0。
2. api 全量：`R12 GREEN: released working task reclaims...` 在 release overlay 未吸收时立即 reclaim → 命中新 fence 409。
3. api 全量偶发 `list-rate isolate` flake（隔离复跑绿；与本卡无关）。
4. 本仓库为 Bun/TS，无 Python `requirements.txt` 适用面（依赖由 `packages/*/bun.lock` 管理）。

### 我们是如何解决这些错误的？
1. 改为 `queuedLeaseOverlayCountForTests(ID)`。
2. R12 改为 claim/release 均先 `taskFromMessages` 吸收进 durable 再 reclaim；断言语义（gen2 / 鉴权 release 回执）不变。
3. 隔离复跑确认预存 flake；不纳入本卡修面。
4. N/A（不生成虚假 pip freeze）。

### 基线与证据
- 基线 main：`da9343ca` · HEAD：`98d023814425b2cc9464bd0bbd7880704dfd1c92`
- 分支：`tizerluo/w308` · PR：https://github.com/openagentemail/openagentemail/pull/318
- focused：6 pass（308）；305+m2+core 回归绿；R12 适配后绿
- mcp：48 pass / 0 fail
- api 全量：2044 pass / 9 skip / 1 fail（list-rate isolate flake；隔离 5 pass）
- Subagent：`38e5c3c9-a01b-4ac6-8ac5-597822024173` → PASS
- completion：`/home/ops/materials/308/completion.md`

## 2026-09-22 · w308 R1（闸变：15min 上界 + I/O + fail-closed）

### 我们实现了哪些功能？
1. P1：`CLAIM_FENCE_MAX_MS` 镜像 OVERLAY_BOUND 15min；只挡 fresh release/renew；超龄放行 + audit `task.lease.claim_fence_expired`（去重/限频同 #305）。
2. P2：无候选零 durable I/O；有 fresh 才一次 `getTaskSnapshot(mergeOverlay:false)`。
3. P3-1：durable null → 409 fail-closed（删 `durable ?? current`）。
4. P3-2：README×3 + PR #318 描述改为「瞬态 + 15min 上界自愈」，去掉「非死锁」过强承诺。
5. 测试扩至 10 例（超龄 release/renew、P2 I/O、P3-1）。

### 我们遇到了哪些错误？
1. renew 超龄测用 leaseSec=300，推进 15min 后窗已过期 → claim 成功而非 `lease_already_claimed`。

### 我们是如何解决这些错误的？
1. renew 超龄测改 leaseSec=3600，保证超龄时窗仍活。

### 基线与证据
- 基线：`4e7e0d1` → HEAD：`65c8d6c56c18cc3ac2a99a9401c88ef5bb6ac1ae`
- focused 308：10 pass；回归 305/m2/core：155 pass
- api 全量：2049 pass / 9 skip / 0 fail
- mcp：48 pass
- Subagent：`ca06a22d-e089-478d-8680-8390f889f051` → PASS
- completion：`/home/ops/materials/308/completion-r1.md`
- PR：https://github.com/openagentemail/openagentemail/pull/318

## 2026-09-22 · w308 R1.1（fox #4428 附则收口）

### 我们实现了哪些功能？
1. `noteClaimFenceExpiredForTests` 测试缝（镜像 degraded forTests）。
2. audit 限频 pin：60s 内两异键 count=2/audit=1；>60s 第三键 audit=2。
3. `setFindTaskMessagesForTests` I/O 机械证据：正常 find=1 / fresh=2（console 原始输出）。
4. P1 并入上界前多次持续 409；PR 描述补证伪史 + 评论贴 I/O 原始输出。

### 我们遇到了哪些错误？
无。

### 我们是如何解决这些错误的？
N/A。

### 基线与证据
- 基线：`5f415f6` → 见本次 HEAD
- focused：12 pass / 0 fail
- I/O：`findTaskMessagesCalls` 1 / 2
- Subagent：`8dc48cdf-91ff-438e-9fd7-b10e2d87dba3` → PASS
- completion：`/home/ops/materials/308/completion-r1.1.md`

## 2026-09-22 · w308 R1.2（fence age 起算点 = enqueuedAt）

### 我们实现了哪些功能？
1. `QueuedEvent.enqueuedAt`：`queueEventUntilIndexed` 用 `nowMs()` 记入队时刻。
2. fence age：`nowFence - (enqueuedAt ?? sentAt)`；`sentAt` 语义零改（读侧 TTL/overlay 不动）。
3. 测试钉「SMTP 耗时 16min → 立即 re-claim 仍 409」（旧 sentAt 起算会误放行）。

### 我们遇到了哪些错误？
无。

### 我们是如何解决这些错误的？
N/A。

### 基线与证据
- 基线：`f285124` → 见本次 HEAD
- focused：13 pass；回归 305/m2/core：158 pass
- Subagent：`ba805120-57ce-4784-a648-043f47f1bc81` → PASS

## 2026-09-22 · w244 R4（测试隔离 · 子集合跑假红）

### 我们实现了哪些功能？
1. `compose-webhooks.test.ts`：import config 前隔离 `DATA_DIR`（mkdtemp）+ 补齐 webhook/task 签名密钥；ENV 快照与 afterAll 还原；自建 DATA_DIR 清理。
2. `identity-delete-audit.test.ts` / `mark-seen-rate.test.ts`：afterAll 清理 provision / mark-seen 注入缝。

### 我们遇到了哪些错误？
1. `bun test compose-webhooks + identity-delete|mark-seen` 子集确定性红（createIdentity null / webhook 签名缺密钥）。
2. 根因：compose 未设 DATA_DIR 即锁定 config 单例到共享 `./data`。

### 我们是如何解决这些错误的？
1. 污染源自理：导入前隔离 + afterAll 还原；两新文件 afterAll 清注入。
2. 验收：复现×2、5 文件合跑、全量 2092/0 全绿；材料 `/home/ops/materials/244-245/r4-*`。
3. Subagent：`2346fa9f-0dc5-4516-9897-da40749804a4` → PASS_WITH_NOTES。

## 2026-09-22 · w244 R5（审计 address 上限 320）

### 我们实现了哪些功能？
1. `audit.ts`：具名常量 `AUDIT_ADDRESS_MAX_LEN=320`；`recordAuditEvent` 的 `address` 分支改用该上限（覆盖 63+1+253=317）。
2. `parentIdentity` 改用同常量（上限原已 320，行为不变）；其它字段上限不动。
3. 测试：317 长地址删除逐字节一致 + 控字剥离；恰好 320 / 超 320 截断。

### 我们遇到了哪些错误？
1. Codex P2：identity.delete 的 address 走默认 scrub 256 → 长地址静默截断。
2. 全量偶发 `#149 hanging probe` 超时假红（与本修无关，重跑）。

### 我们是如何解决这些错误的？
1. 引入 AUDIT_ADDRESS_MAX_LEN 专用于 address 分支。
2. focused 10 pass；全量见材料；Subagent `5bdf7b98-075d-4085-a346-c366e43c8c97` → PASS。

## 2026-09-22 · werrn（非 Error rejection 归一化 · 只消 500）

### 我们实现了哪些功能？
1. 新增 `packages/api/src/lib/errors.ts`：`errorCode(err)`，哨兵 `''`，与 `tasks.journalUnavailable` 历史 `typeof raw === 'string' ? raw : ''` 同语义。
2. `routes/ui.ts`：`journalUnavailableUi` / `taskMutationError` 三读点改用 `errorCode`（基线约 `:266/:274/:291` → 现约 `:268/:277/:294`）。
3. `routes/tasks.ts`：create 段 catch、post-create journal 503 响应值、post-create warn 三读点改用 `errorCode`；`journalUnavailable` 收敛到同一 helper（基线约 `:228/:264/:266` → 现约 `:229/:266/:268`）。
4. 测试：`errors.test.ts`（helper 单测）+ `err-normalize-rejections.test.ts`（正控 A create/post-create、正控 B UI remind、Error 路径守门负控逐字节）。
5. **未改对外错误码**；其余 31 处 `(err as Error).message` 不碰（#332）。

### 我们遇到了哪些错误？
1. 工作树初无 `node_modules`，`bun test` 报 `Cannot find package 'hono'` → `bun install` 后恢复。
2. 全量 `bun test`：`#206 R9 撤销/断开优先级 > 直跑无父标记时不动既有 DATA_DIR` 超时 25s 假红（与本卡无关；**未** rerun-to-green）。
3. 曾误想把 `undefined` 加进 `#241` state 突变用例——该 catch 后续读点仍属 #332，会红；已撤回。

### 我们是如何解决这些错误的？
1. 在 `packages/api` 执行 `bun install`（锁文件未改、node_modules gitignore）。
2. 如实记入材料与完工件；结果 **2122 pass / 9 skip / 1 fail**（基线 2104/9/0；+18 为本卡新测）。
3. `#241` 注释改为标明 state 路径仍有 #332 债；正控 `undefined` 只钉在本卡映射器族用例。

### 基线与证据
- 基线：`5b7d8d51`（#331）
- 原始全量输出：`/home/ops/materials/err-normalize/bun-test-full-20260922T195904Z.txt`
- sha256：`d9b503b094bc686259f336e0ea4f93f998f8cd645b9e0b8eca44f21e6219f06e`

## 2026-09-22 · w330（#330 兜底码语义化）

### 我们实现了哪些功能？
1. `packages/api/src/routes/tasks.ts` 六处租约/状态路由兜底：`claim`/`lease`/`release`/`claim-lost`/`decision`/`state` 的 `502 {error:'smtp_error'}` → `task_operation_failed`（create 段 `:238` 保留）。
2. `packages/api/src/routes/ui.ts:295` UI `taskMutationError` 同改；已映射 404/409/429/403/400/journal 503 不动。
3. 正控+守门负控：`test/task-operation-failed-fallback.test.ts`（7 正控 + 六路由/UI 已映射码 `toEqual`）；对齐 `task-lease-route-contract` / `err-normalize` / `ui-tasks` / `tasks` / `r3-parent-child` 既有期望。
4. `CHANGELOG.md` Unreleased → Changed 一条；矩阵与 website 逐字表见完工件（不入 docs）。
5. **未碰**：`tasks-internal.ts`、#332 的 31 处、`mailserver-reconnect.ts`、create `:238`。

### 我们遇到了哪些错误？
1. 工作树初无 `node_modules` → `Cannot find package 'hono'`。
2. 全量首跑：两处既有断言仍锁 `smtp_error`（`tasks.test.ts` #241 state 兜底；`r3-parent-child-routes.test.ts` imap_write_failed）+ `#206` 25s 超时 → 3 fail。
3. 对齐后全量再跑：`2185 pass / 9 skip / 1 fail`——唯一红改为 `#272 dist-build-lock` 压力用例超时（预存墙钟/锁债族，非本卡引入；**未** rerun-to-green）。

### 我们是如何解决这些错误的？
1. `cd packages/api && bun install`（锁文件未改）。
2. 将上述两处期望改为 `task_operation_failed`（与生产兜底对齐）；本卡相关 focused 全绿。
3. 如实落盘两份全量原始输出（首跑 3 红 + 对齐后 1 红），禁重跑刷绿。

### 基线与证据
- 基线：`bd4678b3`（= main / #333）
- 功能 commit：`5d82a310`
- focused：`/home/ops/materials/330/focused-20260922T212949Z.txt`
- 全量首跑：`bun-test-full-20260922T212956Z.txt` sha256 `90b71d9f…`
- 全量对齐后：`bun-test-full-postalign-20260922T213257Z.txt` sha256 `e1fef46d…`

## 2026-09-22 · w330 收尾（自审 + PR）

### 我们实现了哪些功能？
1. PR #334 已开（未合并）：https://github.com/openagentemail/openagentemail/pull/334
2. #330 issue 已贴矩阵摘要 + 证据路径。
3. 完工件：`/home/ops/materials/330/completion.md`（矩阵 + website 逐字表 + 证据 sha256）。

### 我们遇到了哪些错误？
1. 无新增施工错误。

### 我们是如何解决这些错误的？
1. Subagent 独立自审 `077123c5-e23b-49d5-8fbd-7a4367a86800` → **PASS_WITH_NOTES**（红线合规；吞码清单与源码一致）。

## 2026-09-22 · w330 R2（Codex P2 文档口径订正）

### 我们实现了哪些功能？
1. `CHANGELOG.md` Unreleased #330 条目：删除错误「这些路径不发 SMTP」；改为三点准确口径（写入会投递邮件 / SMTP 失败是兜底成因之一 / 同时收纳未映射域码故不可单一归因 SMTP）。
2. `/home/ops/materials/330/completion.md` §6 website 表最后一行「含义」单元格同步订正（交 Studio 真源须准）。
3. **生产码 / 测试断言一字未动**（测试注释无「不发 SMTP」照抄）。

### 我们遇到了哪些错误？
1. 错源在 R0/卡面「这些路由不发任何邮件」——FC 认账；Codex P2 属实。

### 我们是如何解决这些错误的？
1. 仅修 CHANGELOG + 完工件表行两处文字；独立 commit；Progress 另起独立 commit；重绑六格。
