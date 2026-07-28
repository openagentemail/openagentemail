# DESIGN.md — /ui Dashboard 设计分册

> **正源在 website 仓库的 `DESIGN.md`**（品牌、令牌、组件、动效规则全在那里）。
> 本册只记 /ui 特有的事实。改 /ui 视觉前先读正源，再读本册。

## 1. 与官网的一致性（硬约束）

- **CSS 令牌与官网同值**：`packages/api/src/ui/assets.ts` 的 `:root` 逐项等于 website `src/styles/global.css`（`--bg #0c0d12`、`--gold #fbbf24` 等全套）。改任何一边，另一边同步改。
- **Satoshi 字体同源同文件**：/ui 从 `/ui/fonts/Satoshi-*.woff2` 自供（`routes/ui-assets.ts`），测试用 sha256 钉死与 `website/public/fonts/` 一致——**换字体文件必须两边一起换，否则测试红**。
- **唯一有意偏差**：/ui 多 `--line-control: rgba(255,255,255,.34)`，专给表单控件描边（≥3:1 对比度要求）。这是官网上没有的一行，回退成本 = 删一行。

## 2. /ui 自身的硬限制（设计必须在这些约束里做）

- **CSP `font-src 'self'`**：不放行任何外源字体/样式（assets.ts 头部注释即此约定）。
- **favicon**：`/ui/favicon.svg` 同源提供；`/ui/favicon.ico` 保持 204（历史约定，别"修"它）。
- **HTML 邮件预览永远不可信**：预览走双重消毒 + 独立 sandbox frame + 严格 CSP。给预览区加任何样式都不能依赖邮件自身的 CSS/图片/链接——它们会被剥光。
- **无构建步骤**：/ui 的 CSS 是 `assets.ts` 里的模板字符串（`UI_CSS`），改样式 = 改这个文件，别引入打包器。
- `UI_ENABLED=false` 时所有 /ui 路由 404（部署侧开关，不是 bug）。

## 3. 页面清单

| 页面 | 受众 | 要点 |
|---|---|---|
| 登录页 | 所有人 | 令牌登录 + "Trust this device"（30 天滑动会话）；非本地明文 HTTP 拒绝登录；视觉与官网登录气质一致（logo、金色主按钮） |
| Overview（仅 admin 会话） | 站长 | 全部身份一览表：消息数/未读数/最近投递/创建日 + 顶部合计卡；计数是"窗口"语义（newest N of M），`≥N`/`Unknown` 是合法显示值，不许改成假精确 |
| Inbox（身份会话） | agent/人 | 单邮箱收件箱；Refresh 与标题对齐 |
| 邮件详情 | 人 | 验证码/链接提取框（核心卖点视觉，金色 code-chip 风格与官网一致）；"标为已读/未读"是 /ui 唯一写操作按钮 |

## 4. 组件与气质

- 与官网共用：卡片（`--bg-card` + `--line` 描边）、金色主按钮、ghost 次按钮、mono 验证码芯片、绿=成功 红=失败。
- 表格：行 hover 微亮即可，不做斑马纹（深色画布上显脏）。
- 响应式：≤900px 管理表转卡片布局；触点目标 ≥44px。
- 空状态：一句话 + 一个动作，不做插画。

## 5. 文案语气（/ui 特有）

- 状态要"诚实"：刷新失败就说失败并保留旧数据；加载中就显示 `Loading…`；计数语义在页面上解释清楚（见 README "Admin overview" 节）。
- 按钮动词：`Refresh` / `Mark as read` / `Mark as unread` / `Copy`，不用 "OK/Sure"。
