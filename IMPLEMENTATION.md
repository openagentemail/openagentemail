# Block 2 implementation report

工作区：`/Users/tizerluo/Kimi-workspace/.arena/wt2-codex`  
分支：`arena/b2-codex`  
实现依据：`.arena/briefs/DESIGN_FINAL.md`

## 结论

终版设计的只读 `/ui` 已全部落地。API 原有 104 项测试保持通过，新增覆盖后
API 共 169/169 通过；MCP 9/9 通过。API 与 MCP 均通过 TypeScript 检查和
build。未 push、未接触对手 worktree、未连接生产服务。

## 终版设计 → commit / 文件 → 验证

| 设计条目 | 落地 commit 与主要文件 | 验证 |
|---|---|---|
| §1 单一 `resolveToken`、`UI_ENABLED` | `327f600`；`src/lib/auth.ts`、`src/lib/config.ts` | `ui-foundation.test.ts`：admin/identity 共用解析；默认开关为 true |
| §1 4 KiB 登录体积、严格 JSON、Origin、失败限流、主体上限、容量 200 | `656d578`；`src/lib/ui-session.ts` | `ui-login-limit`、`ui-origin`：413、512 字符、拒绝多余字段/错误 Content-Type、IP 10/5min、全局 60/min、每 token 5、满表不驱逐 |
| §1 TLS 反代 Origin 正常工作且不信任转发头 | `11bd5b4`；`src/lib/ui-session.ts` | 新增红→绿用例：公网 `https:` Origin、同 Host、上游 `http:` 且 `Sec-Fetch-Site: same-origin` 可登录；恶意 Origin 与 cross-site 仍 403 |
| §1 HttpOnly 会话、生命周期、轮换即时失效、登出 | `656d578`；`src/lib/ui-session.ts` | `ui-session.test.ts`：32B sid、host-only、Strict、Path、Secure 条件、12h idle/24h absolute、重解析 token、删除与 logout 失效 |
| §1 两入口隔离、稳定 401、无令牌日志 | `656d578`、`0aeee57`；`src/routes/ui.ts` | `ui-authz` 钉死 Cookie→`/v1` 401、Bearer→`/ui` 401；`ui-nolog` 劫持 console 并检查响应/Set-Cookie/Location |
| §2 不安全上下文闸门、URL/存储无 token | `462ee4d`；`src/ui/assets.ts` | 静态纪律测试；真实 Chromium 在 `http://0.0.0.0` 验证输入与提交均 disabled；访问 `?token=must-disappear#fragment` 后 URL 仅剩 `/ui`，local/session storage 总数为 0 |
| §3 独立 `/ui/frame`、双沙箱、全错态 HTML | `37af8be`；`src/routes/ui-frame.ts` | `ui-frame.test.ts` 验证精确 CSP、nosniff、no-referrer、no-store、Vary、空 sandbox、401/403/404/413/500 品牌 HTML 与越权 403 |
| §4 精确锁版净化器、零属性白名单 | `37af8be`；`package.json`、`bun.lock`、`src/lib/sanitize-email-html.ts` | `sanitize-html` 精确 `2.17.6`、类型精确 `2.16.1`；20 组 script/style/textarea/noscript/iframe/svg/math/mXSS 等投毒语料、白名单快照与幂等全部通过 |
| §4 512 KiB 与异常 fail-closed | `37af8be`；`src/lib/sanitize-email-html.ts` | 超限在调用库前返回空；净化器抛错返回空；frame 只给安全说明页，绝不回退原 HTML |
| §5 全正文 http(s) 链接与 OTP | `0aeee57`；`src/lib/otp.ts`、`src/lib/imap.ts` | `new URL` 后仅 http/https；普通正文链接独立于 OTP intent；HTML-only OTP 进入 `hasOtp`；详情保留 codes/OTP links/body links |
| §6 UI API 与显式投影 | `0aeee57`；`src/routes/ui.ts` | `/me`、`/identities`、`/messages`、detail；身份隔离、admin 全部、limit 1–200、畸形 UID、排序；identity 只投影 address/name/createdAt，详情 JSON 无 `html` |
| §6 内嵌资产、路由、禁用开关 | `462ee4d`；`src/app.ts`、`src/routes/ui-assets.ts`、`src/ui/assets.ts` | `/ui` 与 `/ui/` 同 shell、绝对资源路径、严格外层 CSP、正确 Content-Type、未知路径 404；`UI_ENABLED=false` 时整个 `/ui/*` 404 |
| §6 响应缓存纪律 | `0aeee57`、`37af8be` | 全部 `/ui/api/*` 与 frame 均为 `Cache-Control: no-store`、`Vary: Authorization, Cookie` |
| §6 前端交互与响应式布局 | `462ee4d`；`src/ui/assets.ts` | 桌面 240/360/自适应三栏；移动列表/详情两级与 Back；手动 Refresh 互斥，切身份 AbortController；无轮询/wait；ARIA live、focus ring、键盘原生控件 |
| §6 DOM/XSS 前端纪律 | `462ee4d`；`ui-assets.test.ts` | 禁止 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`document.write`、`eval`、`new Function`；动态文本只用 `textContent`；链接写 href 前再次 `new URL` 验证 |
| 首屏正确性补修 | `dca806a`；`src/ui/assets.ts` | 截图发现“首次访问误报 session expired”，先加失败断言再修复；真实过期请求仍显示过期提示 |
| §6/§8 自部署文档与 dev-only 预览 | `1d4457b`；`README.md`、`.env.example`、`compose.yaml`、`packages/api/dev/preview.ts`、`.dockerignore` | 文档覆盖开关、TLS/SSH、重启丢会话、精确锁版运维尾巴；`dev/` 已排除 Docker 镜像 |

