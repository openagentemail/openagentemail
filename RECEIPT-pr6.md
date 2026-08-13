# RECEIPT — #26 阶段2 · PR 6

日期：2026-08-13  
工位：`/home/ops/orca/workspaces/openagentemail/worker-34-pr1`  
分支：`tizerluo/worker-34-pr6`（禁动 main；基线 `608cbb2`）  
PR：（push 后填写）

## 交付

设备管理完整闭环：registry 落盘、create 补 displayName、list/revoke 的 UI + Bearer API、Push & Devices 面板（列表 / 添加引导 / 一次性 QR）、吊销 `pending_revoke` 对账。Trust-30d / cookie `Path=/ui` / Origin / 全局 body-limit 未改。现有 tier 三卡逻辑未改。

**平台运营主体口径（未发明新 Auth kind）：** 现网 `Auth` 只有 `admin | identity`。设备 API 仅 `kind === 'admin'`；其余一律 403。identity 已有测试。不能把非 admin 解释为 admin。

## 范围 8 条对账（ADR §PR 6）

| # | 范围 | 结果 | 证据 |
|---|---|---|---|
| 1 | registry：DATA_DIR 0600；serial queue；同目录 rename；崩溃/磁盘满/只读/corrupt 启动+运行测试与健康告警 | **过** | `packages/api/src/lib/notification-devices.ts`；测试见下表 |
| 2 | create 补 displayName，现有 ntfy user 创建路径接入 registry | **过** | `createNotificationDevice({ displayName? })` → `registerPairedDevice` |
| 3 | list/revoke UI + Bearer；admin 限定；identity 与非 admin 403 | **过** | `/v1/notify/devices` + `/ui/api/notify/devices` |
| 4 | Push 面板：列表（名称/频道语义/配对时间）+ 添加引导 + 一次性 QR；tier 三卡不动 | **过** | `push-devices.ts`；`handleConfigurePushTier` 切片测试仍绿 |
| 5 | 吊销一致性：pending_revoke；启动对账；404/not_found → revoked；步骤 1 失败不碰 ntfy；步骤 3 失败重试收敛；重复 DELETE 204 | **过** | 见吊销测试名 |
| 6 | 登记失败 best-effort 删 ntfy user | **过** | `registry persist failure after ntfy create deletes the ghost user and returns 502` |
| 7 | password/token 只展示一次；磁盘零明文；文件 0600 | **过** | token-style modal + grep 测试 |
| 8 | 旧 POST `{ publicUrl }` 零破坏 | **过** | `old POST without displayName still 201 and identity cannot list or revoke` |

## 验收对账

| 项 | 结果 | 证据 |
|---|---|---|
| 创建凭据只展示一次，DATA_DIR grep 无 password/token | **过** | UI：`Copy this password now. It will not be shown again.`（`UI_HTML`）；关窗 `devicePairPassword.textContent = ''`。磁盘：`successful create never writes password to DATA_DIR` 对 `process.env.DATA_DIR` walk，断言不含明文 password 且无 `"password":`；registry `register writes 0600 JSON with no password or token keys`（`stat.mode & 0777 === 0600`） |
| 列表有名称/频道语义/配对时间 | **过** | `topicLabels.userAlerts === 'User alerts'` / `userLow === 'User low'`；UI `topicSemantics` + `Paired ` + `formatDate(pairedAt)`；Bearer `Curl-phone` + `pairedAt` |
| 吊销后 ntfy user 立即失效（curl / 测试环境） | **过** | 工位无真实 ntfy。测试环境：`identity cannot GET or DELETE devices; admin revoke is 204 including repeats and ntfy 40031` — admin DELETE 触发 `DELETE …/v1/users`，现网缺失 user 形态 HTTP 400/`code:40031` 当成功，本地 `revoked`；重复 DELETE 不再打 ntfy（`deletes.length === 1`）、仍 204 |
| pending_revoke 对账：not_found 收敛 revoked；磁盘满/只读/404 幂等齐 | **过** | 见下「吊销测试名」 |
| 登记失败无幽灵 user | **过** | `registry persist failure after ntfy create deletes the ghost user and returns 502`：ENOSPC hook 后断言存在 `DELETE /v1/users` |
| identity / 平台运营主体 → 403 | **过** | Bearer：`old POST… identity cannot list or revoke` + `identity cannot GET or DELETE devices…`；UI：`identity session cannot list, create, or revoke devices`。平台运营主体：现网无独立 operator kind，非 admin 即 403（见上口径） |
| 旧 POST 兼容 | **过** | `old POST without displayName still 201…`；registry `old clients without displayName get the default Phone name` |
| `cd packages/api && bun test` + `bun run build` | **过** | **777 pass / 0 fail**；`bun run build` Bundled 568 modules，全绿 |

### 吊销测试名（notification-devices.test.ts）

