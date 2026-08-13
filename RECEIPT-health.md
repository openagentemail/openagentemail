# RECEIPT — health 小单（#9 / #22 / #23）

日期：2026-08-13  
分支：`tizerluo/worker-34-health`（基线 `origin/main` `94566013`）  
禁动 main，禁止自 merge。无 /ui 行为变化，未拍屏。

## 对账

| Issue | 处置 | 证据 / 测试名 |
|---|---|---|
| **#9** ntfy `messages()` 无超时 | **fixed** | `messages()` 走 `ntfyFetch`（`NTFY_ADMIN_FETCH_TIMEOUT_MS=8000`）。`fetch` 与 `response.text()` 同一 try，超时/网络失败 → `NotifyError('notify_unavailable')`。`/v1` 与 `/ui` 共用本方法。测试：`messages() fetch timeout maps to NotifyError notify_unavailable`；`messages() body read timeout maps to NotifyError notify_unavailable` |
| **#22.1** `lastSeenPersistedAt` 文件不存在分支 | **fixed** | `loadFromDisk` 无文件也 `this.lastSeenPersistedAt = now`。测试：`文件不存在的 loadFromDisk 也设置 lastSeenPersistedAt`；`不走 create：从磁盘加载后间隔内 authenticate 不落盘` |
| **#22.2** 启动清 `.tmp` | **fixed** | `discardStaleTmp`：`loadFromDisk` 开头 `unlinkSync(path + '.tmp')`，失败不阻断启动。测试：`启动时清理 ui-sessions.json.tmp 残留` |
| **#22.3** DATA_DIR 单写者声明 | **fixed** | `docs/security.md` 新节「DATA_DIR 单写者约定」；`packages/api/README.md` `DATA_DIR` 行；`ui-session.ts` `persistPath` 注释 |
| **#23** mcp outputSchema | **fixed**（发版 tag 不在本单） | 共享 `packages/api/src/mcp/tools.ts`（stdio 入口已复用）。summary 含 `source`/`hasOtp`（description 补 `hasOtp`）；detail 不含 `seen`/`snippet`/`hasOtp`。测试：`message summary/detail 输出 schema 按 API 真实形状校验并保留字段`（缺 `source`/`hasOtp` fail；detail `readOut.seen/snippet/hasOtp` 为 undefined） |

`cd packages/api && bun test`：**820 pass / 0 fail**；`bun run build`：Bundled 568 modules。  
`cd packages/mcp && bun test`：**23 pass / 0 fail**；`bun run build`：Bundled 174 modules。

## 独立自审

| 轮 | agent id | 结论 | 过程 |
|---|---|---|---|
| 初审 | `26b44d5e-fdcf-46a1-bba1-e12230fdbd03` | **block**；P0=0 P1=1 P2=0 | 对照 `94566013` 未提交 diff。#22/#23 对齐。#9 P1：Bun 上 header 已到时 `fetch()` resolve，`response.text()` 超时抛 `TimeoutError`，当时不在 try 内 → 路由非 NotifyError → 500 |
| 复审（仅 P1） | 同上 resume | **mergeable**；剩余 P0/P1=0 | `fetch` + `ok` + `text()` 同一 try；新测试 `messages() body read timeout maps to NotifyError notify_unavailable` 真跑 harness。未改文件 |

## 未做

- `@openagentemail/mcp` npm 发版 / tag（#23 原文：下次发版消化，归业主拍板）
- 网站 docs 镜像 `docs/security.md` 新节（security.md 顶部已注明 canonical 在 website repo）
