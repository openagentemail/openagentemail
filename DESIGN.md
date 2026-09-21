# DESIGN.md — /ui 与仓库展示设计分册

> **品牌正源在 website 仓库的 `DESIGN.md`**（品牌、令牌、组件、动效规则）。
> 本册记录 /ui 与 README 的局部约定。改视觉前先读正源，再读本册。
> 文档不是运行时事实来源；若与当前路由、样式或权限实现冲突，以代码为准并修正文档。

## 1. 与官网的一致性

- **复用现有 CSS 令牌**：官网 `src/styles/global.css` 与本仓库 `packages/api/src/ui/` 是检查入口。品牌底色 `--bg #0c0d12`、强调色 `--gold #fbbf24`；不要为文档另造紫蓝 AI 配色。
- **Satoshi 字体同源同文件**：/ui 从 `/ui/fonts/Satoshi-*.woff2` 自供，现有测试校验与网站字体一致。README 使用 GitHub 原生文本，不分发新的字体文件。
- **有意的控件差异**：/ui 的 `--line-control: rgba(255,255,255,.34)` 用于表单控件描边和对比度，不扩大为装饰色。

## 2. /ui 约束

- **CSP `font-src 'self'`**：不为视觉修改放行外源字体或样式。
- **favicon**：`/ui/favicon.svg` 同源提供；`/ui/favicon.ico` 的既有 204 行为不是待修视觉问题。
- **HTML 邮件不可信**：保留消毒、独立 sandbox frame 和严格 CSP；不依赖邮件自身 CSS、图片或链接来丰富演示图。
- **遵循现有资源流程**：检查 `packages/api/src/ui/` 与 `packages/api/scripts/copy-ui-to-dist.ts`，不为了视觉引入新的前端打包器。
- `UI_ENABLED=false` 时 UI 路由关闭，不表示 API/MCP 被关闭。
- **UI 不是只读界面**：身份管理、Seen、任务和其他获授权操作均可能写入状态。具体以路由和会话权限为准，不能把“标记已读”称为唯一写操作。

## 3. 页面与信息表达

| 页面 | 受众 | 约定 |
| --- | --- | --- |
| 登录 | 人 | 清晰解释令牌登录与 Trust this device；普通会话与持久化 trusted 会话不同，不能写“重启全部退出” |
| Overview | admin | 身份表、消息窗口与管理操作；`>=N` / `Unknown` 是合法结果，不做假精确 |
| Inbox / 邮件详情 | 获授权身份或 admin | 邮件、OTP/链接、Rendered/Plain/Source；明显区分来源与内容 |
| Tasks | 获授权参与者或 admin | 展示真实任务状态、结果与允许的操作，不暗示通知已被消费或动作已执行 |
| Notifications / 设备 / 客户端授权 / Configure | 依各路由权限 | 使用当前产品结构，不把规划中的页面或未实现能力画成实物 |

此表是设计指导，不是完整 endpoint/ACL 清单。最新功能由 `app.ts` 和 UI 路由决定。

## 4. 组件与气质

品牌仍是**深夜邮局**：近黑画布、克制的金色灯光、信封、邮戳、航线和回执。
金色用于引导和标记，不铺满背景；绿色/红色保持成功/失败语义，不用来装饰。

复用卡片、细描边、金色主按钮、ghost 次按钮和等宽信息标签。表格 hover 轻微提亮；
窄屏优先可读和可操作。空状态用一句说明和一个明确动作，不用虚构数据填满界面。

## 5. 文案

状态必须诚实：失败就说失败，加载显示 Loading，窗口计数不冒充总量。
按钮使用明确动词，例如 Refresh、Mark as read、Copy；审批决定不写成动作已执行。
运维细节见 [operator-guide.md](docs/operator-guide.md)，不再依赖 README 中的大段实现说明。

## 6. README 展示约定（#251）

- 定位为开放通信与任务交接，保留邮件/OTP 基础；不把完整编排、开放联邦或通用唤醒当成当前能力。
- 复用现有 Logo，保留可选择的文字、简短导航和少量实用徽章。npm 徽章明确是 MCP package 版本。
- 架构图使用 GitHub 可渲染的 Mermaid；当前组件与未来方向分开，标出本地状态和外部执行环境。
- 只使用真实产品截图或明确标为示意的协议图。旧邮件截图说明其用途，不冒充新任务演示。
- #251 已验素材落在 `docs/assets/251/`（`cover.png`、`demo-handoff.mp4`、`tasks-board.png`、`tasks-completed.png`）：原样入库、不重编码；README「See it work」用封面+相对链到 MP4（视频不进正文）；Tasks 截图挂在 Human visibility 能力组。
- 新的 Tasks 截图和演示必须真实捕获并匿名化；手动激活/adapter 前提不可在剪辑中隐藏；合成指针/字幕须标明为事后装饰。
- GitHub README 不承载官网脚本、外部字体或 inline CSS 动效；优先静态封面，不要求循环动画才能理解内容。
- 新视觉素材验收覆盖浅色、深色和手机阅读；未实际完成 GitHub/UI 验收不得勾选“已验证”。
- Logo 墙只表达有证据的接入方式，不制造厂商背书，也不把可连接等同于可自动唤醒。
- 英文与中文入口保持相同的产品边界；安全先决条件紧邻命令，长运维说明链接到专门指南。
