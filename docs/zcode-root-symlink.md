# 根 .zcode 符号链接

主防线是受保护基线分支的 push，以及受控标签。任意 PR 分支上的 push 不可信。

- 标签：`git ls-tree` 见到根 `.zcode` mode `120000` 即失败。最终没有该条目则通过。不读 blob，不解析目标。
- 标签：`git ls-tree` 见到根 `.zcode` mode `160000` 即失败，诊断写明 gitlink。无害根 `.zcode` 子模块同样拒绝。不读目标对象，不初始化子模块。
- 基线分支：`on.push.paths` 含 `.zcode`、`.zcode/config.json`、`zcode.json`。命中即失败，不看目标。

PR 使用 `pull_request_target`。工作流文件来自基线分支，是合并前的可信检查。权限只有 `contents: read` 和 `pull-requests: read`。没有写入权限，没有密钥，不留评论。不检出，也不执行 PR 或合并树上的文件。

PR 先核对元数据：事件 PR 号、40 位 head SHA，以及不超过 3000 的非负整数 changed_files。文件列表必须分页读完，条数与 changed_files 一致。出现的 previous_filename 必须是非空字符串，null 同样拒绝。
根树必须完整。根上任意模式的 zcode.json，以及根 .zcode 的符号链接 mode 120000，都拒绝。
根 `.zcode` mode `160000` 是 gitlink，一律拒绝，无害根子模块也拒绝。判定只读父树 mode，不展开、不 fetch、不读目标或 URL。
`#392` 与 `#394` 曾接受全局 schema 的 `160000`，那是已批准历史；本卡只收紧根路径 `.zcode` 的该 mode。其他路径的 gitlink 仍支持。
不声称消费者会自动初始化子模块，也不声称这构成生产利用。
文件名规则仍只钉 `.zcode/config.json` 与 `zcode.json`。根 `.zcode` 被删除、改名离开，或换成不含 config.json 的普通目录，终树为绿。
全局 schema 仍接受任意单组件路径的 `160000` 加 `commit`。只有根路径恰好 `.zcode` 且 mode `160000` 才按 gitlink 拒绝。
根 .zcode 若是普通目录，再读一层子树；子路径恰好 config.json 则拒绝。不读 blob，不执行也不解析目标。
超过 3000、缺页或不完整、截断、畸形、API 失败或超时都失败关闭。
删除 .zcode/config.json 或 zcode.json 仍按精确路径拒绝。重命名离开或复制时，先前路径恰是这两处也拒绝；status 为 renamed 却没有该字段则失败关闭。

组织或企业的事件策略由所有者跟进。公开的强制日是 2026-11-02。

合并前的红绿钉是静态夹具，没有跑线上事件。恶意 PR（把守卫改成无条件通过，并加入根 `.zcode` 符号链接）是指挥官把本卡合并进 main 之后的第一件事，不在合并前做。
fork 的 head SHA 若不在基线仓库里，API 读失败按红处理。
