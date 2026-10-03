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
# 根 .zcode gitlink：目标对象不在父库，无映射文件，只凭 mode 160000 拒绝。
MISSING=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
git -C "$TMP" update-index --add --cacheinfo "160000,$MISSING,.zcode"
git -C "$TMP" commit -q -m "root-gitlink"
GL="$(git -C "$TMP" rev-parse HEAD)"
[ "$(git -C "$TMP" ls-tree "$GL" .zcode | awk '{print $1}')" = "160000" ]
if git -C "$TMP" cat-file -e "$MISSING" 2>/dev/null; then
  echo "gitlink target must be absent" >&2
  exit 1
fi
if git -C "$TMP" cat-file -e "$GL:.zcode/config.json" 2>/dev/null; then
  echo "gitlink parent config must be absent" >&2
  exit 1
fi
if git -C "$TMP" cat-file -e "$GL:.gitmodules" 2>/dev/null; then
  echo "gitlink fixture must not add mapping" >&2
  exit 1
fi
tag_both rootgitlink "$GL"
# 只服务根 gitlink 夹具：失败文案点名该夹具，不改既有 expect_red。
tag_rootgitlink_red() {
  local form="$1" sha="$2" err="$TMP/red.err" status
  git -C "$TMP" checkout -q "$sha"
  set +e
  (cd "$TMP" && GITHUB_SHA="$sha" bash "$CHECKER") >"$err" 2>&1
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    printf 'tag rootgitlink fixture stayed green %s\n' "$form" >&2
    exit 1
  fi
  grep -Fq '根路径 .zcode gitlink 禁止入库' "$err" || {
    printf 'tag rootgitlink fixture missed gitlink diag %s\n' "$form" >&2
    exit 1
  }
}
tag_rootgitlink_red lightweight "$(git -C "$TMP" rev-parse lw-rootgitlink)"
tag_rootgitlink_red peeled "$(git -C "$TMP" rev-parse 'ann-rootgitlink^{}')"
git -C "$TMP" update-index --force-remove .zcode
rm -rf "$TMP/.zcode"
git -C "$TMP" commit -q -m "root-gitlink-deleted"
GLDEL="$(git -C "$TMP" rev-parse HEAD)"
if git -C "$TMP" ls-tree "$GLDEL" .zcode | grep -q .; then
  echo "deleted root gitlink must be absent" >&2
  exit 1
fi
expect_green "$GLDEL"
git -C "$TMP" checkout -q "$GLDEL"
git -C "$TMP" rm -r -q --cached --ignore-unmatch vendor node_modules
rm -rf "$TMP/vendor" "$TMP/node_modules" "$TMP/.zcode"
git -C "$TMP" update-index --add --cacheinfo "160000,$MISSING,vendor/.zcode"
git -C "$TMP" update-index --add --cacheinfo "160000,$MISSING,libs"
git -C "$TMP" commit -q -m "homonym-gitlinks"
HOMGL="$(git -C "$TMP" rev-parse HEAD)"
[ "$(git -C "$TMP" ls-tree -r "$HOMGL" vendor/.zcode | awk '{print $1}')" = "160000" ]
[ "$(git -C "$TMP" ls-tree "$HOMGL" libs | awk '{print $1}')" = "160000" ]
[ -z "$(git -C "$TMP" ls-tree "$HOMGL" .zcode | awk '{print $1}')" ]
expect_green "$HOMGL"
# red.err 会随 git add -A 进入临时提交；先还原这份跟踪文件，后面的 checkout 才不会被脏副本拦住。清理顺序不变。
git -C "$TMP" checkout -q -- red.err
git -C "$TMP" checkout -q "$CLEAN"
rm -rf "$TMP/.zcode"
printf '%s\n' 'inert' > "$TMP/.zcode"
git -C "$TMP" add -A -f
git -C "$TMP" commit -q -m "plain-blob"
BLOB="$(git -C "$TMP" rev-parse HEAD)"
[ "$(git -C "$TMP" ls-tree "$BLOB" .zcode | awk '{print $1}')" = "100644" ]
expect_green "$BLOB"
chmod 755 "$TMP/.zcode"
git -C "$TMP" add -A -f
git -C "$TMP" commit -q -m "plain-exec"
EXEC="$(git -C "$TMP" rev-parse HEAD)"
[ "$(git -C "$TMP" ls-tree "$EXEC" .zcode | awk '{print $1}')" = "100755" ]
expect_green "$EXEC"
expect_green "$PLAIN"
WF="$ROOT/.github/workflows/zcode-config-guard.yml"
grep -Eq '^  pull_request_target:' "$WF"
if grep -Eq '^  pull_request:' "$WF"; then
  echo "must not run the PR workflow file" >&2
  exit 1
