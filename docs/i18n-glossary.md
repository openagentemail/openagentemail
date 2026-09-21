# i18n 术语表与不译清单（i18n glossary）

- 用途：openagentemail i18n（#137，目标语种 es/ja/ko/zh，英语=源不译）三仓共用唯一术语锚——主仓控制台 / website 营销+docs / hosted-ops billing 的翻译与复审均以本文件为准。
- 种子来源：#137 R0 v2 附录 B（2026-09-20，FC-Kimi 起草/总指挥批准）；锚源=`README.zh-CN.md` 既有措辞。
- 更新程序：随任一 i18n 施工 PR 演进——提案=该 PR 内改本文件；复审 agent 与机翻 prompt 必须携带最新版；本文件冲突时以「zh-CN 锚语义」为最终裁定基准。

## 1. 不译清单（硬规则，所有语种保留原文）

| 类别 | 条目 |
|---|---|
| 产品名 | openagent.email / OpenAgent Email / MCP / ntfy / Creem / Hosted Pro |
| 凭据面术语 | admin key / API token（行文可作首现式注记，如「管理密钥 (admin key)」） |
| 协议/技术词 | catch-all / OTP / URL / API 字段名 / CLI 命令 / 错误码字面（如 `invalid_cursor`） |
| 结构性内容 | 代码**语法与标识符**（命令、字段、路径、Mermaid/PlantUML 语法行）——**块内自然语言可译**（参与者标签/消息文案/注释/示例叙述），锚实践=README.zh-CN:30-40 同款 Mermaid 全译形态 |

## 2. 术语表（zh-CN 锚；es/ja/ko 译名待落串时补充列）

| EN（源） | zh-CN（锚） | 备注 |
|---|---|---|
| identity | 身份邮箱地址 | |
| task ticket | 任务工单 | |
| push tier | 推送档位 | |
| connected apps | 已连接应用 | |
| claim page | 凭据领取页 | hosted-ops 钱路页 |
| hosted instance | 托管实例 | |
| session cookie | 会话 Cookie | Cookie 不译 |
| Domains | 域名管理 | 控制台导航项 |
| instance address prefix | 实例地址前缀 | billing 表单字段 |

## 3. 落串纪律（B2 起）

1. 字典值一律**字面字符**，禁 `\uXXXX` 转义值（浏览器端 `t()` 不解码转义，与服务端槽填充不对称——#292 备忘）。
2. ja/ko 统一敬体/正式体；es 正式体。
3. 法律页（privacy/terms/refund）译文必带「以英文版为准」声明；管辖句不意译。
4. 术语缺项时：先在本文件补锚再落串（不允许字典先于锚）。

## 4. 演进记录

- v0（2026-09-21）：建档，种子=R0 v2 附录 B。
- v0.1（同日）：Codex P1 采纳——「代码块整体不译」收窄为「语法与标识符不译、块内自然语言可译」（锚实践=README.zh-CN:30-40 Mermaid 全译）。
