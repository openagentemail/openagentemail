# RECEIPT — #26 阶段2 · PR 6

日期：2026-08-13  
工位：`/home/ops/orca/workspaces/openagentemail/worker-34-pr1`  
分支：`tizerluo/worker-34-pr6`（禁动 main；基线 `608cbb2`）  
PR：https://github.com/openagentemail/openagentemail/pull/30

## 交付

设备管理完整闭环：registry 落盘、create 补 displayName、list/revoke 的 UI + Bearer API、Push & Devices 面板（列表 / 添加引导 / 一次性 QR）、吊销 `pending_revoke` 对账。Trust-30d / cookie `Path=/ui` / Origin / 全局 body-limit 未改。现有 tier 三卡逻辑未改。

**平台运营主体口径（未发明新 Auth kind）：** 现网 `Auth` 只有 `admin | identity`。设备 API 仅 `kind === 'admin'`；其余一律 403。identity 已有测试。不能把非 admin 解释为 admin。

## 范围 8 条对账（ADR §PR 6）

| # | 范围 | 结果 | 证据 |
|---|---|---|---|
| 1 | registry：DATA_DIR 0600；serial queue；同目录 rename；崩溃/磁盘满/只读/corrupt 启动+运行测试与健康告警 | **过** | `packages/api/src/lib/notification-devices.ts`；测试见下表 |
| 2 | create 补 displayName，现有 ntfy user 创建路径接入 registry | **过** | `createNotificationDevice({ displayName? })` → `registerPairedDevice` |
| 3 | list/revoke UI + Bearer；admin 限定；identity 与非 admin 403 | **过** | `/v1/notify/devices` + `/ui/api/notify/devices` |
| 4 | Push 面板：列表（名称/频道语义/配对时间）+ 添加引导 + 一次性 QR；tier 三卡不动 | **过** | `push-devices.ts`；`handleConfigurePushTier` 切片测试仍绿 |
| 5 | 吊销一致性：pending_revoke；启动对账；404/not_found → revoked；步骤 1 失败不碰 ntfy；步骤 3 失败重试收敛；重复 DELETE 204 | **过** | 见吊销测试名 |
| 6 | 登记失败 best-effort 删 ntfy user | **过** | `registry persist failure after ntfy create deletes the ghost user and returns 502` |
| 7 | password/token 只展示一次；磁盘零明文；文件 0600 | **过** | token-style modal + grep 测试 |
| 8 | 旧 POST `{ publicUrl }` 零破坏 | **过** | `old POST without displayName still 201 and identity cannot list or revoke` |

## 验收对账

| 项 | 结果 | 证据 |
|---|---|---|
| 创建凭据只展示一次，DATA_DIR grep 无 password/token | **过** | UI：`Copy this password now. It will not be shown again.`（`UI_HTML`）；关窗 `devicePairPassword.textContent = ''`。磁盘：`successful create never writes password to DATA_DIR` 对 `process.env.DATA_DIR` walk，断言不含明文 password 且无 `"password":`；registry `register writes 0600 JSON with no password or token keys`（`stat.mode & 0777 === 0600`） |
| 列表有名称/频道语义/配对时间 | **过** | `topicLabels.userAlerts === 'User alerts'` / `userLow === 'User low'`；UI `topicSemantics` + `Paired ` + `formatDate(pairedAt)`；Bearer `Curl-phone` + `pairedAt` |
| 吊销后 ntfy user 立即失效（curl / 测试环境） | **过** | 工位无真实 ntfy。测试环境：`identity cannot GET or DELETE devices; admin revoke is 204 including repeats and ntfy 40031` — admin DELETE 触发 `DELETE …/v1/users`，现网缺失 user 形态 HTTP 400/`code:40031` 当成功，本地 `revoked`；重复 DELETE 不再打 ntfy（`deletes.length === 1`）、仍 204 |
| pending_revoke 对账：not_found 收敛 revoked；磁盘满/只读/404 幂等齐 | **过** | 见下「吊销测试名」 |
| 登记失败无幽灵 user | **过** | `registry persist failure after ntfy create deletes the ghost user and returns 502`：ENOSPC hook 后断言存在 `DELETE /v1/users` |
| identity / 平台运营主体 → 403 | **过** | Bearer：`old POST… identity cannot list or revoke` + `identity cannot GET or DELETE devices…`；UI：`identity session cannot list, create, or revoke devices`。平台运营主体：现网无独立 operator kind，非 admin 即 403（见上口径） |
| 旧 POST 兼容 | **过** | `old POST without displayName still 201…`；registry `old clients without displayName get the default Phone name` |
| `cd packages/api && bun test` + `bun run build` | **过** | R3 后 **793 pass / 0 fail**；`bun run build` Bundled 568 modules，全绿 |

### 吊销测试名（notification-devices.test.ts）

- `step 1 persist failure never calls ntfy delete`（ENOSPC）
- `readonly volume on pending persist does not reach ntfy`（EROFS）
- `ntfy 404 / not_found is idempotent success and converges to revoked`
- `repeat DELETE on already revoked is already_revoked and does not call ntfy`
- `step 3 persist failure leaves pending_revoke; retry/startup not_found converges`
- `transient ntfy failure keeps pending_revoke for retry`
- `startup inspect + reconcile scans pending_revoke`
- `corrupt file fail-closes instead of wiping the registry`
- `crash tmp next to an intact store is discarded on inspect`

## 风险缓解对账

### 设备吊销一致性

落实 ADR 五步：① 先写 `pending_revoke`，落盘失败不调 ntfy；② 现网 ntfy 缺失 user = HTTP 400 / code 40031 / "user does not exist"（HTTP 404 仅当 body 含这两项之一，裸 `not_found` / `route_not_found` 不算）= 成功，网络/5xx = `transient`（`classifyNtfyUserDeleteResponse` 不得把泛 400 或网络错误当 not_found）；③ 再写 `revoked`；④ 启动 `inspectDeviceRegistry` + `initializeNotifications` → `reconcilePendingRevokes`；列表/吊销入口先 reconcile（revoke 跳过本目标）；⑤ 列表默认隐藏 `revoked`，`pending_revoke` 对 admin 显示「Revoking…」。

### DATA_DIR 单写者

所有 device mutation 走同一 `enqueue` 队列；temp 与目标同目录；未引入第二写者。日志/console 告警不含 password。`GET /healthz` 仍不读该文件。

## 实现备注（非分叉，不拦合并）

- QR：服务端 `encodeQrModules(JSON.stringify(qrPayload))`（ECC M，零新依赖）；UI `canvas` 画模块（禁止 `innerHTML` / `createElementNS` / 外链图）。copy 字段始终可用。若 ntfy 官方扫码 JSON 键名与本 payload 不完全一致，用户仍可手输 server/user/password。
- 未改 `.env`。未提交 `.mimosa/`。

