# 根 .zcode 符号链接

主防线是受保护基线分支的 push，以及受控标签。任意 PR 分支上的 push 不可信。

- 标签：`git ls-tree` 见到根 `.zcode` mode `120000` 即失败。最终没有该条目则通过。不读 blob，不解析目标。
- 基线分支：`on.push.paths` 含 `.zcode`、`.zcode/config.json`、`zcode.json`。命中即失败，不看目标。

PR 使用 `pull_request_target`。工作流文件来自基线分支，是合并前的可信检查。权限只有 `contents: read` 和 `pull-requests: read`。没有写入权限，没有密钥，不留评论。不检出，也不执行 PR 或合并树上的文件。

PR 只把 head SHA 交给 Git Trees API 当数据，只看根树一层。mode `120000` 失败。`040000`、`100644`、`100755`、`160000` 通过。其他 mode，包括空和 `bogus`，算畸形。最终没有根 `.zcode`（含删除）通过。
`truncated` 必须是布尔 `false`。缺失、`true` 或非布尔都失败关闭。API 错误、超时或畸形响应同样失败关闭。`.zcode/config.json` 与 `zcode.json` 仍按精确路径拒绝。

组织或企业的事件策略由所有者跟进。公开的强制日是 2026-11-02。

合并前的红绿钉是静态夹具，没有跑线上事件。恶意 PR（把守卫改成无条件通过，并加入根 `.zcode` 符号链接）是指挥官把本卡合并进 main 之后的第一件事，不在合并前做。
fork 的 head SHA 若不在基线仓库里，API 读失败按红处理。
