# REST API reference

**Moved:** this document now lives at https://openagent.email/docs/reference/api/

The website docs are canonical — edit them in the [website repo](https://github.com/openagentemail/website) (`src/content/docs/docs/`).

## OAuth Authorization Server（P3，本仓增量）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 AS 元数据（公开） |
| GET | `/.well-known/oauth-protected-resource` | RFC 9728 PRM；`authorization_servers` = AS issuer |
| GET | `/authorize` | 302 → `/ui/oauth/authorize`（cookie path=/ui） |
| GET/POST | `/ui/oauth/authorize` | 同意页（需 Dashboard 会话）；回跳一律带 `iss`（RFC 9207） |
| POST | `/oauth/token` | `authorization_code` + PKCE S256；`refresh_token` 轮换 |
| POST | `/oauth/revoke` | RFC 7009 |
| GET | `/ui/oauth/grants` | 兼容书签：需 Dashboard 会话，302 → `/ui/configure/clients` |
| GET/DELETE | `/ui/api/oauth/grants[/:id]` | 列表 / 吊销 |
| POST | `/ui/api/oauth/grants/:id/revoke` | 管理页表单吊销（同 origin + session；成功 302 回列表） |

预鉴权 IP 限量（应用层）：`OAUTH_RATE_PER_MIN` 覆盖上表 `/authorize`、`/oauth/token`、`/oauth/revoke`；`MCP_PREAUTH_RATE_PER_MIN` 覆盖 `POST /mcp` 无/坏 token 的 401 挑战。超限 `429` + `Retry-After`。键见 `TRUST_PROXY_HEADERS` / docs/security.md。

不做：DCR（`/oauth/register`）、OIDC discovery、admin 级 OAuth 票。

## Messages API (`GET /v1/messages`) 前向追补合同

### 排序与完整性契约
- **响应内排序**：单次响应内的 `messages` 列表严格按 `(receivedAt, uid)` 元组升序排列（oldest-first）。
- **跨页排序与完整性**：跨页**不承诺全局元组序**（由于 IMAP `APPEND`/`COPY` 历史导入等可能导致非单调 `INTERNALDATE`）；系统承诺的是**完整性**——在当前信箱代际内，严格大于初始传入游标元组的所有匹配邮件，每封恰好送达一次（无损追补，不重不漏）。
- **游标连续性与永不为 null**：`since` 前向查询的 `nextCursor` **永不返回 null**。当候选集全部扫尽或单批未达 `limit` 时，仍返回携带已检视最新进度 `scanUid` 的 checkpoint 游标，供客户端后续轮询继续向后追补，杜绝因回退重用旧游标而引发的终批邮件重复投递。
- **消费方自排**：对全局有序有强依赖的消费方，应遵循 RFC 0001 §8.4 口径，在消费端按 `(data.receivedAt, data.uid)` 进行二次排序。
- **代际保护**：游标严格绑定 `uidValidity`；若信箱代际变更（UIDVALIDITY 不匹配），请求将 fail-closed 返回 `400 invalid_cursor`。`GET /v1/messages/:id` 支持可选的 `?uidValidity=` 参数，代际不匹配时返回 `404 stale_message_generation`。
- **服务端 SINCE 与 receivedAtMs 口径差异说明**：服务端 IMAP SEARCH SINCE 依据 RFC 3501 `INTERNALDATE` 检索（向前预留 1 天缓冲）；应用层 `receivedAtMs` 优先采用 `INTERNALDATE` 并回落至 `ENVELOPE.date`。若个别邮件缺失 `INTERNALDATE` 且其 `ENVELOPE.date` 晚于实际收信时间，此口径差异为 fail-safe（只漏不越权，后续追扫覆盖）。