- `step 1 persist failure never calls ntfy delete`（ENOSPC）
- `readonly volume on pending persist does not reach ntfy`（EROFS）
- `ntfy 404 / not_found is idempotent success and converges to revoked`
- `repeat DELETE on already revoked is already_revoked and does not call ntfy`
- `step 3 persist failure leaves pending_revoke; retry/startup not_found converges`
- `transient ntfy failure keeps pending_revoke for retry`
- `startup inspect + reconcile scans pending_revoke`
- `corrupt file fail-closes instead of wiping the registry`
- `crash tmp next to an intact store is discarded on inspect`

## 风险缓解对账

### 设备吊销一致性

落实 ADR 五步：① 先写 `pending_revoke`，落盘失败不调 ntfy；② 现网 ntfy 缺失 user = HTTP 400 / code 40031 / "user does not exist"（及 HTTP 404）= 成功，网络/5xx = `transient`（`classifyNtfyUserDeleteResponse` 不得把泛 400 或网络错误当 not_found）；③ 再写 `revoked`；④ 启动 `inspectDeviceRegistry` + `initializeNotifications` → `reconcilePendingRevokes`；列表/吊销入口先 reconcile；⑤ 列表默认隐藏 `revoked`，`pending_revoke` 对 admin 显示「Revoking…」。

### DATA_DIR 单写者

所有 device mutation 走同一 `enqueue` 队列；temp 与目标同目录；未引入第二写者。日志/console 告警不含 password。`GET /healthz` 仍不读该文件。

## 实现备注（非分叉，不拦合并）

- QR：服务端 `encodeQrModules(JSON.stringify(qrPayload))`（ECC M，零新依赖）；UI `canvas` 画模块（禁止 `innerHTML` / `createElementNS` / 外链图）。copy 字段始终可用。若 ntfy 官方扫码 JSON 键名与本 payload 不完全一致，用户仍可手输 server/user/password。
- 未改 `.env`。未提交 `.mimosa/`。

## 独立自审

- **禁止自审自。** 第一轮 agent id：`31cf837a-1968-4df0-a08a-37ae937c0a18`
  - 结论当时：**not mergeable**（P0 0 / P1 1）
  - 过程：对照 ADR 吊销五步与现网 ntfy `handleUsersDelete`；发现只认 HTTP 404 会把 40031 当 transient，步骤 3 落盘失败后对账无法收敛。
- **P1 已修后再审。** 第二轮（新 subagent，禁止自审自）agent id：`f4f57ed2-fb04-4537-8791-e4d1e37c74ca`
  - 结论：**mergeable**
  - P0/P1：**0**
  - 过程：独立核对 `classifyNtfyUserDeleteResponse` 对 40031 / 404 / 200 / 503 / 40024；步骤 1 失败不碰 ntfy；步骤 3 失败 + not_found 收敛；已 revoked 不打 ntfy；启动 inspect+reconcile；幽灵 user DELETE；identity 403；旧 POST；一次性密码关窗清空；modal 代际。相关测试当时 121 pass。
  - 残余（不当作 finding）：5xx 响应体若碰巧含 `user does not exist` 会被当成成功（真实 ntfy 不太会）；幽灵 user 清理是 best-effort；40031 收敛由分类器测试 + registry 收敛测试拼接。


## 布局自测说明（1280 / 375；线上截屏由指挥做）

未开真浏览器拍屏。依据 shell + CSS：

- **1280 桌面：** Push 三卡 `repeat(auto-fit, minmax(220px, 1fr))` 保持；其下 `Paired devices` 段。设备行 `.device-row` 两列（meta + Revoke，`min-height: 44px`）。Add device 在 heading 右侧（admin 显示）。添加窗普通 `modal-card`；一次性凭据窗 `modal-card-wide`（≤560px）含 QR 白底 + server/user/password copy。
- **375 / ≤820px：** 设备行改 block，Revoke 全宽 44px；wide modal 收到 440px；三卡 `min-height: 44px` 未改。identity 会话 CSS 隐藏 `#configure-push-add`，JS 不拉设备列表。
- 指挥请拍：设备列表、添加引导、一次性 QR、吊销确认、tier 三卡回归。拍屏指引见下一节。

---

## 本地起服务拍屏指引（合并前总指挥必看）

工位仓库：`/home/ops/orca/workspaces/openagentemail/worker-34-pr1`  
分支：`tizerluo/worker-34-pr6`。不要切 `main`。

### 1. 临时目录与 mock ntfy

真 ntfy 在工位通常没有。用一个只回答 users API 的 mock（2586）即可拍到列表 / QR / 吊销。

```sh
WORKDIR=/tmp/oae-pr6-shot
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR/data" "$WORKDIR/ntfy"
chmod 700 "$WORKDIR/data"

# mock ntfy：POST/ACL 200；DELETE 默认 404（幂等成功，便于吊销立刻失效）
cat > "$WORKDIR/mock-ntfy.ts" <<'EOF'
const users = new Set<string>();
Bun.serve({
  port: 2586,
  fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/v1/users') {
      return req.json().then((body: { username?: string }) => {
        if (body.username) users.add(body.username);
        return new Response('', { status: 200 });
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/users/access') {
      return new Response('', { status: 200 });
    }
    if (req.method === 'DELETE' && url.pathname === '/v1/users') {
      return new Response('not_found', { status: 404 });
    }
    return new Response('ok', { status: 200 });
  },
});
console.log('[mock-ntfy] :2586');
EOF
bun "$WORKDIR/mock-ntfy.ts" &
```

