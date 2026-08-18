# 回执 · MCP task_list outputSchema 催办字段 R1

- **上游 task id**：`4eed9913-a54f-4d04-81b7-9e1b96016f12`（总指挥 fox-2xhf@ → FC fc-tokyo@）
- **任务卡**：`/home/ops/fleet-roles/state/task-2026-08-18-tasklist-output-schema.md`
- **分支**：`fix/mcp-task-list-output-schema`（从最新 `origin/main` `6aacc6c` 切开，未从已合并的 `fix/cimd-chatgpt-none-fallback` 续长）
- **PR**：**#38**（非 Draft，未自行合并）→ https://github.com/openagentemail/openagentemail/pull/38
- **HEAD**：`e561328`（R1 返工叠在 `92cef66` 上，未 force-push）
- **时间**：2026-08-18
- **派单人**：FC（Claude·Tokyo 试运行首班）。FC 补令：先 `fetch/checkout/pull` 最新 main 再开分支；勿把未提交 `Progress.md` 带进本单 commit。

## 改动摘要

| 文件 | 行/为什么 |
|---|---|
| `packages/api/src/mcp/tools.ts` | `taskMessageSchema` 补 `kind: z.enum(["state","reminder"]).optional()` 与 `idempotencyKey: z.string().optional()`，对齐 `lib/tasks.ts` 的 `TaskEventKind` / `TaskMessage`。`task_list` 与 `task_get` 共用，一处两治。 |
| `packages/api/src/app.ts` | 测试可注入 `taskService`，MCP `/mcp`→`/v1/tasks` 回环才能喂含催办字段的真实形状。默认仍挂生产 `tasksRoute`，REST 响应形态不变。R1 补 `@internal 仅测试可用，禁止用于生产组装`。 |
| `packages/api/test/mcp-http.test.ts` | 原三条 HTTP 回环保留（证明 handler 未剥字段）。R1 另加 `tools/list` 广播契约：message 层 `properties` 含 `kind`/`idempotencyKey` 且 `additionalProperties===false`。 |

未改：REST `/v1/tasks` 响应形态、inputSchema、状态机、UI。未 passthrough / 未删出口校验 / 未在 handler 剥字段。

## 根因复核

已读三处，与任务卡一致：

- `tools.ts` 原 schema 仅 id/from/to/subject/date/state/body/result?
- `lib/tasks.ts:64-76` `TaskMessage` 另有 `kind?` / `idempotencyKey?`；`:262-263` 解析写入、`:815-816` `remindTask` 写入
- `routes/tasks.ts:134-144` `GET /` 原样 `c.json({ tasks })` 无投影

## 四条验收

### ① 全量 `bun test` 数字

`packages/api`（`bun install` 对齐后，cwd=`packages/api`）：

R1 后（`e561328`）：

```text
 854 pass
 1 skip
 3 fail
 5818 expect() calls
Ran 858 tests across 46 files. [43.91s]
```

`test/mcp-http.test.ts` 单独：**18 pass / 0 fail**（+1 契约断言）。  
3 fail 经 FC 在独立 worktree 对 `origin/main` `6aacc6c` 实证背书为既有 env 串扰，不修。

### ② 无参 `task_list` 无 -32602（R1 更正）

**前一版回执不成立**：`POST /mcp` 进程内回环走的是服务端 `@modelcontextprotocol/server` 的 `validateStandardSchema`（**zod**）。`z.object()` 默认非严格，多余键只剥不抛，服务端永远不报生产那条 `-32602`。服务端失败文案会是 `Output validation error: Invalid structured content for tool X`，与生产报文对不上。

**生产 -32602 的真实来源**：客户端拿 `tools/list` 广播的 JSON Schema（zod 转出，`additionalProperties:false`）对 structuredContent 做 **ajv** 校验，报文才是 `Structured content does not match the tool output schema: data/tasks/16/messages/2 must NOT have additional properties`。

**本单采用的验证**：方案 1 契约断言——`tools/list` 取 `task_list`/`task_get` 的 `outputSchema`，断言 message 层 `properties` 含 `kind` 与 `idempotencyKey`，且 `additionalProperties===false`。原三条 HTTP 回环保留，只证明 handler 没剥字段，不当本 bug 回归网。

工位仍无 dogfood MCP 客户端直调；生产实调由 FC 部署后补。

### ③ 带 `state` 筛选仍正常

HTTP 回环：`arguments: { state: "submitted" }` 只返回 submitted 工单（handler 语义）。契约断言与筛选无关，覆盖的是广播 schema。

### ④ PR 描述有修前后对比

PR #38 body 含修前 -32602 原文与修后三条 pass 原文。

## Subagent 独立自审

- **审查代理**：Cursor Task `generalPurpose`（agent id `be1925a4-02ba-4503-ad29-9f964b13aff7`）
- **基线**：`origin/main` (`6aacc6c`) → tip `92cef66`
- **结论**：**No findings.**

