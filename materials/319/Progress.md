# materials/319 · 工作日志（Progress）

## 步骤完成记录

### 我们实现了哪些功能？
1. 建立内部交付目录 `materials/319/`（矩阵、完工件、探针、官文/Composio 快照与证据）。
2. 抓取 AgentMail Attachments 官文 dated 快照（2026-09-22T10:58:06Z）与 Composio 2026-09-21 changelog 快照。
3. 编写并运行受控探针 `probe-attachments.ts`，真打本机 `createApp`：G1–G5 + MCP + 下载路由探测；落 `probe-stdout.txt` / `probe-results.json`。
4. 写出三列矩阵与 completion（含 Composio 九项附录与第六节事实/代价）。
5. subagent 自审 `c4c3fbd8-b391-4a81-9569-8d31dacf0755` → PASS_WITH_NITS（已按 nit 补原始摘录并校正行数至合计 **207**）→ commit/push → PR https://github.com/openagentemail/openagentemail/pull/323 。

### 我们遇到了哪些错误？
1. 初跑 `createIdentity` 返回值误用为直接含 `address` → `from=undefined` → 全组假 400。
2. R0/任务卡预期「attachments→400（strict）」与源码不符（无 `.strict()`）→ 实测 200 静默剥离。
3. 任务卡路径写 `POST /v1/messages`，实际发信为 `POST /v1/send`；成功码为 200 非 201。
4. 自审 nit：文档合计初稿低于 200 行带、行数自报偏高。

### 我们是如何解决这些错误的？
1. 改为 `createIdentity(...).identity.address` 后重跑，G1–G5/MCP 全绿可复现。
2. 矩阵与 completion **以原始 stdout 为准**，明确记录与 R0 预期的偏差，不伪造 400。
3. 在矩阵抬头写清端点校正；探针注释同步说明。
4. 补 §2.1 原始摘录 + 矩阵锚点表；`wc -l` 钉死合计 **207** 行。