若要拍到列表里的「Revoking…」行：把 mock 的 DELETE 改成 `return new Response('', { status: 503 })`，再重启 API 后点 Revoke（步骤 2 会停在 `pending_revoke`）。

### 2. 起 dev API（端口 3100，临时 DATA_DIR）

```sh
cd /home/ops/orca/workspaces/openagentemail/worker-34-pr1/packages/api
PORT=3100 \
DOMAIN=shot.test \
API_KEYS=shot-admin-key \
IMAP_USER=agent@shot.test \
IMAP_PASS=shot-imap \
SMTP_USER=agent@shot.test \
SMTP_PASS=shot-smtp \
DATA_DIR="$WORKDIR/data" \
NTFY_ENABLED=true \
NTFY_INTERNAL_URL=http://127.0.0.1:2586 \
NOTIFY_PUBLIC_URL=https://notify.shot.test \
NTFY_ADMIN_PASSWORD=shot-ntfy-admin \
NTFY_UPSTREAM=false \
bun run --watch src/main.ts
```

浏览器打开 `http://127.0.0.1:3100/ui`（必须是这个 origin，cookie `Secure` 在 localhost http 关闭）。登录框填 `shot-admin-key`，勾选 Remember 可选。Cookie 名 `oae_ui`，`Path=/ui`，HttpOnly。

也可用 curl 造会话（之后把 `oae_ui` 贴进浏览器或继续用 curl）：

```sh
curl -sS -D - -o /dev/null \
  -H 'content-type: application/json' \
  -H 'origin: http://127.0.0.1:3100' \
  -d '{"token":"shot-admin-key","remember":true}' \
  http://127.0.0.1:3100/ui/api/session
```

### 3. 造一台已配对设备

登录后打开 Configure → Push & Devices → **Add device** → 可选 Display name（如 `Kitchen phone`）→ Create credentials。应出现一次性密码 + QR。然后：

```sh
# 磁盘零明文（指挥可复跑）
grep -R -n -E 'password|token' "$WORKDIR/data/notification-devices.json" || echo 'no password/token keys'
python3 - <<PY
from pathlib import Path
p = Path("$WORKDIR/data")
blob = "\n".join(f.read_text(errors="ignore") for f in p.rglob("*") if f.is_file())
assert '"password"' not in blob and '"token"' not in blob
print("DATA_DIR walk: no password/token keys")
PY
```

Bearer 等价：

```sh
curl -sS -D - \
  -H 'authorization: Bearer shot-admin-key' \
  -H 'content-type: application/json' \
  -d '{"publicUrl":"https://notify.shot.test","displayName":"Kitchen phone"}' \
  http://127.0.0.1:3100/v1/notify/devices
```

### 4. 造 pending_revoke 样例（不经 UI）

API **必须先停**（单写者；不要和运行中的 API 抢同一文件），写入后重启：

```sh
cat > "$WORKDIR/data/notification-devices.json" <<'EOF'
{
  "schemaVersion": 1,
  "devices": [
    {
      "id": "dev_aaaaaaaaaaaaaaaaaaaaaaaa",
      "displayName": "Kitchen phone",
      "ntfyUsername": "phone-kitchen1",
      "topics": { "userAlerts": "user-alerts-shot", "userLow": "user-low-shot" },
      "pairedAt": "2026-08-13T08:00:00.000Z",
      "lastSeenAt": null,
      "revokeStatus": "active",
      "revokedAt": null
    },
    {
      "id": "dev_bbbbbbbbbbbbbbbbbbbbbbbb",
      "displayName": "Lost phone",
      "ntfyUsername": "phone-lost0001",
      "topics": { "userAlerts": "user-alerts-shot", "userLow": "user-low-shot" },
      "pairedAt": "2026-08-01T08:00:00.000Z",
      "lastSeenAt": null,
      "revokeStatus": "pending_revoke",
      "revokedAt": null
    }
  ]
}
EOF
chmod 600 "$WORKDIR/data/notification-devices.json"
```

- mock DELETE=404：重启后启动对账会把 `Lost phone` 收敛成 `revoked`（列表默认不再显示）。
- mock DELETE=503：`Lost phone` 保持「Revoking…」，可拍中间态。
- 点 Kitchen phone 的 Revoke → 确认框文案含设备名。

### 5. identity 403 对照（可选）

用 identity token 登录同一 `/ui` 后进 Push：无 Add device，文案 “Only the instance admin can manage paired devices.”；`GET /ui/api/notify/devices` 应 403。

### 6. 拍完关掉

停 API 与 mock ntfy；`rm -rf /tmp/oae-pr6-shot`。不要把临时 DATA_DIR 提交进仓库。