## 独立自审

- **禁止自审自。** 第一轮 agent id：`31cf837a-1968-4df0-a08a-37ae937c0a18`
  - 结论当时：**not mergeable**（P0 0 / P1 1）
  - 过程：对照 ADR 吊销五步与现网 ntfy `handleUsersDelete`；发现只认 HTTP 404 会把 40031 当 transient，步骤 3 落盘失败后对账无法收敛。
- **P1 已修后再审。** 第二轮（新 subagent，禁止自审自）agent id：`f4f57ed2-fb04-4537-8791-e4d1e37c74ca`
  - 结论：**mergeable**
  - P0/P1：**0**
  - 过程：独立核对 `classifyNtfyUserDeleteResponse` 对 40031 / 404 / 200 / 503 / 40024；步骤 1 失败不碰 ntfy；步骤 3 失败 + not_found 收敛；已 revoked 不打 ntfy；启动 inspect+reconcile；幽灵 user DELETE；identity 403；旧 POST；一次性密码关窗清空；modal 代际。相关测试当时 121 pass。
  - 残余（不当作 finding）：5xx 响应体若碰巧含 `user does not exist` 会被当成成功（真实 ntfy 不太会）；幽灵 user 清理是 best-effort；40031 收敛由分类器测试 + registry 收敛测试拼接。
  - **R1 注：** 上条「5xx body 当 not_found」残余被 Codex Local 升为 P1，已在本回执 R1 节关闭。

---

## 返工 R1（2026-08-13 · Codex Local P1×2）

分支仍是 `tizerluo/worker-34-pr6`。就地修、就地 push。未新开分支、未动 `main`、未自 merge。

### 评论对账

| # | 来源 | 问题 | 处置 | 证据 / 测试名 |
|---|---|---|---|---|
| A | Codex Local P1 · `qr-byte.ts` 原交织循环（置信 0.99） | 不等长 RS block（含配对 payload 附近 version 9）把 data+ECC 拼块后再按列轮转，短块 ECC 插进长块未吐完的 data，违反 ISO/IEC 18004 8.6，扫码器无法可靠解码。旧测只看形状/确定性。 | **已修。** `addEccAndInterleave`：data 按列跨 block 轮转（短块缺席跳过），全部 data 吐完后再按列吐 ECC。 | `version 9 ECC-M has unequal-length data blocks matching ISO tables`；`unequal-block interleave emits all data columns before any ECC (catches concat-then-column)`；`ISO de-interleave plus RS remainder recovers pairing payload (version near 9)` |
| B | Codex Local P1 · `classifyNtfyUserDeleteResponse`（置信 0.96）；正是第二轮自审列为「残余不当作 finding」的那条 | 含 `"user does not exist"` / `"not_found"` 的 **5xx** 被当成 `not_found` → 本地收敛 `revoked`，远端 user 可能仍在。违反「所有 5xx 皆 transient」。 | **已修。** `status>=500` 在看 body 之前 return `transient`；not_found 文本/错误码仅对 HTTP 404 与 HTTP 400+`40031`/`"user does not exist"`；泛 400 与网络错误仍 transient。 | `5xx body containing user-does-not-exist stays transient; 40031/404 still not_found`；`5xx with user-does-not-exist body does not converge pending_revoke to revoked`；原 `live ntfy missing user is HTTP 400 / code 40031, not 404` 仍绿 |

### 测试为什么能抓住 QR 交织错误

形状/确定性测（size、finder、同一输入同一 modules）在 concat-then-column 下仍然全绿，所以旧测抓不到。R1 三层闸：

1. **结构表：** version 9-M 钉死 5 blocks / ECC 22 / raw 292 / data 182 / 3×36+2×37。块数或短长切分错会红。
2. **规范序列 + 负例：** 生产 data 前缀必须等于独立写出的 ISO 列序；`buggyConcatThenColumn`（旧错误算法）必须与生产**不等**；并钉死旧算法在 `index = shortDataLen × numBlocks`（v9=180）吐出短块 `ecc[0]`，生产该位仍是长块 data。这正是 Codex 描述的那一列错位。
3. **可解证明：** 对配对 JSON 做独立 ISO de-interleave（先 data 列再 ECC 列，不调用生产交织），每 block 的 RS remainder 必须匹配，再按 byte-mode 还原原文。若仍 concat-then-column，de-interleave 会把 ECC 字节读进 data 块，remainder 对不上。

`expectedDataInterleave` 与生产 data 段同构，单独不够；负例 + 独立 de-interleave/RS 补上这个洞。配对 fixture 实际落到 v10-M（仍不等长）；v9 由第 1–2 层单独覆盖。

### 独立自审（R1 · 新 agent，禁止自审自）

| 项 | 值 |
|---|---|
| Subagent ID | `79098d1b-5391-415d-b686-7e19973a7209` |
| 审查对象 | 未提交工作区相对 `d12e937`/`f0794a4` 的 R1 diff |
| 结论 | **mergeable** |
| P0 / P1 / P2 | **0 / 0 / 0** |
| A 裁定 | **过** — 两阶段交织；v9 表自算与 ISO 9-M 一致；短块缺席只在 data 最后一列；负例能抓住 concat-then-column |
| B 裁定 | **过** — 5xx 在看 body 之前 transient；400 只认 40031 / "user does not exist"；503+该正文不收敛 revoked |
| 过程 | 独立读 `qr-byte.ts` / `notify.ts` / 两份测试 / `notification-devices.ts`；自推 v9 列序与分类表；不采信实现者结论。残余不升 P1：配对 fixture 是 v10 不是 v9（v9 另有表+负例）；网络 catch 本轮无新单测但代码未改仍 return transient。 |

### 完成标准

- `cd packages/api && bun test` → **782 pass / 0 fail**
- `bun run build` → Bundled 568 modules，全绿
- 未新开分支；未动 `main`；push 后停等指挥终审，禁止自 merge。

---

## 返工 R2（2026-08-13 · Codex P1 + ZCode P2×2）

分支仍是 `tizerluo/worker-34-pr6`。就地修、就地 push。未新开分支、未动 `main`、未自 merge。

### 评论对账

