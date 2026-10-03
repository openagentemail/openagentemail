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
# Also prove the failure was caused by rejecting the tag object.
grep -Fq '::error::目标不是提交 (tag)' "$TMP/tag.err"
# #392 三入口。夹具是静态的，未跑线上事件。恶意 PR 留到指挥官合并之后。
rm -rf "$TMP/.zcode" "$TMP/zcode.json" "$TMP/README"
mkdir -p "$TMP/.zcode"
printf '%s\n' 'inert' > "$TMP/.zcode/readme"
PLAIN="$(commit plain-dot)"
expect_green "$PLAIN"
if git -C "$TMP" cat-file -e "$PLAIN:.zcode/config.json" 2>/dev/null; then
  echo "plain .zcode dir must not contain config" >&2
  exit 1
fi
[ "$(git -C "$TMP" ls-tree "$PLAIN" .zcode | awk '{print $1}')" = "040000" ]
sym_red() {
  local name="$1" target="$2" sha mode
  rm -rf "$TMP/.zcode"
  ln -s "$target" "$TMP/.zcode"
  git -C "$TMP" add -A -f
  git -C "$TMP" commit -q -m "$name"
  sha="$(git -C "$TMP" rev-parse HEAD)"
  mode="$(git -C "$TMP" ls-tree "$sha" .zcode | awk '{print $1}')"
  [ "$mode" = "120000" ]
  [ "$(git -C "$TMP" cat-file -p "$sha:.zcode")" = "$target" ]
  expect_red "$sha"
}
sym_red internal "vendor/inert-target"
sym_red external "/tmp/oae-zcode-outside"
sym_red broken "$TMP/missing-zcode-target"
rm -f "$TMP/.zcode"
GONE="$(commit symlink-deleted)"
if git -C "$TMP" cat-file -e "$GONE:.zcode" 2>/dev/null; then
  echo "deleted symlink must be absent" >&2
  exit 1
fi
expect_green "$GONE"
WF="$ROOT/.github/workflows/zcode-config-guard.yml"
grep -Eq '^  pull_request_target:' "$WF"
if grep -Eq '^  pull_request:' "$WF"; then
  echo "must not run the PR workflow file" >&2
  exit 1
fi
grep -Fq 'contents: read' "$WF"
grep -Fq 'pull-requests: read' "$WF"
if grep -Eq ': write|secrets\.' "$WF"; then
  echo "permissions must stay read-only and secret-free" >&2
  exit 1
fi
if grep -Fq 'gh pr comment' "$WF"; then
  echo "comment step must be gone" >&2
  exit 1
fi
if grep -Fq 'zcode-config-pr-files.sh' "$WF"; then
  echo "workflow must not call a PR-head helper" >&2
  exit 1
fi
if grep -Fq 'pull_request.head.sha' "$WF" && grep -Fq 'actions/checkout' "$WF"; then
  if awk '
    $0 ~ /if: github.event_name == '\''pull_request_target'\''/ {pr=1}
    pr && $0 ~ /actions\/checkout/ {found=1}
    pr && $0 ~ /if: github.event_name == '\''push'\''/ {exit}
    END {exit !found}
  ' "$WF"; then
    echo "PR job must not checkout head" >&2
    exit 1
  fi
fi
[ ! -e "$ROOT/.github/scripts/zcode-config-pr-files.sh" ]
PR_RUN="$TMP/pr-run.sh"
awk '
  $0 ~ /name: 检查变更是否触碰 ZCode 项目配置/ {p=1}
  p && $0 ~ /^        run: \|/ {r=1; next}
  r && /^          / {sub(/^          /, ""); print; next}
  r {exit}
