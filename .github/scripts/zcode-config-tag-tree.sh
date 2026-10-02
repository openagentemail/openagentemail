#!/usr/bin/env bash
# 标签树根路径守卫：只查 .zcode/config.json 与 zcode.json，不执行内容。
set -euo pipefail

# 缺少 SHA、对象缺失或不是提交，一律失败关闭。
if [ -z "${GITHUB_SHA:-}" ]; then
  echo "::error::缺少 GITHUB_SHA" >&2
  exit 1
fi
kind="$(git cat-file -t "$GITHUB_SHA" 2>/dev/null || true)"
if [ "$kind" != "commit" ]; then
  echo "::error::目标不是提交 (${kind:-missing})" >&2
  exit 1
fi
# 检出的 HEAD 必须等于事件提交。
head="$(git rev-parse HEAD)"
if [ "$head" != "$GITHUB_SHA" ]; then
  echo "::error::HEAD 与 GITHUB_SHA 不一致" >&2
  exit 1
fi

# git cat-file -e 精确根路径；存在即红。vendor 与 node_modules 同名不会命中。
if git cat-file -e "$GITHUB_SHA:.zcode/config.json" 2>/dev/null; then
  echo "::error::根路径 .zcode/config.json 禁止入库" >&2
  exit 1
fi
if git cat-file -e "$GITHUB_SHA:zcode.json" 2>/dev/null; then
  echo "::error::根路径 zcode.json 禁止入库" >&2
  exit 1
fi