| # | 来源 | 问题 | 处置 | 证据 / 测试名 |
|---|---|---|---|---|
| A | Codex Local P1 · `notification-devices.ts` persist 闸（置信 0.98） | secret-key guard 用正则扫序列化 JSON；displayName 含 `"password":` / `"token":` 会被误拒并删刚建的 ntfy user。 | **已修。** `registryHasForbiddenSecretKey` 递归看对象键（password/token，大小写不敏感）；persist 与 parse 都走键检查，不再扫 `JSON.stringify` 文本。字符串值里的同名文本不拦。 | `displayName may contain password/token text without writing those keys`；`create succeeds when displayName contains password/token key-like text`（且无幽灵 DELETE）；`payload with password or token keys is still refused`；`register writes 0600 JSON with no password or token keys`；`successful create never writes password to DATA_DIR` |
| B① | ZCode P2 · 列表/吊销每次全量 reconcile | 每次 list/revoke 入口对全部 `pending_revoke` 打 ntfy，轮询放大。 | **低成本改进 + 记债。** `reconcileNotificationDevices` 合并并发 in-flight（同一 tick 的两次 list 只跑一轮）。**不做跨请求 TTL**：列表必须收敛刚写入的 pending_revoke；pending 是稀有态，ADR 要求入口对账。顺序请求仍全量 reconcile 是收敛语义，不是漏修。 | `concurrent listNotificationDevices share one in-flight reconcile`（两次并发 list → 1 次 ntfy DELETE） |
| B② | ZCode P2 · 幽灵 user 清理 best-effort | 清理失败无重试/无告警。 | **低成本改进 + 记债。** `deleteNtfyUser` 在 transient/网络错误时 `console.warn`（只打 username + status/error，不打 body/password）。**不建重试队列**：凭据从未落盘，无法对账；下次创建用新 username，残留幽灵对不上新设备。登记失败仍返回 `device_registry_unavailable`。 | `ghost user cleanup warns when delete fails and still returns 502` |

### 独立自审（R2 · 新 agent，禁止自审自）

| 项 | 值 |
|---|---|
| Subagent ID | `09117a6e-8372-4f94-9327-8c62aa89d6f6` |
| 审查对象 | 未提交工作区相对 `2c1238b` 的 R2 diff |
| 结论 | **mergeable** |
| P0 / P1 / P2 | **0 / 0 / 0** |
| A 裁定 | **过** — persist/parse 均为键检查；displayName 含 key-like 文本可创建；真 secret 键（含嵌套/大小写）仍拒；0600/零明文仍绿。注：Codex「stringify 转义后仍命中正则」用本正则实测为 false（值里的引号变成 `\"password\":`）；结构化检查仍按任务落地，不把转义当安全属性。 |
| B 裁定 | **过** — in-flight 无 TTL，刚写入的 pending 不会被跳过；warn 不泄露 password；无假装重试队列。 |
| 过程 | 独立读 `notification-devices.ts` / `notify.ts` / 两份测试 / README；自推键检查与 coalesce；跑相关 55 pass。 |

### 完成标准

- `cd packages/api && bun test` → **787 pass / 0 fail**
- `bun run build` → Bundled 568 modules，全绿
- 未新开分支；未动 `main`；push 后停等指挥终审，禁止自 merge。

---

## 返工 R3（2026-08-13 · Codex P1×2 + ZCode P2）

分支仍是 `tizerluo/worker-34-pr6`。就地修、就地 push。未新开分支、未动 `main`、未自 merge。

### 评论对账

| # | 来源 | 问题 | 处置 | 证据 / 测试名 |
|---|---|---|---|---|
| A | Codex Local P1 · `qr-byte.ts` alignment（置信 0.99） | v7+ 坐标含 6，只跳三个 finder 角会在 timing 上画 5×5，随后 timing 切中心行/列，功能模块损坏。 | **已修。** finder+timing 先占位；alignment 仅中心空闲才绘制；timing 上省略的 alignment `reserveAlignment` 占位以免数据走进 ISO 扣格。finder 三角只 skip 不 reserve（初版对三角也 reserve，独立自审 P1，已收）。 | `version 7+ omits alignment on timing tracks and keeps timing intact`（含 finder 旁 `isFunc===false`）；R1 `ISO de-interleave plus RS remainder recovers pairing payload` 仍绿 |
| B | Codex Local P1 · rename 后未 fsync 目录（置信 0.93） | 断电后目录项可能未持久化，已返回成功的创建/吊销可能丢。 | **已修。** rename 后 `open(DATA_DIR)` + `fsync`。EINVAL/ENOTSUP/ENOSYS 视为成功（注释写明，避免 NFS/FUSE 整站无法落盘）。EIO 等真失败：首次创建撤回刚 rename 的文件；覆盖写不删 registry。 | `directory fsync failure on create rolls back and leaves no half state` |
| C | ZCode P2-1 | 裸 HTTP 404 无条件 not_found → 网关 404 假吊销。 | **R3 方向对；R7 收口。** R3 仍留裸 `not_found` 子串，`{"error":"route_not_found"}` 会误收敛。R7 404 只认 40031 / "user does not exist"。 | R7：`gateway 404 route_not_found body stays transient and does not converge` |
| D | ZCode P2-3 | ntfy disabled/unconfigured 时 DELETE 仍落盘+外呼。 | **R3 混为一谈；R8 拆开。** 有 `ntfyUsername` 时拒绝 503（凭据可能仍活）；已 revoked 仍幂等 204 不外呼。 | R8：`revoke with ntfy disabled does not mark a remote username revoked`；`already revoked stays idempotent when ntfy is fully unconfigured` |
| E2 | ZCode P2-2 | fetch 无超时致 registry 队列独占。 | **已修。** 管理面 ntfy fetch `AbortSignal.timeout(8s)`。publish/json 长轮询仍走 watcher 既有 abort（记债：不把 8s 套到消息流）。 | 实现：`ntfyFetch` |
| E4 | ZCode P2-4 | corrupt registry 启动炸全进程。 | **已修。** `inspectDeviceRegistryAtBoot` 吞 corrupt（已 fail-closed+告警），邮件 API 仍监听。 | `corrupt registry at boot fail-closes devices but does not throw` |
| E5 | ZCode P2-5 | UI invalid JSON 静默当 `{}` 创建。 | **已修。** 与 Bearer 一样 400 `invalid_json`。UI 客户端本就 POST `{}` 合法 JSON。 | `invalid JSON on UI device create is 400 not a silent Phone` |
| E6 | ZCode P2-6 | Bearer GET 缺 Cache-Control。 | **已修。** GET `/v1/notify/devices` 与 UI GET 均 `no-store`。 | Bearer 列表测试断言 `cache-control: no-store` |

### 独立自审（R3 · 新 agent，禁止自审自）

| 项 | 值 |
|---|---|
| 初审 Subagent | `63b8c0dd-5093-4a41-a4e4-3ced2869ddd2` |
| 初审结论 | **not mergeable**（P1：finder 角 `reserveAlignment` 多占数据格） |
| 复审 Subagent | `bb8406c4-2c9f-4690-9abf-df1d626fb382` |
| 复审结论 | **mergeable** |
| P0 / P1 / P2 | **0 / 0 / 0** |
| A 裁定 | **过** — timing 先于 alignment；timing 省略仍占位；finder 三角不 reserve；测试钉 `isFunc[size-9][7]` |
| B 裁定 | **过** — 目录 fsync；首次创建 EIO 撤回；覆盖写不删盘 |
| 过程 | 初审自推 `isFunc` vs ISO 容量发现 finder 过占位；修复后再起新 agent 核关闭。 |