' "$WF" > "$PR_RUN"
grep -Fq 'git/trees/' "$PR_RUN"
grep -Fq '120000' "$PR_RUN"
# 导出函数桩。子 bash 会继承，不再往 PATH 放假可执行文件。
gh() {
  local expr="" url=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --jq) expr="$2"; shift 2 ;;
      --paginate) shift ;;
      api) shift ;;
      *) url="$1"; shift ;;
    esac
  done
  (
    set -o pipefail
    if [[ "$url" == *"/git/trees/"* ]] && [ "${GH_TREE_RC:-0}" -ne 0 ]; then
      exit "${GH_TREE_RC}"
    fi
    if [[ "$url" == *"/git/trees/"* ]]; then
      printf '%s' "${GH_TREE_JSON-}"
    else
      printf '%s' "${GH_FILES_JSON-[]}"
    fi | if [ -n "$expr" ]; then jq -r "$expr"; else cat; fi
  )
}
timeout() {
  if [ "${GH_TIMEOUT_STUB:-}" = "1" ]; then
    return 124
  fi
  shift
  "$@"
}
export -f gh
export -f timeout
run_pr() {
  local rc
  set +e
  REPO=example/repo PR=1 HEAD_SHA=abc bash "$PR_RUN" >/dev/null 2>&1
  rc=$?
  set -e
  printf '%s' "$rc"
}
while IFS='|' read -r files tree tree_rc timeout_stub expect_zero; do
  [ -n "${files}" ] || continue
  export GH_FILES_JSON="$files"
  export GH_TREE_JSON="$tree"
  if [ "$tree_rc" = 0 ]; then unset GH_TREE_RC; else export GH_TREE_RC="$tree_rc"; fi
  if [ "$timeout_stub" = 1 ]; then export GH_TIMEOUT_STUB=1; else unset GH_TIMEOUT_STUB; fi
  rc="$(run_pr)"
  if [ "$expect_zero" = 1 ]; then
    [ "$rc" -eq 0 ]
  else
    [ "$rc" -ne 0 ]
  fi
done << 'CASES'
[]|{"truncated":false,"tree":[]}|0|0|1
[{"filename":".zcode"}]|{"truncated":false,"tree":[]}|0|0|1
[{"filename":".zcode"}]|{"truncated":false,"tree":[{"path":".zcode","mode":"120000","sha":"internal"}]}|0|0|0
[{"filename":".zcode"}]|{"truncated":false,"tree":[{"path":".zcode","mode":"120000","sha":"external"}]}|0|0|0
[{"filename":".zcode"}]|{"truncated":false,"tree":[{"path":".zcode","mode":"120000","sha":"broken"}]}|0|0|0
[{"filename":".zcode"}]|{"truncated":false,"tree":[{"path":".zcode","mode":"040000"}]}|0|0|1
[{"filename":"vendor/.zcode/config.json"},{"filename":"vendor/zcode.json"}]|{"truncated":false,"tree":[]}|0|0|1
[{"filename":".zcode/config.json"}]|{"truncated":false,"tree":[]}|0|0|0
[{"filename":"zcode.json"}]|{"truncated":false,"tree":[]}|0|0|0
[]|{"truncated":false,"tree":[]}|1|0|0
[]|{"message":"bad"}|0|0|0
[]|{"truncated":true,"tree":[]}|0|0|0
[]|{"tree":[]}|0|0|0
[]|{"truncated":"yes","tree":[]}|0|0|0
[{"filename":".zcode"}]|{"truncated":false,"tree":[{"path":".zcode","mode":"bogus"}]}|0|0|0
[]|{"truncated":false,"tree":[]}|0|1|0
CASES
paths="$(awk '
  $0 ~ /^    paths:$/ {p=1; next}
  p && $0 ~ /^      - / {gsub(/"/, "", $2); print $2; next}
  p {exit}
' "$WF")"
for need in .zcode .zcode/config.json zcode.json; do
  printf '%s\n' "$paths" | grep -Fxq "$need"
done
for skip in vendor/.zcode vendor/.zcode/config.json node_modules/.zcode/config.json .zcode/readme; do
  if printf '%s\n' "$paths" | grep -Fxq "$skip"; then
    echo "push path must stay green: $skip" >&2
    exit 1
  fi
done
grep -Fq 'refs/heads/' "$WF"
grep -Fq 'exit 1' "$WF"
printf '%s\n' "zcode tag-tree guard ok"
