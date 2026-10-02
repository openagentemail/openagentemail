#!/usr/bin/env bash
# 隔离临时仓库：调用仓库内同一检查器。夹具内容惰性，不执行。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKER="$ROOT/.github/scripts/zcode-config-tag-tree.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
[ -f "$CHECKER" ]

git -C "$TMP" init -q -b main
git -C "$TMP" config user.email "guard@example.test"
git -C "$TMP" config user.name "guard"
git -C "$TMP" config core.excludesFile /dev/null

commit() {
  git -C "$TMP" add -A -f
  git -C "$TMP" commit -q --allow-empty -m "$1"
  git -C "$TMP" rev-parse HEAD
}

# 轻量标签直接指向提交；附注标签剥到同一提交。
tag_both() {
  local name="$1" sha="$2"
  git -C "$TMP" tag "lw-$name" "$sha"
  git -C "$TMP" tag -a "ann-$name" "$sha" -m "$name"
  [ "$(git -C "$TMP" rev-parse "lw-$name")" = "$sha" ]
  [ "$(git -C "$TMP" rev-parse "ann-$name^{}")" = "$sha" ]
}

expect_green() {
  local sha="$1"
  git -C "$TMP" checkout -q "$sha"
  (cd "$TMP" && GITHUB_SHA="$sha" bash "$CHECKER")
}

expect_red() {
  local sha="$1" err="$TMP/red.err"
  git -C "$TMP" checkout -q "$sha"
  set +e
  (cd "$TMP" && GITHUB_SHA="$sha" bash "$CHECKER") >"$err" 2>&1
  local status=$?
  set -e
  [ "$status" -ne 0 ] || { printf 'expected red %s\n' "$sha" >&2; cat "$err" >&2; exit 1; }
}

# 干净树为绿。两种标签都指向该提交。
printf '%s\n' 'inert' > "$TMP/README"
CLEAN="$(commit clean)"
tag_both clean "$CLEAN"
expect_green "$(git -C "$TMP" rev-parse lw-clean)"
expect_green "$(git -C "$TMP" rev-parse 'ann-clean^{}')"

# 仅根 .zcode/config.json 为红。
rm -f "$TMP/README"
mkdir -p "$TMP/.zcode"
printf '%s\n' '{"inert":true}' > "$TMP/.zcode/config.json"
DOT="$(commit dot)"
tag_both dot "$DOT"
expect_red "$(git -C "$TMP" rev-parse lw-dot)"
expect_red "$(git -C "$TMP" rev-parse 'ann-dot^{}')"

# 仅根 zcode.json 为红。
rm -rf "$TMP/.zcode"
printf '%s\n' '{"inert":true}' > "$TMP/zcode.json"
ROOTJ="$(commit rootjson)"
tag_both rootjson "$ROOTJ"
expect_red "$(git -C "$TMP" rev-parse lw-rootjson)"
expect_red "$(git -C "$TMP" rev-parse 'ann-rootjson^{}')"

# vendor 与 node_modules 同名为绿，且这些路径确实在提交里。
rm -f "$TMP/zcode.json"
mkdir -p "$TMP/vendor/.zcode" "$TMP/node_modules/.zcode"
printf '%s\n' '{"inert":true}' > "$TMP/vendor/.zcode/config.json"
printf '%s\n' '{"inert":true}' > "$TMP/vendor/zcode.json"
printf '%s\n' '{"inert":true}' > "$TMP/node_modules/.zcode/config.json"
printf '%s\n' '{"inert":true}' > "$TMP/node_modules/zcode.json"
HOM="$(commit homonyms)"
for path in vendor/.zcode/config.json vendor/zcode.json node_modules/.zcode/config.json node_modules/zcode.json; do
  git -C "$TMP" cat-file -e "$HOM:$path"
done
if git -C "$TMP" cat-file -e "$HOM:.zcode/config.json" 2>/dev/null; then
  echo "homonym tree must not contain root .zcode/config.json" >&2
  exit 1
fi
if git -C "$TMP" cat-file -e "$HOM:zcode.json" 2>/dev/null; then
  echo "homonym tree must not contain root zcode.json" >&2
  exit 1
fi
tag_both homonyms "$HOM"
expect_green "$(git -C "$TMP" rev-parse lw-homonyms)"
expect_green "$(git -C "$TMP" rev-parse 'ann-homonyms^{}')"

# 检出停在干净提交：错误 SHA、缺失对象、附注标签对象都失败关闭。
git -C "$TMP" checkout -q "$CLEAN"
set +e
(cd "$TMP" && GITHUB_SHA="$DOT" bash "$CHECKER") >"$TMP/wrong.err" 2>&1
WRONG=$?
(cd "$TMP" && GITHUB_SHA="0000000000000000000000000000000000000000" bash "$CHECKER") >"$TMP/miss.err" 2>&1
MISS=$?
(cd "$TMP" && GITHUB_SHA="$(git rev-parse ann-clean)" bash "$CHECKER") >"$TMP/tag.err" 2>&1
TAGOBJ=$?
set -e
[ "$WRONG" -ne 0 ] || { echo "wrong checkout sha must fail" >&2; cat "$TMP/wrong.err" >&2; exit 1; }
[ "$MISS" -ne 0 ] || { echo "missing object must fail" >&2; cat "$TMP/miss.err" >&2; exit 1; }
[ "$TAGOBJ" -ne 0 ] || { echo "annotated tag object must fail" >&2; cat "$TMP/tag.err" >&2; exit 1; }
printf '%s\n' "zcode tag-tree guard ok"
