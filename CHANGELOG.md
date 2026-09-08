# Changelog

All notable changes to this project are documented here, one section per release, newest first.

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