fi
# 有效权限：注释不算。顶层或 job 块必须恰好两行只读；job 级标量 permissions 失败。
perm_ok() {
  awk '
    { s = $0
      sub(/#.*/, "", s); sub(/[[:space:]]+$/, "", s)
      if (s == "") next
      if (index(s, "secrets.") > 0) secret = 1
      if (s == "permissions:") { lvl = "wf"; next }
      if (s == "jobs:") { lvl = "jobs"; next }
      if (s ~ /^[^[:space:]]/) { lvl = ""; next }
      if (lvl == "wf" && s ~ /^  [^[:space:]][^:]*:[[:space:]]/) { sub(/^  /, "", s); wf[++wn] = s; next }
      if (lvl == "jobs" && s ~ /^  [^[:space:]][^:]*:$/) { job = s; sub(/^  /, "", job); sub(/:$/, "", job); next }
      if (s ~ /^    permissions:[[:space:]]*[^[:space:]]/) bad_scalar = 1
      if (lvl == "jobs" && s == "    permissions:") { lvl = "jp"; has[job] = 1; next }
      if (lvl == "jp" && s ~ /^      [^[:space:]][^:]*:[[:space:]]/) { sub(/^      /, "", s); jp[job, ++jn[job]] = s; next }
      if (lvl == "jp" && s !~ /^      /) lvl = "jobs"
      if (s ~ /event_name == .pull_request_target./) pr = job
    }
    END {
      n = has[pr] ? jn[pr] : wn
      for (i = 1; i <= n; i++) seen[has[pr] ? jp[pr, i] : wf[i]] = 1
      if (secret || bad_scalar || pr == "" || n != 2 || seen["contents: read"] != 1 || seen["pull-requests: read"] != 1) exit 1
    }
  ' "$1"
}
expect_nonzero() {
  if "$@"; then
    return 1
  fi
}
perm_ok "$WF"
sed 's/^  contents: read$/#&/; s/^  pull-requests: read$/#&/' "$WF" > "$TMP/perm-comment.yml"
sed 's/^  guard:$/&\n    permissions: write-all/' "$WF" > "$TMP/perm-write-all.yml"
awk '
  $0 == "  guard:" {
    print
    print "    permissions:"
    print "      contents: read"
    print "      pull-requests: read"
    print "      actions: read"
    next
  }
  { print }
' "$WF" > "$TMP/perm-actions.yml"
for bad in "$TMP/perm-comment.yml" "$TMP/perm-actions.yml" "$TMP/perm-write-all.yml"; do
  expect_nonzero perm_ok "$bad"
done
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
# PR 全 schema 夹具走真实 jq。请求日志只允许 repos 路径。
[ "$(grep -c 'timeout 20' "$PR_RUN")" -eq 1 ] && [ "$(grep -Ec 'call (元数据|文件列表|根树|子树) ' "$PR_RUN")" -eq 4 ]
grep -Fq -- '--paginate' "$PR_RUN"
grep -Fq -- '--slurp' "$PR_RUN"
grep -Fq 'per_page=100' "$PR_RUN"
if grep -Fq 'recursive' "$PR_RUN"; then echo "must not recurse trees" >&2; exit 1; fi
SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
CSHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
BSHA=cccccccccccccccccccccccccccccccccccccccc
DSHA=dddddddddddddddddddddddddddddddddddddddd
REQ="${TMP:-/tmp}/gh-requests.log"
ET='{"truncated":false,"tree":[]}'
gh() {
  local url=""
  while [ $# -gt 0 ]; do
    case "$1" in
      api|--paginate|--slurp) shift ;;
      --jq) shift 2 ;;
      -*) shift ;;
      *) url="$1"; shift ;;
    esac
  done
  printf '%s\n' "$url" >> "$REQ"
  # 测试桩可追加一条请求日志。未设置时不写、不访问网络。
  if [ -n "${GH_EXTRA_URL:-}" ]; then
    printf '%s\n' "$GH_EXTRA_URL" >> "$REQ"
  fi
  local phase="" body="" rc=0
  case "$url" in
    http:*|https:*|*recursive=*) return 9 ;;
    */files*) phase=files; body="${GH_FILES_JSON-}"; rc="${GH_FILES_RC:-0}" ;;
    */pulls/*) phase=meta; body="${GH_META_JSON-}"; rc="${GH_META_RC:-0}" ;;
    */git/trees/"$HEAD_SHA") phase=root; body="${GH_TREE_JSON-}"; rc="${GH_TREE_RC:-0}" ;;
    */git/trees/*) phase=child; body="${GH_CHILD_JSON-}"; rc="${GH_CHILD_RC:-0}" ;;
    *) return 9 ;;
  esac
  if [ "${GH_TIMEOUT_PHASE:-}" = "$phase" ]; then return 124; fi
  [ "$rc" -eq 0 ] || return "$rc"
  printf '%s' "$body"
}
timeout() { shift; if [ "${GH_TIMEOUT_STUB:-}" = 1 ]; then return 124; fi; "$@"; }
export -f gh timeout
export REQ SHA
clr() { : > "$REQ"; unset GH_META_RC GH_FILES_RC GH_TREE_RC GH_CHILD_RC GH_TIMEOUT_STUB GH_TIMEOUT_PHASE; }
pr_run() {
  local expect="$1" diag="${2:-}" out rc
  set +e
  out="$(REPO=example/repo PR=1 HEAD_SHA="$SHA" bash "$PR_RUN" 2>&1)"
  rc=$?
  set -e
  if [ "$expect" = 0 ]; then
    [ "$rc" -eq 0 ] || { printf 'green fail\n%s\n' "$out" >&2; exit 1; }
  else
    [ "$rc" -ne 0 ] || { printf 'red fail %s\n%s\n' "$diag" "$out" >&2; exit 1; }
    [ -z "$diag" ] || printf '%s\n' "$out" | grep -Fq "$diag" || { printf 'diag %s\n%s\n' "$diag" "$out" >&2; exit 1; }
  fi
}
gitlink_red() {
  pr_run 1 "根路径 .zcode gitlink 禁止入库"
  [ "$(grep -c '/git/trees/' "$REQ")" -eq 1 ]
  ! grep -Eq 'https?://|recursive=' "$REQ"
}
use() {
  GH_META_JSON="$(jq -nc --argjson n "$1" --arg sha "$SHA" '{number:1,head:{sha:$sha},changed_files:$n}')"
  GH_FILES_JSON="$2"
  GH_TREE_JSON="$3"
  GH_CHILD_JSON="${4:-}"
  clr
  export GH_META_JSON GH_FILES_JSON GH_TREE_JSON GH_CHILD_JSON
}
files_n() { jq -n --argjson n "$1" '[range(0;$n)|{filename:("f"+tostring)}] | if $n==0 then [[]] else [range(0;length;100) as $i | .[$i:$i+100]] end'; }
E() { printf '{"path":"%s","mode":"%s","type":"%s","sha":"%s"}' "$1" "$2" "$3" "$4"; }
T() { printf '{"truncated":false,"tree":[%s]}' "$1"; }
page() { jq -nc --args '[[ $ARGS.positional[] | {filename:.} ]]' "$@"; }
for n in 0 1 100 101 3000; do
  use "$n" "$(files_n "$n")" "$ET"
  pr_run 0
done
use 1 "$(page README)" "$ET"
pr_run 0
use 1 "$(page .zcode)" "$ET"
pr_run 0
use 2 "$(page vendor/.zcode/config.json vendor/zcode.json)" "$ET"
pr_run 0
use 2 "$(page node_modules/.zcode/config.json node_modules/zcode.json)" "$ET"
pr_run 0
use 3 "$(page .zcode/config.json.bak .zcode/nested/config.json vendor/zcode.json)" "$ET"
pr_run 0
use 1 "$(jq -nc '[[{"filename":"ok.txt\nzcode.json"}]]')" "$ET"
pr_run 0
use 1 "$(page .zcode/readme)" "$ET"
pr_run 0
use 1 "$(jq -nc '[[{"filename":".zcode/readme","status":"removed"}]]')" "$ET"
pr_run 0
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(T "$(E readme 100644 blob "$BSHA")")"
pr_run 0
grep -Fq "git/trees/$CSHA" "$REQ"
! grep -Eq 'https?://' "$REQ"
use 1 "$(page .zcode)" "$(T "$(E .zcode 100644 blob "$BSHA")")"
pr_run 0
use 1 "$(page .zcode)" "$(T "$(E .zcode 100755 blob "$BSHA")")"
pr_run 0
use 1 "$(page .zcode)" "$(T "$(E .zcode 160000 commit "$BSHA")")"
gitlink_red
use 1 "$(page README)" "$(T "$(E .zcode 160000 commit "$BSHA")")"
gitlink_red
use 0 '[[]]' "$(T "$(E .zcode 160000 commit "$BSHA")")"
gitlink_red
ESHA=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
use 1 "$(page .zcode)" "$(T "$(E .zcode 160000 commit "$ESHA")")"
gitlink_red
# 干净请求绿控：本条日志不含目标 SHA，也不含 gitmodules。
if grep -Fq "$ESHA" "$REQ"; then
  printf 'request named target %s\n' "$ESHA" >&2
  exit 1
fi
if grep -Fq gitmodules "$REQ"; then
  printf 'request named gitmodules\n' >&2
  exit 1
fi
# 永久反向红控：匹配目标 SHA、匹配 gitmodules 必须点名失败。嵌套 mutation 副本跳过，避免重复整套。
if [ "${W397_SKIP_REQ_RED:-}" != 1 ] && [ "${W394_SKIP_MUTATION:-}" != 1 ]; then
  req_red() {
    local name="$1" extra="$2" needle="$3"
    local dir="$TMP/req-$name" out rc
    mkdir -p "$dir/.github/workflows" "$dir/.github/scripts" "$dir/deploy"
    cp "$CHECKER" "$dir/.github/scripts/zcode-config-tag-tree.sh"
    cp "$WF" "$dir/.github/workflows/zcode-config-guard.yml"
    cp "$0" "$dir/deploy/test-zcode-config-tag-tree.sh"
    set +e
    out="$(W397_SKIP_REQ_RED=1 GH_EXTRA_URL="$extra" bash "$dir/deploy/test-zcode-config-tag-tree.sh" 2>&1)"
    rc=$?
    set -e
    [ "$rc" -ne 0 ] || { printf 'req %s stayed green\n' "$name" >&2; exit 1; }
    printf '%s\n' "$out" | grep -Fq "$needle" || {
      printf 'req %s missed %s\n' "$name" "$needle" >&2
      exit 1
    }
  }
  req_red target 'repos/$REPO/commits/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' 'request named target'
  req_red gitmodules 'repos/$REPO/contents/.gitmodules' 'request named gitmodules'
fi
use 1 "$(jq -nc '[[{filename:".zcode",status:"modified"}]]')" "$(T "$(E .zcode 160000 commit "$BSHA")")"
gitlink_red
use 1 "$(page README)" "$(T "$(E libs 160000 commit "$BSHA")")"
pr_run 0
use 1 "$(page vendor/.zcode)" "$(T "$(E libs 160000 commit "$BSHA"),$(E vendor 040000 tree "$CSHA")")"
pr_run 0
use 1 "$(jq -nc '[[{filename:".zcode",status:"removed"}]]')" "$ET"
pr_run 0
use 1 "$(jq -nc '[[{filename:"notes.txt",status:"renamed",previous_filename:".zcode"}]]')" "$ET"
pr_run 0
use 1 "$(jq -nc '[[{filename:".zcode",status:"modified"}]]')" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(T "$(E readme 100644 blob "$BSHA")")"
pr_run 0
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(T "$(E config.json 160000 commit "$BSHA"),$(E readme 100644 blob "$DSHA")")"
pr_run 1 "子路径 .zcode/config.json 禁止入库"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(T "$(E deps 160000 commit "$BSHA")")"
pr_run 0
for s in "$BSHA" "$CSHA" "$DSHA"; do
  use 1 "$(page .zcode)" "$(T "$(E .zcode 120000 blob "$s")")"
  pr_run 1 "根路径 .zcode 符号链接禁止入库"
  [ "$(grep -c '/git/trees/' "$REQ")" -eq 1 ]
done
use 1 "$(page .zcode/config.json)" "$ET"
pr_run 1 "检测到 ZCode 项目配置文件变更"
use 1 "$(jq -nc '[[{"filename":".zcode/config.json","status":"removed"}]]')" "$ET"
pr_run 1 "检测到 ZCode 项目配置文件变更"
use 1 "$(page zcode.json)" "$ET"
pr_run 1 "检测到 ZCode 项目配置文件变更"
use 1 "$(jq -nc '[[{"filename":"zcode.json","status":"removed"}]]')" "$ET"
pr_run 1 "检测到 ZCode 项目配置文件变更"
use 2 "$(jq -nc '[[{"filename":"ok.txt\nzcode.json"},{"filename":"zcode.json"}]]')" "$ET"
pr_run 1 "检测到 ZCode 项目配置文件变更"
use 1 "$(page README)" "$(T "$(E zcode.json 100644 blob "$BSHA")")"
pr_run 1 "根路径 zcode.json 禁止入库"
use 1 "$(page README)" "$(T "$(E zcode.json 120000 blob "$BSHA")")"
pr_run 1 "根路径 zcode.json 禁止入库"
use 1 "$(page README)" "$(T "$(E zcode.json 040000 tree "$DSHA")")"
pr_run 1 "根路径 zcode.json 禁止入库"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(T "$(E config.json 100644 blob "$BSHA"),$(E readme 100644 blob "$DSHA")")"
pr_run 1 "子路径 .zcode/config.json 禁止入库"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(T "$(E config.json 120000 blob "$BSHA")")"
pr_run 1 "子路径 .zcode/config.json 禁止入库"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(T "$(E config.json 040000 tree "$DSHA")")"
pr_run 1 "子路径 .zcode/config.json 禁止入库"
GH_META_JSON='{"head":{"sha":"'"$SHA"'"},"changed_files":1}'
GH_FILES_JSON="$(page README)"
GH_TREE_JSON="$ET"
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON
pr_run 1 "元数据畸形"
GH_META_JSON="$(jq -nc --arg sha "$SHA" '{number:1,head:{sha:$sha},changed_files:1.5}')"
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON
pr_run 1 "changed_files 畸形"
GH_META_JSON="$(jq -nc --arg sha "$SHA" '{number:1,head:{sha:$sha},changed_files:-1}')"
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON
pr_run 1 "changed_files 畸形"
GH_META_JSON="$(jq -nc --arg sha "$SHA" '{number:1,head:{},changed_files:1}')"
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON
pr_run 1 "HEAD SHA 畸形"
GH_META_JSON="$(jq -nc --arg sha "$SHA" '{number:1,head:{sha:"abc"},changed_files:1}')"
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON
pr_run 1 "HEAD SHA 畸形"
GH_META_JSON="$(jq -nc --arg sha "$CSHA" '{number:1,head:{sha:$sha},changed_files:1}')"
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON
pr_run 1 "HEAD 与事件不一致"
GH_META_JSON="$(jq -nc --arg sha "$SHA" '{number:2,head:{sha:$sha},changed_files:1}')"
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON
pr_run 1 "PR 号与事件不一致"
GH_META_JSON="$(jq -nc --arg sha "$SHA" '{number:1,head:{sha:$sha},changed_files:3001}')"
GH_FILES_JSON="$(files_n 3000)"
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON
pr_run 1 "changed_files 超过 3000"
! grep -Fq '/files' "$REQ"
use 0 '[]' "$ET"
pr_run 1 "文件响应缺失"
use 200 "$(files_n 100)" "$ET"
pr_run 1 "文件数量与 changed_files 不一致"
use 2 '[[{"filename":"a"},{"filename":"a"}]]' "$ET"
pr_run 1 "文件名重复"
use 1 '[{"filename":"a"}]' "$ET"
pr_run 1 "文件页类型畸形"
use 101 "$(jq -n '[[range(0;101)|{filename:("f"+tostring)}]]')" "$ET"
pr_run 1 "文件页过大"
use 2 '[[{"filename":"a"}],[{"filename":"b"}]]' "$ET"
pr_run 1 "文件页序畸形"
use 1 '[[{"filename":"BAD"}]]' "$ET"
pr_run 0
use 1 '[[{"filename":""}]]' "$ET"
pr_run 1 "文件名畸形"
use 1 '[[{"filename":1}]]' "$ET"
pr_run 1 "文件名畸形"
use 1 '[[{"no":1}]]' "$ET"
pr_run 1 "文件名畸形"
use 0 '[[]]' '{"truncated":true,"tree":[]}'
pr_run 1 "根树畸形或被截断"
use 0 '[[]]' '{"tree":[]}'
pr_run 1 "根树畸形或被截断"
use 0 '[[]]' '{"truncated":"yes","tree":[]}'
pr_run 1 "根树畸形或被截断"
use 0 '[[]]' '{"message":"bad"}'
pr_run 1 "根树畸形或被截断"
use 0 '[[]]' "$(T "$(jq -nc --arg s "$BSHA" '{path:"a",mode:"bogus",type:"blob",sha:$s}')")"
pr_run 1 "根树条目畸形"
use 0 '[[]]' "$(T "$(E a 100644 blob abc)")"
pr_run 1 "根树条目畸形"
use 0 '[[]]' "$(T "$(E a 040000 blob "$BSHA")")"
pr_run 1 "根树条目畸形"
use 0 '[[]]' "$(T "$(E a 100644 blob "$BSHA"),$(E a 100644 blob "$DSHA")")"
pr_run 1 "根树路径重复"
use 0 '[[]]' "$(T "$(E a/b 100644 blob "$BSHA")")"
pr_run 1 "根树条目畸形"
use 0 'not-json' "$ET"
pr_run 1 "文件列表畸形"
use 0 '[[]]' 'not-json'
pr_run 1 "根树畸形"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" '{"truncated":true,"tree":[]}'
pr_run 1 "子树畸形或被截断"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" '{"tree":[]}'
pr_run 1 "子树畸形或被截断"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(T "$(E a 100644 blob "$BSHA"),$(E a 100755 blob "$DSHA")")"
pr_run 1 "子树路径重复"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" 'not-json'
pr_run 1 "子树畸形"
GH_META_JSON="$(jq -nc --arg sha "$SHA" '{number:1,head:{sha:$sha},changed_files:1}')"
GH_FILES_JSON="$(page README)"
GH_TREE_JSON="$ET"
GH_CHILD_JSON=""
GH_META_RC=22
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON GH_META_RC=22
pr_run 1 "元数据失败"
GH_FILES_RC=22
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON GH_FILES_RC=22
pr_run 1 "文件列表失败"
GH_TREE_RC=22
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON GH_TREE_RC=22
pr_run 1 "根树失败"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(T "$(E readme 100644 blob "$BSHA")")"
GH_CHILD_RC=22
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON GH_CHILD_JSON GH_CHILD_RC=22
pr_run 1 "子树失败"
for spec in meta:元数据超时 files:文件列表超时 root:根树超时; do
  phase="${spec%%:*}"
  diag="${spec#*:}"
  use 1 "$(page README)" "$ET"
  clr; export GH_META_JSON GH_FILES_JSON GH_TREE_JSON GH_TIMEOUT_PHASE="$phase"
  pr_run 1 "$diag"
done
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(T "$(E readme 100644 blob "$BSHA")")"
clr
export GH_META_JSON GH_FILES_JSON GH_TREE_JSON GH_CHILD_JSON GH_TIMEOUT_PHASE=child
pr_run 1 "子树超时"
use 0 '[[]]' "$ET"
export GH_TIMEOUT_STUB=1
pr_run 1 "元数据超时"
use 0 '[[]]' "$(jq -nc --arg s "$BSHA" '{truncated:false,tree:[],url:"https://evil.example/git/trees/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}')"
pr_run 0
! grep -Eq 'https?://|recursive=' "$REQ"
# 换行与回车用 jq 编码进完整文件列表和树，不用空树绕过路径检查。
use 2 "$(jq -nc --arg n "$(printf 'notes\nreadme.txt')" --arg c "$(printf 'notes\rreadme.txt')" '[[{filename:$n},{filename:$c}]]')" "$(jq -nc --arg n "$(printf 'notes\nreadme.txt')" --arg c "$(printf 'notes\rreadme.txt')" --arg s "$BSHA" --arg d "$DSHA" '{truncated:false,tree:[{path:$n,mode:"100644",type:"blob",sha:$s},{path:$c,mode:"100644",type:"blob",sha:$d}]}')"
pr_run 0
use 2 "$(jq -nc --arg n "$(printf 'notes\nreadme.txt')" --arg c "$(printf 'notes\rreadme.txt')" '[[{filename:$n},{filename:$c}]]')" "$(jq -nc --arg n "$(printf 'notes\nreadme.txt')" --arg c "$(printf 'notes\rreadme.txt')" --arg s "$BSHA" --arg d "$DSHA" --arg z "$CSHA" '{truncated:false,tree:[{path:$n,mode:"100644",type:"blob",sha:$s},{path:$c,mode:"100644",type:"blob",sha:$d},{path:"zcode.json",mode:"100644",type:"blob",sha:$z}]}')"
pr_run 1 "根路径 zcode.json 禁止入库"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(jq -nc --arg p "$(printf 'notes\nreadme.txt')" --arg s "$BSHA" '{truncated:false,tree:[{path:$p,mode:"100644",type:"blob",sha:$s}]}')"
pr_run 0
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(jq -nc --arg p "$(printf 'notes\nreadme.txt')" --arg s "$BSHA" --arg c "$DSHA" '{truncated:false,tree:[{path:$p,mode:"100644",type:"blob",sha:$s},{path:"config.json",mode:"100644",type:"blob",sha:$c}]}')"
pr_run 1 "子路径 .zcode/config.json 禁止入库"
GH_META_JSON="$(jq -nc --arg sha "$SHA" '{number:1,head:{sha:$sha}}')"; GH_FILES_JSON="$(page README)"; GH_TREE_JSON="$ET"; clr; export GH_META_JSON GH_FILES_JSON GH_TREE_JSON
pr_run 1 "changed_files 畸形"
GH_META_JSON="$(jq -nc --arg sha "$SHA" '{number:1,head:{sha:$sha},changed_files:null}')"; GH_FILES_JSON="$(page README)"; GH_TREE_JSON="$ET"; clr; export GH_META_JSON GH_FILES_JSON GH_TREE_JSON
pr_run 1 "changed_files 畸形"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" "$(T "$(jq -nc --arg s "$BSHA" '{path:"a",mode:"bogus",type:"blob",sha:$s}')")"
pr_run 1 "子树条目畸形"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" '{"truncated":"yes","tree":[]}'
pr_run 1 "子树畸形或被截断"
use 1 "$(page .zcode)" "$(T "$(E .zcode 040000 tree "$CSHA")")" '{"truncated":false,"tree":[]}'
pr_run 0
# 先前路径：出现则必须是非空字符串；renamed 缺字段失败关闭；精确旧路径拒绝。
use 1 "$(jq -nc '[[{filename:"notes.txt",status:"renamed",previous_filename:".zcode/config.json"}]]')" "$ET"
pr_run 1 "检测到 ZCode 项目配置文件变更"
use 1 "$(jq -nc '[[{filename:"notes.txt",status:"renamed",previous_filename:"zcode.json"}]]')" "$ET"
pr_run 1 "检测到 ZCode 项目配置文件变更"
use 1 "$(jq -nc '[[{filename:"notes.txt",status:"renamed",previous_filename:"README"}]]')" "$ET"
pr_run 0
use 1 "$(jq -nc '[[{filename:"notes.txt",previous_filename:""}]]')" "$ET"
pr_run 1 "文件名畸形"
use 1 "$(jq -nc '[[{filename:"notes.txt",previous_filename:1}]]')" "$ET"
pr_run 1 "文件名畸形"
use 1 "$(jq -nc '[[{filename:"notes.txt",status:"renamed"}]]')" "$ET"
pr_run 1 "文件名畸形"
use 1 "$(jq -nc '[[{filename:"notes.txt",previous_filename:null}]]')" "$ET"
pr_run 1 "文件名畸形"
# 隔离整份工作流、标签检查和本脚本。只改副本；嵌套跳过只跳过本块。
if [ "${W394_SKIP_MUTATION:-}" != 1 ]; then
  suite_fail() {
    local name="$1" expr="$2" needle="$3"
    local dir="$TMP/suite-$name" out rc
    mkdir -p "$dir/.github/workflows" "$dir/.github/scripts" "$dir/deploy"
    cp "$CHECKER" "$dir/.github/scripts/zcode-config-tag-tree.sh"
    cp "$0" "$dir/deploy/test-zcode-config-tag-tree.sh"
    sed "$expr" "$WF" > "$dir/.github/workflows/zcode-config-guard.yml"
    set +e
    out="$(W394_SKIP_MUTATION=1 bash "$dir/deploy/test-zcode-config-tag-tree.sh" 2>&1)"
    rc=$?
    set -e
    [ "$rc" -ne 0 ] || { printf 'suite %s stayed green\n' "$name" >&2; exit 1; }
    printf '%s\n' "$out" | grep -Fq "$needle" || { printf 'suite %s missed %s\n' "$name" "$needle" >&2; exit 1; }
  }
  suite_fail child 's|die "子路径 .zcode/config.json 禁止入库"|printf "%s\\n" "变更未触碰危险路径, 通过"|' 'red fail 子路径 .zcode/config.json 禁止入库'
  suite_fail count '/(\$f|length)!=\$n then "count"/d' 'red fail 文件数量与 changed_files 不一致'
  suite_fail prgitlink 's|gitlink) die "根路径 .zcode gitlink 禁止入库"|gitlink) printf "%s" "变更未触碰危险路径, 通过"; exit 0|' 'red fail 根路径 .zcode gitlink 禁止入库'
  tag_suite_fail() {
    local name="$1" expr="$2" needle="$3"
    local dir="$TMP/suite-$name" out rc
    mkdir -p "$dir/.github/workflows" "$dir/.github/scripts" "$dir/deploy"
    sed "$expr" "$CHECKER" > "$dir/.github/scripts/zcode-config-tag-tree.sh"
    cp "$WF" "$dir/.github/workflows/zcode-config-guard.yml"
    cp "$0" "$dir/deploy/test-zcode-config-tag-tree.sh"
    set +e
    out="$(W394_SKIP_MUTATION=1 bash "$dir/deploy/test-zcode-config-tag-tree.sh" 2>&1)"
    rc=$?
    set -e
    [ "$rc" -ne 0 ] || { printf 'suite %s stayed green\n' "$name" >&2; exit 1; }
    printf '%s\n' "$out" | grep -Fq "$needle" || { printf 'suite %s missed %s\n' "$name" "$needle" >&2; exit 1; }
  }
  tag_suite_fail taggitlink '/# 根 gitlink 160000/,/^fi$/s/exit 1/true/' 'tag rootgitlink fixture stayed green'
fi
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
# 执行受保护分支 push step。if 必须同时是 event_name == push 与 refs/heads/，run 必须非 0。echo bypass 必须失败。
assert_branch_push() {
  local step_if step_run
  step_if="$(awk '/name: push 触发即危险/ {p = 1} p && /^        if:/ {print; exit}' "$1")"
  printf '%s\n' "$step_if" | grep -Fq "event_name == 'push'" && printf '%s\n' "$step_if" | grep -Fq 'refs/heads/' || return 1
  step_run="$(awk '/name: push 触发即危险/ {p = 1} p && /^        run: \|/ {r = 1; next} r && /^          / {sub(/^          /, ""); print; next} r {exit}' "$1")"
  printf '%s\n' "$step_run" > "$TMP/push-body.sh"
  bash "$TMP/push-body.sh" >/dev/null 2>&1 && return 1
  return 0
}
assert_branch_push "$WF"
awk '
  /name: push 触发即危险/ {p = 1}
  p && /^        run: \|/ {print; print "          echo bypass"; skip = 1; next}
  skip && /^          / {next}
  { if (skip) skip = 0; print }
' "$WF" > "$TMP/push-bypass.yml"
expect_nonzero assert_branch_push "$TMP/push-bypass.yml"
printf '%s\n' "zcode tag-tree guard ok"
