# Changelog

All notable changes to this project are documented here, one section per release, newest first.

## Unreleased

### Added

- **Audit: `\Seen` write paths emit `message.mark_seen`** (#152): successful `POST /v1/messages/:id/seen` and `POST /ui/api/messages/:id/seen` append scrubbed audit rows (`messageId`/`seen`); UI rows include `ip`. Read paths gain FakeImapFlow gold tests asserting zero `messageFlagsAdd`/`Remove` (with a write-path control). MCP `mail_mark_seen` copy no longer nudges shared-mailbox agents to mark seen blindly.

### Fixed

- **Tasks: create(wait=true) 错误响应分层** (#183)：SMTP 发送成功后 wait/journal 失败不再误报裸 `502 smtp_error`。未创建仍为 `502 {error:"smtp_error"}`（无 id）；已创建后 journal 错 → `503 {error,taskId,created:true}`，其他等待异常 → `502` 同 body，`429 too_many_waits` 补 `taskId`。MCP client/`task_create` 透出 `taskId` 并提示用 `task_get`/`task_list` 查、勿重新 create。
- **Webhooks: stale delivery-list cursors are rejected** (#216): `GET /v1/webhooks/:id/deliveries` no longer silently rewinds to page 1 on an unknown cursor; it returns **HTTP 400 `{error:"invalid_cursor"}`**, matching send-log / notify / task cursor semantics.
- **Dashboard: recover pagination after a stale mail cursor** (#196): load-more clears `nextCursor` on **400 `invalid_cursor`** and prompts Refresh (other errors leave the cursor alone). `GET /ui/api/messages` now maps codec cursor failures to **`invalid_cursor`** (schema failures remain `invalid_request`), so the UI recovery path is live for inbox as well.

## v0.7.3 — 2026-09-13

### Added

- **Signed webhook wake receiver example** (`examples/webhook-wake/`): a ready-to-run "doorbell" endpoint that verifies openagent.email webhook signatures and wakes your agent runtime when mail arrives — the reference piece for wiring webhooks into agent fleets (#172, #176).

### Fixed

- **Long waits re-arm correctly instead of hot-looping** (#203, #206): after an early 408, `mail_wait_for` could re-issue waits in a tight loop. Waits now re-arm cleanly under the caller's timeout budget.
- **Cancellation and revocation now win deterministically** (#204, #206): revoking a delegated wait mid-wait returns 403 (revoked), never a misleading 499/408; client disconnects free the wait slot immediately — including while DNS resolution is still in flight — and post-disconnect logout can no longer hang until the deadline.
- **Tasks: pending-lease journal + claim_lost + postponed expiry audit** (opt-in): `TASK_LEASES_PENDING_JOURNAL` (default false, requires `TASK_LEASES_ENABLED`) persists conservative pre-SMTP generation fences, admin-signed `claim_lost` after 2h, and records or defers expiry-audit work. Production expiry-audit SMTP emission remains hard-disabled pending a separate commander-approved card; the journal flag is not an emitter opt-in. Upgrade readers before the first tombstone; old-binary rollback after the first `claim_lost` is unsafe (#80, #84; #181).
- **Tasks: signed expiry receipts for accepted deadline windows** (#156, #185).
- **API: per-caller rate limit on GET /v1/messages** (#192).
- **API: backward mail cursors are bound to the mailbox generation** (#195): cursors can no longer silently page into a rebuilt mailbox.

## v0.7.2 — 2026-09-09

### Added

- **Webhook env wiring for compose deployments**: all 22 webhook configuration keys are now wired through the API service in `compose.yaml` and `compose.api-only.yaml`, with `.env` examples — compose-based installs can enable and tune the outbound webhook subsystem without touching code. Safe defaults preserved: signing secrets stay `undefined` when unset, explicit empty/short values are rejected, and the public-edge guard keeps `private=false` (#149, #174).

### Fixed

- **Tasks: bound public-read lease overlay replay** (opt-in): public read projections cap lease overlay replay at 15 minutes, preventing unbounded replay on read paths. Disabled by default — enable with `TASK_LEASES_OVERLAY_BOUND=true` (#80, #84; #171).
- **Tasks: decouple reclaim from expiry-audit SMTP** (opt-in): lease reclaim no longer depends on the expiry-audit mail path, with late-receipt tolerance. Disabled by default — enable with `TASK_LEASES_EXPIRY_AUDIT_M3=true` (#80, #84; #167).

### Tests

- Webhook quota and latest-delivery IO contract regression coverage: exact read/byte accounting under real compose rendering, including negative controls (#146, #173).

## v0.7.1 — 2026-09-08

### Fixed

- **MCP stdio clean boot**: v0.7.0 crashed on startup in a clean client environment — an import chain pulled the mail server's env schema (`DOMAIN`/`API_KEYS`/IMAP/SMTP) into the MCP bundle before the handshake. Scope constants moved to a config-free leaf module; the stdio client now boots with only `OPENAGENTEMAIL_API_URL` + `OPENAGENTEMAIL_API_KEY` (#168, #169).

### Notes

- Regression guard added: `packages/mcp/test/clean-boot.test.ts` runs an initialize + tools/list handshake against the built bundle with all server-side env removed, wired into CI.

## v0.7.0 — 2026-09-07

### Added

- **Multi-domain identities**: serve several domains from one instance via `DOMAIN` + `EXTRA_DOMAINS` (#133).
- **Revocable mailbox delegation ACLs**: delegate scoped mailbox access to other identities, revocable at any time (#125, #135; hardening follow-ups #136, #151).
- **Outbound webhook subsystem**: notify your own endpoints on mailbox events — shared pinned fetcher with SSRF hardening (incl. IPv6-embedded-IPv4), process-wide event dispatcher with per-sink watermark isolation, forward-`since` query with `uidValidity` generation precondition (#128 PR1–PR4: #140, #141, #142, #145).
- **Approval expiry projection**: list/board views now project unmaterialized approval expiry with signed display metadata, so "waiting on you" never lies about the deadline (#75, #160).
- **Bookmarkable admin UI login** via `?token=` query, hardened with a one-time exchange-code flow (#131, #132/#150).
- **Read-only identity token scopes** enforced across the API (#124); OAuth access-token resolution now inherits identity scopes (#129).

### Fixed

- **Transport-level exact dedup** for lease claim/renew/release events: byte-identical authenticated duplicates are accepted as no-ops, any divergence fails closed (#85, #158).
- **Authorization-read isolation**: REST and dashboard share one authorization-read surface that never materializes expiry on a reject path (#76, #83, #101; #153).
- Task API hardening: children cursor length cap, case-insensitive participant matching, mutation responses share the parent ACL projection, MCP task output schema aligned with the durable-id predicate (#103, #107; #159).
- Review follow-ups batch (#130, #148) and test isolation hardening (#147).

### Notes

- All changes dogfooded on our own instance before release; full test suite green (1459 tests).
- Follow-ups already tracked: #155–#157, #161–#163. #80/#84 (lease overlay bounds / audit retry queue) were sent back for redesign after review surfaced a design-level conflict — they will return in a future release.