### 完成标准

- `cd packages/api && bun test` → **793 pass / 0 fail**
- `bun run build` → Bundled 568 modules，全绿
- 未新开分支；未动 `main`；push 后停等指挥终审，禁止自 merge。

---

## 返工 R4（2026-08-13 · Codex Local P1 · alignment 覆盖 timing）

分支仍是 `tizerluo/worker-34-pr6`。就地修、就地 push。未新开分支、未动 `main`、未自 merge。

R3 把 Codex R2「本应省略」理解反了：R2 的错是 **alignment 先画、timing 后画切坏 bullseye**；正解是 **alignment 后画覆盖 timing**，不是省略 timing 上的 alignment。本轮纠正。

### 评论对账

| # | 来源 | 问题 | 处置 | 证据 / 测试名 |
|---|---|---|---|---|
| A | Codex Local P1 · `qr-byte.ts` `placeFunctionPatterns`（置信 0.99，指挥亲验 R3 head `12cbf5a` 属实） | R3：`if (!isFunc[y][x]) addAlignment else if (!finderCorner) reserveAlignment`。中心落在 timing 上的组合（isFunc 已被 timing 先占）只 reserve 5×5、不画 bullseye。ISO 相反：如配对 v10 的 `(6,28)/(28,6)` **必须绘制**，alignment 覆盖 timing；扫描器预期完整同心圆。只有三个 finder 重叠角 `(6,6)/(6,size-7)/(size-7,6)` 省略（不画也不 reserve）。 | **已修。** 坐标组合循环：finder 三角 `continue`；其余一律 `addAlignment`（绘制 + `isFunc` 占位一体，覆盖 timing）。删除 `reserveAlignment`。isFunc 集合与 R3 相同（timing 段仍是功能模块；alignment 覆盖处仍是功能模块）。数据放置/掩码流不变。 | `alignment bullseye overwrites timing except the three finder corners`（v2 坐标 `[6,18]`；v7/v10/v14 功能格；配对 JSON 全编码 mask 不碰功能模块）。回归：`ISO de-interleave plus RS remainder recovers pairing payload (version near 9)` |

**v2 `(6,18)` 说明（按 ISO，不是按 R3 错误测试名）：** v2 size=25，`size-7=18`，故 `(6,18)/(18,6)` **就是 finder 三角**，省略不画。timing 轨道（列/行 8…16）上没有 alignment。用户举例里的 timing 上必须画 bullseye 的点是 v7 `(6,22)/(22,6)` 与 v10 `(6,28)/(28,6)`——独立自审对照 Annex E/G 与 Nayuki 后确认。

### 独立自审（R4 · 新 agent，禁止自审自）

| 项 | 值 |
|---|---|
| Subagent ID | `9d3aafec-7c86-4190-a1cb-f8735220f48e` |
| 审查对象 | 未提交工作区相对 `12cbf5a` 的 R4 diff（`qr-byte.ts` / `qr-byte.test.ts` / README） |
| 结论 | **mergeable** |
| P0 / P1 / P2 | **0 / 0 / 0** |
| ISO 独立求证 | 对照 ISO/IEC 18004:2015 §6.3.6、Annex E Table E.1、Annex G；Thonky Table E.1；Nayuki `draw_function_patterns`。v2 `(6,18)` = finder omit；v7 `(6,22)` / v10 `(6,28)/(28,6)` **必须画** 并覆盖 timing。Annex G v7 Segment C = 6×25=150（9 对减 3 finder）；若省略 timing 上两点会变成 100，与标准矛盾。 |
| A 裁定 | **过** — finder 三角 continue；其余 `addAlignment`；`reserveAlignment` 已删；R3 `if (!isFunc)` 省略与 Annex E/G 相反。 |
| 测试闸 | `isAlignAt` 要求完整 5×5（中心 dark + 外框 dark + 内白环）。只 reserve 不画、或 timing 十字切坏中心，v7/v10 断言失败。finder 角仍 `false`。`(size-9,7)` / `(7,size-9)` 仍 `isFunc===false`。 |
| R1 回归 | `ISO de-interleave plus RS remainder recovers pairing payload` 未改、未削弱。 |
| 过程 | 先独立求证 ISO/Nayuki/Thonky，再裁 diff；未改文件、未委托。 |

### 完成标准

- `cd packages/api && bun test` → **793 pass / 0 fail**（F50 watcher 时限测曾在全量跑里抖到 ~1.2s，隔离重跑 615ms 通过；再跑全量 793 全绿，非本 diff 回归）
- `bun run build` → Bundled 568 modules，全绿
- 未新开分支；未动 `main`；push 后停等指挥终审，禁止自 merge。

---

## 返工 R5（2026-08-13 · Codex Local P1×2 + 云端 P2×2）

分支仍是 `tizerluo/worker-34-pr6`。就地修、就地 push。未新开分支、未动 `main`、未自 merge。

### 评论对账

| # | 来源 | 问题 | 处置 | 证据 / 测试名 |
|---|---|---|---|---|
| A | Codex Local P1 · `main.ts:37`（置信 0.99） | R3 E4 只修了 `inspectDeviceRegistryAtBoot` 吞 corrupt；ntfy enabled 时紧接着 `initializeNotifications` → `reconcileNotificationDevices` 再读同一 corrupt 文件 throw，awaited 启动链仍炸，API 起不来。 | **已修。** `initializeNotifications` 对 reconcile 的 `DeviceRegistryCorruptError` fail-closed（吞+已有读盘告警）；设备 API 仍 500 `device_registry_corrupt`；`/healthz` 与其余路由正常。 | `corrupt registry with ntfy enabled does not block startup and fail-closes devices`（inspect + `initializeNotifications` + `/healthz` 200 + GET devices 500；告警无 `leaked-secret-value` / password） |
| B | Codex Local P1 · `notification-devices.ts` 覆盖写目录 fsync（置信 0.96） | 覆盖写 rename 已替换 dest；目录 fsync 失败 → persist 报失败 → 创建 502 并删新建 ntfy user，但磁盘已是含新设备的 registry——报告与磁盘矛盾。 | **已修。** 覆盖写 dest→`.bak` 再 tmp→dest；目录 fsync 失败用 `.bak`（内存快照兜底）换回旧文件；成功再删 `.bak`。首次创建撤回 dest 不变。读盘恢复：dest 缺且 `.bak` 在则换回；dest 在则丢掉残留 `.bak`。 | `directory fsync failure on overwrite restores the previous registry`；`overwrite directory fsync failure keeps old registry and deletes the new ntfy user`（502 + 旧设备仍在 + DELETE 只打新 username） |
| C | Codex 云端行内 P2 · QR quiet zone | 扫码要求四周 ≥4 模块留白。canvas 原先模块顶边绘制；`.device-qr` padding 12px 在 canvas 被拉到 240px 时不够 4 模块。 | **已修。** `paintDeviceQr` 把 `quiet = 4` 画进位图：`canvas` 边长 `(size+8)*scale`，模块从 `(x+4,y+4)` 起笔，白底延伸。CSS 12px 白垫仍在，作额外边。 | `pairing QR canvas paints a 4-module quiet zone` |
| D | Codex 云端行内 P2 · tmp 短写 | 自管 `writeSync(fd, serialized)` 一次、不看返回值。POSIX write 可短写；`writeFileSync` 才会写全量。 | **已修（存在短写风险，不是「不存在」）。** `writeAllSync` 循环 `writeSync(buf, offset, remaining)` 直到整段 UTF-8 落盘，再 `fsync` + rename。 | 实现：`writeAllSync`；独立自审确认循环在 fsync 之前 |