摘录：schema 已覆盖 `TaskMessage`/`TaskEventKind`；handler 未剥字段、未 passthrough；`createApp({ taskService })` 仅测试注入；REST 形态不变。

## 记债

1. **全量套件 3 fail（既有）**：测试间 `UI_ENABLED` / `API_KEYS` 串扰。main 上同样失败。不修。
2. **`packages/api/src/mcp/client.ts` `TaskMessage` 类型仍缺 `kind`/`idempotencyKey`**（自审指出）。运行时是 `data as T`，不挡出口校验，但 TS 类型窄于真实数据。本单不改 client 类型（避免顺手扩 task 系语义面）。
3. **邮箱巡检**：敲桌要求启动巡检。本工位无 dogfood IMAP/MCP 直连 fleets 任务箱；未对 `4eed9913-…` 做生产收件实读。Gmail MCP 不是该任务箱。**做不到生产邮箱巡检，未自证。**
4. **ZCode P2-1 给 `idempotencyKey` 加 `.max(1024)` 等出口长度上限**：FC 终审驳回（outputSchema 收紧会复刻 -32602）。防御若做应在入口 `lib/tasks.ts` `parseTaskMessage` 截断邮件头——范围外，记债不修。

## 冷启动 / 分支纪律

- 已读 `STATUS.md`（valid_until 2026-08-18T23:05+08）与 `05-developer.md`。
- `git fetch origin && git checkout main && git pull` 后 HEAD=`6aacc6c`，再切本分支。
- 未提交的 `Progress.md` 已 stash，未进入 `92cef66` / `e561328`。

---

## R1 返工（FC 终审，2026-08-18）

- **A（P1）**：补 `tools/list` 广播契约测试。负控：把新 `mcp-http.test.ts` + `app.ts` 原样搬到 **未修 main**（`tools.ts` 保持窄 schema，worktree `/tmp/oae-main-negctrl` @ `6aacc6c`）。
- **B（P2）**：上文 ②③ 已按「服务端 zod 非严格 ≠ 生产 ajv -32602」更正。
- **C（P2）**：`AppOptions.taskService` 已标 `@internal 仅测试可用，禁止用于生产组装`。
- **ZCode P2-1**：按 FC 裁定不改；已在 PR 评论引用。

### 负控原文：修前 fail（未修 main + 新测试）

```text
274 |       expect(item.properties).toHaveProperty('kind');
                                    ^
error: expect(received).toHaveProperty(path)

Expected path: "kind"

Unable to find property

      at <anonymous> (/tmp/oae-main-negctrl/packages/api/test/mcp-http.test.ts:274:31)
(fail) MCP task_list/task_get 广播 outputSchema 契约 > tools/list 广播的 message 层含 kind 与 idempotencyKey，且 additionalProperties=false [42.67ms]
(pass) MCP task_list/task_get outputSchema 覆盖催办字段 > 无参 task_list：含 reminder+idempotencyKey 的消息通过出口校验 [65.40ms]
(pass) MCP task_list/task_get outputSchema 覆盖催办字段 > 带 state 筛选的 task_list 仍正常 [75.08ms]
(pass) MCP task_list/task_get outputSchema 覆盖催办字段 > task_get 同源 schema：催办消息不触发 -32602 [59.02ms]

 17 pass
 1 fail
 75 expect() calls
Ran 18 tests across 1 file. [2.32s]
```

旧三条 HTTP 回环在窄 schema 上仍绿（与 FC 负控一致）。契约条修前必红。

### 敲桌

已 `orca terminal send --terminal term_ed768895-ee10-4ed0-8308-1ff7df02f1de --text "完工，task 4eed9913，PR #38，回执路径 /home/ops/openagentemail/state/receipt-tasklist-schema-r1.md" --enter`（108 bytes），并补发裸 `--enter`。当时对方会话正在 `Spelunking…` 忙，回读 tail 未回显用户行（输入区不在 output tail）。已按纪律补发，未 `--interrupt`。

### 修后 pass（本分支 `e561328`）

```text
(pass) MCP task_list/task_get 广播 outputSchema 契约 > tools/list 广播的 message 层含 kind 与 idempotencyKey，且 additionalProperties=false [23.55ms]
(pass) MCP task_list/task_get outputSchema 覆盖催办字段 > 无参 task_list：含 reminder+idempotencyKey 的消息通过出口校验 [43.88ms]
(pass) MCP task_list/task_get outputSchema 覆盖催办字段 > 带 state 筛选的 task_list 仍正常 [35.89ms]
(pass) MCP task_list/task_get outputSchema 覆盖催办字段 > task_get 同源 schema：催办消息不触发 -32602 [27.87ms]

 18 pass
 0 fail
 80 expect() calls
Ran 18 tests across 1 file. [1468.00ms]
```
