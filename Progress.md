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