### 独立自审（R5 · 新 agent，禁止自审自）

| 项 | 值 |
|---|---|
| Subagent ID | `2cf614a2-7cf8-47fb-b85b-892bda53760a` |
| 审查对象 | 未提交工作区相对 `3e13c51` 的 R5 diff |
| 结论 | **mergeable** |
| P0 / P1 / P2 | **0 / 0 / 0** |
| A 裁定 | **过** — `main.ts` 全路：inspect 吞 corrupt → initialize 吞 reconcile 的同一错误；设备 500；healthz 独立。新测不是只跑 inspect。 |
| B 裁定 | **过** — 覆盖写 fsync 失败 dest 回到旧字节；`.bak` 不是 live store；首次创建仍无 dest；create 删的是新 ntfy user。dest 缺+bak 在下次读盘恢复；dest 在则丢 bak。 |
| C / D | quiet=4 进位图；`writeAllSync` 循环短写。 |
| 过程 | 先独立追 `main.ts` awaited 链与 `writeAtomicSync` 覆盖写/崩溃窗，再裁；未改文件、未委托。残余观察（不当作 finding）：dest→bak 与 tmp→dest 不在 fsync restore 包里（下次 `readRegistrySync` 会恢复）；未另加 dest-missing+.bak / 真短写测。 |

### 完成标准

- `cd packages/api && bun test` → **797 pass / 0 fail**
- `bun run build` → Bundled 568 modules，全绿
- 未新开分支；未动 `main`；push 后停等指挥终审，禁止自 merge。

---

## 返工 R6（2026-08-13 · CI 红 + Codex 云端 P1 format + P2 bak 恢复）

分支仍是 `tizerluo/worker-34-pr6`。就地修、就地 push。未新开分支、未动 `main`、未自 merge。

### 评论对账

| # | 来源 | 问题 | 处置 | 证据 / 测试名 |
|---|---|---|---|---|
| A | CI 红 · 硬闸 | `corrupt registry with ntfy enabled does not block startup and fail-closes devices` 在 CI 超时 5000ms（本机绿，~1.1s）。run `31712040043`：14:49:18 开跑，14:49:23 报 `timed out after 5000ms`，下一条用例 14:50:56 才开始（超时后 bcrypt 仍跑了 ~90s）。 | **根因：不是 ntfyFetch 8s。** 该路径 `initializeNotifications` → `writeServerConfig` 对 admin+publisher+每个 reader 做 bcrypt cost=10，**不调用** `ntfyFetch`（corrupt 在 reconcile 读盘即 throw）。本机套件 ~15s、CI ~105s（~7×）；哈希把单测拖过 bun 默认 5s。修法：测试内注入廉价 `setNotifyPasswordHashForTests`，并把 `fetch` mock 成立即抛错（证明不等 8s）。**未调大测试时限。** | `corrupt registry with ntfy enabled does not block startup and fail-closes devices`（注入短哈希后本机 ~0.8s；仍走 inspect + initialize + healthz 200 + devices 500） |
| B | Codex 云端 P1 · `drawFormat` | `modules` 按 `[y][x]`，format 用 ISO `(x,y)` 直接赋到 `[x][y]`，两份 format 转置；`drawData` 写进真 format 格，扫码器拿不到 mask。 | **已修。** `put(x,y,bit)` → `modules[y][x]`。第一份 `(8,0..5)/(8,7)/(8,8)/(7,8)/(5..0,8)`；第二份右上水平 + 左下垂直；暗模块 `(8,size-8)`。 | `format bits occupy ISO (x,y) copies and data does not overwrite them`（v1/2/7/10 功能格 + 配对全编码两份 15 位一致、`isFunc[y][x]`） |
| C | Codex 云端 P2 · `.bak` 恢复 | dest 缺、`.bak` 在时 rename 失败只 log，随后当空表；新注册落盘丢掉 `.bak`，历史配对变孤儿。 | **已修。** 恢复失败 `failClosed` + throw；`writeAtomicSync` 在 dest 缺且 `.bak` 仍在时拒绝落盘。 | `bak restore rename failure fail-closes and does not write an empty registry`（5xx + `.bak` 保留 Keep + dest 不出现） |
| D | 指挥加注 · 真扫码 | 前三轮测试自证不真扫。 | **已加。** `qr-png.ts` 渲 PNG（quiet=4, scale=8）+ `scripts/decode-pairing-qr.py`（OpenCV `QRCodeDetector`）+ `scripts/verify-pairing-qr.ts`。bun 测 `skipIf` 无 cv2（CI 不装 opencv）。本机 venv 解码成功，抓到 B：format 转置时扫码器无法得 mask；修后载荷全等。 | `OpenCV QRCodeDetector recovers pairing payload from PNG`；脚本输出见下 |

### 真扫码解码留证（本机 2026-08-13）

```
png=/tmp/oae-qr-bZ4lV9/pairing.png
size=57 bytes=8638
decoder=/tmp/oae-qr-venv/bin/python exit=0
stderr=# points=(1, 4, 2)
decoded={"serverUrl":"https://notify.test.example","username":"phone-abcdefgh","password":"abcdefghijklmnopqrstuvwx","topics":{"userAlerts":"user-alerts-xyzxyzxyz","userLow":"user-low-xyzxyzxyz"}}
OK pairing payload round-trip
```

解码器：python venv + `opencv-python-headless` 5.0.0 `cv2.QRCodeDetector`。CI 无 cv2 时该测 skip，format 坐标测仍跑。

### 独立自审（R6 · 新 agent，禁止自审自）

