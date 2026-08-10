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
| GET | `/ui/oauth/grants` | 已授权客户端管理页 |
| GET/DELETE | `/ui/api/oauth/grants[/:id]` | 列表 / 吊销 |
| POST | `/ui/api/oauth/grants/:id/revoke` | 管理页表单吊销（同 origin + session；成功 302 回列表） |

不做：DCR（`/oauth/register`）、OIDC discovery、admin 级 OAuth 票、公网暴露（P4）。
