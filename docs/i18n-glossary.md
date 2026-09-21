# i18n 术语表与不译清单（i18n glossary）

- 用途：openagentemail i18n（#137，目标语种 es/ja/ko/zh，英语=源不译）三仓共用唯一术语锚——主仓控制台 / website 营销+docs / hosted-ops billing 的翻译与复审均以本文件为准。
- 种子来源：#137 R0 v2 附录 B（2026-09-20，FC-Kimi 起草/总指挥批准）；锚源=`README.zh-CN.md` 既有措辞。
- 更新程序：**术语变更一律走主仓 companion PR**——website/hosted-ops 的 i18n PR 若涉新术语/改锚，必须在同一合并窗内附一个主仓 PR 改本文件（合并顺序=本文件先合或同窗），未附 companion 的外仓术语 PR 复审应打回；复审 agent 与机翻 prompt 必须携带最新版；冲突时以「zh-CN 锚语义」为最终裁定基准。

## 1. 不译清单（硬规则，所有语种保留原文）

| 类别 | 条目 |
|---|---|
| 产品名 | **OpenAgentEmail**（仓内规范拼写，README/md 均此形）/ OpenAgent Email（别名，护译用）/ openagent.email（域名）/ MCP / ntfy / Creem / Hosted Pro |
| 凭据面术语 | admin key / API token（行文可作首现式注记，如「管理密钥 (admin key)」） |
| 协议/技术词 | catch-all / OTP / URL / API 字段名 / CLI 命令 / 错误码字面（如 `invalid_cursor`） |
| 结构性内容 | 代码**语法与标识符**（命令、字段、路径、Mermaid/PlantUML 语法行）——**块内自然语言可译**（参与者标签/消息文案/注释/示例叙述），锚实践=README.zh-CN `## 看它工作` 小节内 Mermaid 时序图（自然语言全译形态；引真实小节名防漂移） |

## 2. 术语表（zh-CN 锚；es/ja/ko 随 #137 B2 落串补齐）

| EN（源） | zh-CN（锚） | es | ja | ko | 备注 |
|---|---|---|---|---|---|
| identity（通用实体） | 身份 | identidad | アイデンティティ | 아이덴티티 | 用于 Create/Delete Identity、full identity permissions 等实体语义（README.zh-CN「Agent 身份」用法） |
| identity address | 身份地址 | dirección de identidad | アイデンティティアドレス | 아이덴티티 주소 | 地址语义专用；勿用于实体语境 |
| task ticket | 任务工单 | ticket de tarea | タスクチケット | 작업 티켓 | |
| push tier | 推送档位 | nivel de push | プッシュ階層 | 푸시 등급 | |
| connected apps | 已连接应用 | aplicaciones conectadas | 接続済みアプリ | 연결된 앱 | |
| claim page | 凭据领取页 | página de reclamación | クレームページ | 클레임 페이지 | hosted-ops 钱路页 |
| hosted instance | 托管实例 | instancia alojada | ホスト済みインスタンス | 호스팅 인스턴스 | |
| session cookie | 会话 Cookie | cookie de sesión | セッション Cookie | 세션 Cookie | Cookie 不译 |
| Domains | 域名管理 | Dominios | ドメイン管理 | 도메인 관리 | 控制台导航项 |
| instance address prefix | 实例地址前缀 | prefijo de dirección de instancia | インスタンスアドレス接頭辞 | 인스턴스 주소 접두사 | billing 表单字段 |

## 3. 落串纪律（B2 起）

1. 字典值一律**字面字符**，禁 `\uXXXX` 转义值（浏览器端 `t()` 不解码转义，与服务端槽填充不对称——#292 备忘）。
2. ja/ko 统一敬体/正式体；es 正式体。
3. 法律页（privacy/terms/refund）译文必带「以英文版为准」声明；管辖句不意译。
4. 术语缺项时：先在本文件补锚再落串（不允许字典先于锚）。

## 4. 演进记录

- v0（2026-09-21）：建档，种子=R0 v2 附录 B。
- v0.1（同日）：Codex P1 采纳——「代码块整体不译」收窄为「语法与标识符不译、块内自然语言可译」（锚实践=README.zh-CN Mermaid 全译）。
- v0.2（同日）：CR 2 Minor 采纳——稳定锚；identity 措辞对齐。
- v0.3（同日）：Codex P1×3+P2 采纳——跨仓更新=主仓 companion PR 强制+合并顺序；规范拼写 OpenAgentEmail 入列；identity（实体）/identity address（地址）拆行；锚改真实小节名「看一次任务交接」。
- v0.4（2026-09-21）：#137 B2 控制台落串——补齐 es/ja/ko 术语列；保真扫描键见 `packages/api/src/ui/client/i18n-preserved.ts`。
- v0.5（2026-09-21 / #251）：README.zh-CN 小节更名为「看它工作」；本表锚点同步，避免术语实践引用漂。