| 项 | 值 |
|---|---|
| Subagent ID | `94288c31-b372-4110-b2ed-68bac9a6a878` |
| 审查对象 | 未提交工作区相对 `8059c09` 的 R6 diff |
| 结论 | **mergeable** |
| P0 / P1 / P2 | **0 / 0 / 0**（P3 README 句被截断，已在 push 前修好） |
| A 裁定 | **过** — 根因是 bcrypt 不是 8s fetch；注入哈希而非调大 timeout。CI run `31716054044` 该测 **191ms pass**。二次红是 `spawnSync('/tmp/oae-qr-venv/bin/python')` 在 CI 上 ENOENT 炸整个 `qr-byte.test.ts`（先 `existsSync` 再 probe）。 |
| B 裁定 | **过** — `put` 写 `[y][x]`；坐标测能抓住转置（`isFunc[y][x]`）。 |
| C 裁定 | **过** — 恢复失败先 throw，persist 拒写 unrestored bak。 |
| D 裁定 | **过** — 有 cv2 时 stdout === PAIRING_JSON。 |
| 过程 | 对照 CI log 时间线、Nayuki `setFunctionModule(x,y)`、read/persist 空表路径；未改文件、未委托。 |

### 完成标准

- `cd packages/api && bun test` → **800 pass / 0 fail**（本机含 OpenCV；CI 无 cv2 时该条 skip）
- `bun run build` → Bundled 568 modules，全绿
- **CI 转绿**（push 后盯 run）
- 未新开分支；未动 `main`；push 后停等指挥终审，禁止自 merge。

---

## 返工 R7（2026-08-13 · Codex 云端 P1 分类器 + P2 三连恢复 + P2 双 DELETE）

分支仍是 `tizerluo/worker-34-pr6`。就地修、就地 push。未新开分支、未动 `main`、未自 merge。相对 R6 head `c15fb43`。

### 评论对账

| # | 来源 | 问题 | 处置 | 证据 / 测试名 |
|---|---|---|---|---|
| A | Codex 云端 P1 · `notify.ts` 分类器 | 404 匹配名单留裸 `not_found` 子串。反代/错误路由 body `{"error":"route_not_found"}` 含该子串 → 判 missing user → 本地永久 `revoked` 并隐藏，远端账号没删。 | **已修。** `ntfyDeleteBodyMeansMissingUser` 只认 `code === 40031` 或文本 `"user does not exist"`；删掉裸 `not_found`。其余 404/400 一律 transient。5xx 仍不看 body。 | `gateway 404 route_not_found body stays transient and does not converge`（404 + `route_not_found` → pending_revoke）；`5xx body containing user-does-not-exist stays transient; 40031/404 still not_found`（`(404,'not_found')` 现为 transient；40031 / `"user does not exist"` 仍 not_found） |
| B | Codex 云端 P2 · `notification-devices.ts` | 目录 fsync 失败后 `.bak` rename 失败 + 内存快照 `writeFileSync` 也失败时错误被吞，新 dest 留着；下次读盘 dest+.bak 丢 bak → active 指向已被删的 ntfy 账号。 | **已修。** 两路都失败：`failClosed`、新 dest 隔离为 `.unrestored`、保留 `.bak`、throw `DeviceRegistryCorruptError`。`recoverBackupSync` 见 unrestored+.bak 不得丢 bak。 | `triple restore failure fail-closes and keeps bak evidence`（三连失败 → list/register throw corrupt；`.bak` 仍是 Keep；dest 不在；`.unrestored` 含 New） |
| C | Codex 云端 P2 · `notify.ts` | `revokeNotificationDevice` 先 `reconcile`（已对 pending 目标 DELETE），再 `revokePairedDevice` 又 DELETE。ntfy 无响应时一次重试吃两个 8s。 | **已修。** `reconcileNotificationDevices(skipDeviceId)` 处理其它 pending 但跳过本次目标；skip 路径不占用/替换 list 的 in-flight coalesce。目标只走 revoke 单次 DELETE。 | `pending_revoke target issues a single DELETE when ntfy is 503`（已 pending + 全 503 → 第二次 revoke 只 1 次 DELETE） |

### 独立自审（R7 · 新 agent，禁止自审自）

| 项 | 值 |
|---|---|
| Subagent ID | `62d40cd6-c839-4987-b09b-c3fa655f66e5` |
| 审查对象 | 未提交工作区相对 `c15fb43` 的 R7 diff |
| 结论 | **mergeable** |
| P0 / P1 / P2 | **0 / 0 / 0** |
| A 裁定 | **过** — 只认 40031 / "user does not exist"；`route_not_found` 与裸 `not_found` 为 transient。 |
| B 裁定 | **过** — 三连失败 failClosed + `.unrestored` 隔离 + `.bak` 保留；下次读盘不得丢 bak 当新 dest 有效。 |
| C 裁定 | **过** — skip 本目标且不碰 `reconcileInFlight`；单目标 503 revoke 一次 DELETE。 |
| 过程 | 对照 `git diff c15fb43` 与分类器/恢复/skip 路径；跑 `notify.test.ts` + `notification-devices.test.ts`（65 pass）；未改文件、未委托。 |
| 残余（不当作 finding） | dest 隔离 rename+rm 都失败时重启仍可能 dest+.bak 丢 bak（同目录 rename 已成功过，未演示）；并发 list+revoke 仍可能双 DELETE（skip 不得加入 in-flight，单次 revoke 调用已是一次 DELETE）。 |

### 完成标准

- `cd packages/api && bun test` → **802 pass / 0 fail**（本机含 OpenCV；CI 无 cv2 时该条 skip）
- `bun run build` → Bundled 568 modules，全绿
- **CI 转绿**（push 后盯 run）
- 未新开分支；未动 `main`；push 后停等指挥终审，禁止自 merge。

---

## 返工 R8（2026-08-13 · Codex Local P1 临时 disabled 假吊销 + ZCode 记债）

分支仍是 `tizerluo/worker-34-pr6`。就地修、就地 push。未新开分支、未动 `main`、未自 merge。相对 R7 head `e292b3d`。

### 评论对账

| # | 来源 | 问题 | 处置 | 证据 / 测试名 |
|---|---|---|---|---|
| A | Codex Local P1 · `notify.ts:666`（置信 0.97） | R3 D 把两种 ntfy 未就绪混为一谈：临时 `NTFY_ENABLED=false` 或缺 admin 密码时，不删远端 user 就标永久 `revoked`。手机继续收信；ntfy 恢复后 revoked 行被对账跳过，永远无法收敛。报成功=说谎。 | **已修（选拒绝 503，不挂 pending）。** ① 无远端身份（行无 `ntfyUsername`）→ 仍允许本地收敛。② 行含 `ntfyUsername`（曾配对，凭据可能存活）→ 抛 `notifications_disabled` / `notifications_unconfigured`，HTTP **503** + `message` 人话，**不改** `revokeStatus`。已 revoked 仍幂等、不外呼。理由：凭据存活期间 UI 不该显示「已吊销」；挂 `pending_revoke` 会显示「Revoking…」同样像正在吊销。503 让 admin 先恢复 ntfy 管理面，再走 ADR 五步。 | `revoke with ntfy disabled does not mark a remote username revoked`（disabled / unconfigured 均拒绝，status 仍 active，fetches=0）；`already revoked stays idempotent when ntfy is fully unconfigured`（先 40031 收敛再关 ntfy，二次 revoke=`already_revoked`、fetch 不增加）；`admin revoke is 503 when ntfy is disabled and the row has a remote username`（Bearer 503 + message） |

