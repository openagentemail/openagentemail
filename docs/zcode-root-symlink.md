# 根 .zcode 符号链接

主防线是受保护基线分支的 push，以及受控标签。任意 PR 分支上的 push 不可信。

- 标签：`git ls-tree` 见到根 `.zcode` mode `120000` 即失败。最终没有该条目则通过。不读 blob，不解析目标。
- 基线分支：`on.push.paths` 含 `.zcode`、`.zcode/config.json`、`zcode.json`。命中即失败，不看目标。

PR 使用 `pull_request_target`。工作流文件来自基线分支，是合并前的可信检查。权限只有 `contents: read` 和 `pull-requests: read`。没有写入权限，没有密钥，不留评论。不检出，也不执行 PR 或合并树上的文件。

PR 先核对元数据：事件 PR 号、40 位 head SHA，以及不超过 3000 的非负整数 changed_files。文件列表必须分页读完，条数与 changed_files 一致。
根树必须完整。根上任意模式的 zcode.json，以及根 .zcode 的符号链接 mode 120000，都拒绝。
根 .zcode 若是普通目录，再读一层子树；子路径恰好 config.json 则拒绝。不读 blob，不执行也不解析目标。
超过 3000、缺页或不完整、截断、畸形、API 失败或超时都失败关闭。
删除 .zcode/config.json 或 zcode.json 仍按精确路径拒绝。

组织或企业的事件策略由所有者跟进。公开的强制日是 2026-11-02。

合并前的红绿钉是静态夹具，没有跑线上事件。恶意 PR（把守卫改成无条件通过，并加入根 `.zcode` 符号链接）是指挥官把本卡合并进 main 之后的第一件事，不在合并前做。
fork 的 head SHA 若不在基线仓库里，API 读失败按红处理。
