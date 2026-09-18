# Progress.md

## 2026-09-18 · #225/#226/#227 合批（#224 评审债清零）

### 我们实现了哪些功能？

1. **#225**：共享 `wait-clock-mock` helper；动态比对真实模块导出键，缺口报 `does not cover`；`mock.module` 用绝对路径；迁移 `wait-precedence-r9-matrix.ts` 与 `wait-for-rearm.test.ts`。
2. **#226①**：api/mcp 包内 `dist-build-lock`（staging 写 PID + rename 原子占锁、陈旧 PID 回收）；dist 钉子测试包锁串行；零构建面变化。
3. **#226②**：`defaultWaitMonotonicNow` 首次钉死 clock family，flip 即 throw（消息含族名）。
4. **#227**：`resolveAccessToken` admin key 改照 `resolveUiSessionTokenByHash` 的 sha256Hex+hashEquals 循环；新增 accept/reject 钉测。

### 我们遇到了哪些错误？

1. 根仓无 `package.json`，`bun install` 需在 `packages/api` / `packages/mcp` 执行。
2. `mock.module` 相对路径按 helper 文件解析 → mcp 侧 mock 失效，`wait-for-rearm` 大面积红。
3. 同进程 `Bun.sleepSync` 堵死事件循环，等锁测无法用 `setInterval` 释放。
4. 对抗自审 r1：`mkdir` 后写 PID 前窗口 +「无 pid 立即回收」可双持锁（TOCTOU）。

### 我们是如何解决这些错误的？

1. 分别在 api/mcp 包内 install/tsc/test。
2. helper 改为 `resolve` 绝对路径注册 `mock.module`。
3. 等锁/TOCTOU 实证改为多 `Bun.spawn` 子进程。
4. 改为 staging+rename 原子占锁；无合法 PID 宽限至超时再回收；`finally` 仅本 PID 释放；8 进程压力测回归后 r2=`PASS_WITH_NOTES`。

### 验收摘要

- 分支 `fix/225-226-227-wait-clock-debts` @ `0523961`
- api 1863 pass / mcp 48 pass / 0 fail
- 完工件：`/home/ops/materials/225-226-227/completion.md`