**与 ADR 吊销一致性：** 不冲突。ADR 是 `pending_revoke` → 删 ntfy user → `revoked`，未证明远端删除不得标 revoked。503 在步骤 1 之前拒绝，行保持 `active`。比 R3 本地假 `revoked` 更贴 ADR。

### ZCode 记债（自判不阻断；本轮不改码）

| # | 条目 | 理由（为何记债不改） |
|---|---|---|
| P1-1 | 步骤③ persist 失败靠下次 reconcile 遇 not_found 收敛 | ADR 接受语义：步骤 3 失败保持 pending；启动/列表对账用缺失信号收敛。不是静默丢吊销。 |
| P1-2 | QR 内嵌 `publicUrl` + password 明文 | 运维配置的 pairing URL；password 明文是一次性配对设计（只展示一次、永不落盘）。改协议会破坏现有扫码。 |
| P2-1 | dest 隔离 rename+rm 都失败时，重启见 dest+.bak 可能丢 bak | R7 同目录 rename 已成功过的路径上隔离几乎总能完成；未演示双失败。加固可加 `.failclosed` 标记。 |
| P2-2 | 并发 list+revoke 仍可能对同一 pending 双 DELETE | R7 skip 不得加入 list in-flight（否则会等 list 先 DELETE 再 revoke 再 DELETE）。单次 revoke 调用已是一次 DELETE。 |
| P2-3 | 幽灵 user 清理仍 best-effort、无重试队列 | R2 B②：凭据从未落盘，无法对账；下次创建用新 username。 |
| P2-4 | 顺序请求仍全量 reconcile pending（无跨请求 TTL） | R2 B①：列表必须收敛刚写入的 pending；pending 稀有。并发 in-flight 已合并。 |
| P2-5 | 首次写 `.tmp` 已 fsync 但 rename 前崩溃会丢唯一副本 | 早期 Codex P2；首次创建无 dest，不完整 tmp 故意丢弃以免半截 JSON。与覆盖写 `.bak` 路径不同。 |

指挥转述 ZCode「可以合并」（P0=0，P1×2 建议跟进=记债，P2×5 不阻断）。上表 P2-1…P2-5 为对照本仓仍开放的加固项，不扩本轮 scope。

### 独立自审（R8 · 新 agent，禁止自审自）

| 项 | 值 |
|---|---|
| Subagent ID | `e3cb234e-76ca-412d-858e-7e1920d25e55` |
| 审查对象 | 未提交工作区相对 `e292b3d` 的 R8 diff |
| 结论 | **mergeable** |
| P0 / P1 / P2 | **0 / 0 / 0** |
| A 裁定 | **过** — 有 `ntfyUsername` 时 503、status 仍 active、无 fetch；已 revoked 幂等。 |
| ADR | **不冲突** — 503 在步骤 1 前拒绝，比本地假 revoked 更贴五步。 |
| 过程 | 对照 diff、`revokeNotificationDevice` / `peekPairedDevice` / ADR、Bearer/UI 503、测试；未改文件、未委托。 |

### 完成标准

- `cd packages/api && bun test` → **804 pass / 0 fail**（本机含 OpenCV；CI 无 cv2 时该条 skip）
- `bun run build` → Bundled 568 modules，全绿
- **CI 转绿**（push 后盯 run）
- 未新开分支；未动 `main`；push 后停等指挥终审，禁止自 merge。

---

## 返工 R9（2026-08-13 · Codex Local P1 回滚后未 fsync 目录）

分支仍是 `tizerluo/worker-34-pr6`。就地修、就地 push。未新开分支、未动 `main`、未自 merge。相对 R8 head `f34489c`。

### 评论对账

| # | 来源 | 问题 | 处置 | 证据 / 测试名 |
|---|---|---|---|---|
| A | Codex Local P1 · `notification-devices.ts:450`（置信 0.92） | 目录 fsync 失败后回滚（删 dest / 恢复 `.bak`）完成，但没有再 fsync 目录。502 之后崩溃 + 内核 replay 已失败的 rename → 被拒的新 registry 留盘，对应 ntfy user 已被删，复活孤儿 active。 | **已修。** 回滚后（首次 unlink 或覆盖写 restore）再 `fsyncDirectorySync(DATA_DIR)`。这次再失败：复用 `failClosed` + 落盘 `.failclosed` 标记，保留全部现场文件，throw `DeviceRegistryCorruptError`，设备 API 5xx；告警只有 path/error。成功则仍抛原 fsync 错 → 502，磁盘与报告一致。 | ① `directory fsync failure on create rolls back and leaves no half state`、`directory fsync failure on overwrite restores the previous registry`（只失败第一次 fsync，回滚后再成功 → PersistError 502）；`overwrite directory fsync failure keeps old registry and deletes the new ntfy user`。② `rollback directory fsync failure fail-closes and keeps evidence`（两次 EIO → corrupt + `.failclosed` + Keep 证据仍在；后续 list/register 不丢） |

### 独立自审（R9 · 新 agent，禁止自审自）

| 项 | 值 |
|---|---|
| Subagent ID | `daeab04f-8dd1-473e-8389-52a2b44e29c2` |
| 审查对象 | 未提交工作区相对 `f34489c` 的 R9 diff |
| 结论 | **mergeable** |
| P0 / P1 / P2 | **0 / 0 / 0** |
| A 裁定 | **过** — 回滚后二次目录 fsync；再失败 `markRegistryFailClosed`；① 仍 502；② corrupt + 证据保留。 |
| 过程 | 对照 `git diff f34489c`、`writeAtomicSync` 回滚与标记、相关测试；未改文件、未委托。 |

### 完成标准

- `cd packages/api && bun test` → **805 pass / 0 fail**（本机含 OpenCV；CI 无 cv2 时该条 skip）
- `bun run build` → Bundled 568 modules，全绿
- **CI 转绿**（push 后盯 run）
- 未新开分支；未动 `main`；push 后停等指挥终审，禁止自 merge。

## 布局自测说明（1280 / 375；线上截屏由指挥做）

未开真浏览器拍屏。依据 shell + CSS：