## 红 → 绿记录

1. `ui-foundation`: 初跑因 `uiEnabled`/`resolveToken` 不存在而红；`327f600` 后绿。
2. `ui-session`、`ui-origin`、`ui-login-limit`、`ui-nolog`: 初跑因
   `ui-session.ts` 不存在，4 文件全红；`656d578` 后 15 项绿。
3. `ui-authz`、`ui-messages` 与 HTML-only OTP：初跑因 UI route 不存在且
   `hasOtp` 为 undefined 而红；`0aeee57` 后绿。
4. `ui-render`、`ui-frame`: 初跑因净化器/frame 模块不存在而红；
   `37af8be` 后投毒、幂等、体积、错态和响应头全部绿。
5. `ui-assets` 与 `hasHtml`: 初跑因 app/assets 不存在且 `hasHtml`
   为 undefined 而红；`462ee4d` 后绿。
6. 首次登录状态：浏览器截图发现误报；新增断言先红，`dca806a` 后绿。
7. TLS 终止反代：合法同 Host `https → http` 复现先得 403；
   `11bd5b4` 后得 200 + Secure Cookie，全部恶意 Origin 负例保持绿。

每个逻辑单元均独立 commit，没有 amend、push 或 force 操作。

## Chromium 五状态验收

真实 Chrome headless 分别以 1440×1000 桌面和移动设备模式走完整登录与读信
流程，截图保存在 `output/playwright/b2-ui/`：

- `desktop|mobile-01-login.png`
- `desktop|mobile-02-empty.png`
- `desktop|mobile-03-list.png`
- `desktop|mobile-04-plain-detail.png`
- `desktop|mobile-05-html-isolated.png`

恶意 HTML fixture 同时包含 script、父页面写标记、外域 img、form、
autofocus/onfocus、SVG/onload 与 javascript 链接。浏览器实测：

- 父页面 `data-pwned` 仍为 null；
- iframe `sandbox` 属性为空字符串，无任何 allow 权限；
- 父页面读取 `iframe.contentDocument` 得 false（opaque origin）；
- 网络清单只有 `/ui`、本地资产、session/UI API 与 `/ui/frame` 共 11 个
  本机请求，`evil.example` 为 0；
- 无弹窗、无导航；frame 只剩允许的标题、段落、strong、blockquote。

## 最终门禁

```text
packages/api
  npx -y bun@1.2.21 test          169 pass / 0 fail（原有 104 全保留）
  npx -y bun@1.2.21 run typecheck PASS
  npx -y bun@1.2.21 run build     PASS（dist/main.js 4.24 MB）

packages/mcp
  npx -y bun@1.2.21 install       PASS（仅安装声明中已有依赖）
  npx -y bun@1.2.21 test          9 pass / 0 fail
  npx -y bun@1.2.21 x tsc --noEmit PASS
  npx -y bun@1.2.21 run build     PASS（dist/main.js 0.67 MB）
```

已知且按终版设计接受的取舍：会话仅在进程内，重启即登出；首版只读、无轮询；
邮件图片、邮件 CSS 与邮件内链接均不进入 frame；`sanitize-html` 必须以单独
安全变更升级并重跑投毒语料。

DONE