- **1280 桌面：** Push 三卡 `repeat(auto-fit, minmax(220px, 1fr))` 保持；其下 `Paired devices` 段。设备行 `.device-row` 两列（meta + Revoke，`min-height: 44px`）。Add device 在 heading 右侧（admin 显示）。添加窗普通 `modal-card`；一次性凭据窗 `modal-card-wide`（≤560px）含 QR 白底 + server/user/password copy。
- **375 / ≤820px：** 设备行改 block，Revoke 全宽 44px；wide modal 收到 440px；三卡 `min-height: 44px` 未改。identity 会话 CSS 隐藏 `#configure-push-add`，JS 不拉设备列表。
- 指挥请拍：设备列表、添加引导、一次性 QR、吊销确认、tier 三卡回归。拍屏指引见下一节。

---

## 本地起服务拍屏指引（合并前总指挥必看）

工位仓库：`/home/ops/orca/workspaces/openagentemail/worker-34-pr1`  
分支：`tizerluo/worker-34-pr6`。不要切 `main`。

### 1. 临时目录与 mock ntfy

真 ntfy 在工位通常没有。用一个只回答 users API 的 mock（2586）即可拍到列表 / QR / 吊销。

```sh
WORKDIR=/tmp/oae-pr6-shot
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR/data" "$WORKDIR/ntfy"
chmod 700 "$WORKDIR/data"

# mock ntfy：POST/ACL 200；DELETE 默认 40031（缺失 user 成功，便于吊销立刻失效）
cat > "$WORKDIR/mock-ntfy.ts" <<'EOF'
const users = new Set<string>();
Bun.serve({
  port: 2586,
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/v1/users') {
      return req.json().then((body: { username?: string }) => {
        if (body.username) users.add(body.username);
        return new Response('', { status: 200 });
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/users/access') {
      return new Response('', { status: 200 });
    }
    if (req.method === 'DELETE' && url.pathname === '/v1/users') {
      return new Response(
        JSON.stringify({ code: 40031, http: 400, error: 'invalid request: user does not exist' }),
        { status: 400 },
      );
    }
    return new Response('ok', { status: 200 });
  },
});
console.log('[mock-ntfy] :2586');
EOF
bun "$WORKDIR/mock-ntfy.ts" &
```

若要拍到列表里的「Revoking…」行：把 mock 的 DELETE 改成 `return new Response('', { status: 503 })`，再重启 API 后点 Revoke（步骤 2 会停在 `pending_revoke`）。

### 2. 起 dev API（端口 3100，临时 DATA_DIR）

```sh
cd /home/ops/orca/workspaces/openagentemail/worker-34-pr1/packages/api
PORT=3100 \
DOMAIN=shot.test \
API_KEYS=shot-admin-key \
IMAP_USER=agent@shot.test \
IMAP_PASS=shot-imap \
SMTP_USER=agent@shot.test \
SMTP_PASS=shot-smtp \
DATA_DIR="$WORKDIR/data" \
NTFY_ENABLED=true \
NTFY_INTERNAL_URL=http://127.0.0.1:2586 \
NOTIFY_PUBLIC_URL=https://notify.shot.test \
NTFY_ADMIN_PASSWORD=shot-ntfy-admin \
NTFY_UPSTREAM=false \
bun run --watch src/main.ts
```

浏览器打开 `http://127.0.0.1:3100/ui`（必须是这个 origin，cookie `Secure` 在 localhost http 关闭）。登录框填 `shot-admin-key`，勾选 Remember 可选。Cookie 名 `oae_ui`，`Path=/ui`，HttpOnly。

也可用 curl 造会话（之后把 `oae_ui` 贴进浏览器或继续用 curl）：

```sh
curl -sS -D - -o /dev/null \
  -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:3100' \
  -d '{"token":"shot-admin-key","remember":true}' \
  http://127.0.0.1:3100/ui/api/session
```

### 3. 造一台已配对设备

登录后打开 Configure → Push & Devices → **Add device** → 可选 Display name（如 `Kitchen phone`）→ Create credentials。应出现一次性密码 + QR。然后：

```sh
# 磁盘零明文（指挥可复跑）
grep -R -n -E 'password|token' "$WORKDIR/data/notification-devices.json" || echo 'no password/token keys'
python3 - <<PY
from pathlib import Path
p = Path("$WORKDIR/data")
blob = "\n".join(f.read_text(errors="ignore") for f in p.rglob("*") if f.is_file())
assert '"password"' not in blob and '"token"' not in blob
print("DATA_DIR walk: no password/token keys")
PY
```

Bearer 等价：

```sh
curl -sS -D - \
  -H 'authorization: Bearer shot-admin-key' \
  -H 'content-type: application/json' \
  -d '{"publicUrl":"https://notify.shot.test","displayName":"Kitchen phone"}' \
  http://127.0.0.1:3100/v1/notify/devices
```

### 4. 造 pending_revoke 样例（不经 UI）

API **必须先停**（单写者；不要和运行中的 API 抢同一文件），写入后重启：

```sh
cat > "$WORKDIR/data/notification-devices.json" <<'EOF'
{
  "schemaVersion": 1,
  "devices": [
    {
      "id": "dev_aaaaaaaaaaaaaaaaaaaaaaaa",
      "displayName": "Kitchen phone",
      "ntfyUsername": "phone-kitchen1",
      "topics": { "userAlerts": "user-alerts-shot", "userLow": "user-low-shot" },
      "pairedAt": "2026-08-13T08:00:00.000Z",
      "lastSeenAt": null,
      "revokeStatus": "active",
      "revokedAt": null
    },
    {
      "id": "dev_bbbbbbbbbbbbbbbbbbbbbbbb",
      "displayName": "Lost phone",
      "ntfyUsername": "phone-lost0001",
      "topics": { "userAlerts": "user-alerts-shot", "userLow": "user-low-shot" },
      "pairedAt": "2026-08-01T08:00:00.000Z",
      "lastSeenAt": null,
      "revokeStatus": "pending_revoke",
      "revokedAt": null
    }
  ]
}
EOF
chmod 600 "$WORKDIR/data/notification-devices.json"
```

- mock DELETE=40031：重启后启动对账会把 `Lost phone` 收敛成 `revoked`（列表默认不再显示）。
- mock DELETE=503：`Lost phone` 保持「Revoking…」，可拍中间态。
- 点 Kitchen phone 的 Revoke → 确认框文案含设备名。

### 5. identity 403 对照（可选）

用 identity token 登录同一 `/ui` 后进 Push：无 Add device，文案 “Only the instance admin can manage paired devices.”；`GET /ui/api/notify/devices` 应 403。

### 6. 拍完关掉

停 API 与 mock ntfy；`rm -rf /tmp/oae-pr6-shot`。不要把临时 DATA_DIR 提交进仓库。
