# #56 R1 — task claim/lease architecture map and RED boundary

## Baseline and scope

- Baseline verified before edits: `HEAD` and `origin/main` are both
  `448798255abe71faef9b2bc929b0cefe142b166e`; `git status --short` was empty.
- This is #56 R1 only. The test/design delta deliberately does not touch
  production, config, UI, documentation, #74, #75, or #76.

## Current architecture/path map

| Concern | Existing path and authority | #56 integration point |
| --- | --- | --- |
| Durable task history | `packages/api/src/lib/tasks.ts`: server-stamped `X-OA-Task*` SMTP events are parsed from the catch-all IMAP mailbox; `taskFromMessages()` rebuilds each task in IMAP UID order. | Add an authenticated, server-stamped lease event form. It contains event type, actor, expiry, generation, a keyed non-bearer verifier, and reason where applicable; it never contains the bearer lease token. Parser accepts only canonical event payload plus its HMAC stamp. |
| Read/rebuild and short-term overlay | `findTaskMessages()` → `parseTaskMessage()` → `taskFromMessages()`; `getTaskSnapshot()` merges the existing 60-second queued-event overlay after SMTP acceptance. | Rebuild derives durable audit/timing/generation plus the private keyed verifier. Before expiry it validates a presented token by recomputing the verifier; at/after expiry the lease is inactive even if no reaper has yet emitted an audit event. Overlay follows the same private-authority/redaction rules. |
| Per-task serialization | `withTaskLock()` at `tasks.ts:968`; `updateTaskUnlocked()` exists specifically for callers already holding the lock. `replyTask`, `remindTask`, `closeTask`, and approval expiry/decision use it. | Claim, renew, release, state update, and admin close must acquire this same lock once, re-read the durable+overlay snapshot under it, then validate and append exactly one event. No nested lock acquisition. |
| REST task boundary | `packages/api/src/routes/tasks.ts`, mounted in `packages/api/src/app.ts` at `/v1/tasks`; identity auth, live-identity check, and participant ACL are here. | Add `POST /:id/claim`, `/lease` (renew), `/release`; extend state body with optional `leaseToken`. Route maps core lease errors without exposing secret material. |
| MCP client and registry | `packages/api/src/mcp/client.ts`, `packages/api/src/mcp/tools.ts`; shared by stdio `packages/mcp/src/main.ts` and HTTP `/mcp` in `packages/api/src/mcp/http.ts`. | Add `task_claim(id, leaseSec?)`, `task_renew(id, leaseToken, leaseSec?)`, and `task_release(id, leaseToken, reason?)`; keep output schemas separately token-bearing only for claim and token-free for task projections. |
| Public projections | REST list/detail currently serialize task objects directly; dashboard uses `toUiTaskView()` in `tasks.ts`; MCP advertises `taskOutputSchema` from `mcp/tools.ts`; UI task client reads REST task views. Mail event headers/bodies, notification delivery, webhook/email source, logs, and all list/detail payloads are public/redacted surfaces. | Centralize a token-free `TaskLeaseView` / task projection before all of those surfaces. Claim response is the sole secret-delivery response. No raw task, event, queued overlay, error object, audit line, notification or logging object may carry `leaseToken`. |
| Configuration patterns | `packages/api/src/lib/config.ts` parses env once at boot; tests use `parseConfig`. | Add `TASK_LEASES_ENABLED`, default `false`. When false, ordinary `POST /state` preserves its current ACL/state-machine behavior even if it carries an optional `leaseToken`; claim/renew/release return `409 task_leases_disabled` without mutation. |
| Test seams | `setTaskNowForTests`, `setTaskGetForTests`, `setTaskListAllForTests`, `setTaskSendMailForTests`, `clearQueuedEventsForTests` in `tasks.ts`; `createApp({taskService})` and `createTaskRoutes({service})` are existing route seams. | Use injected server clock for every expiry/reaper boundary; inject persistence/event delivery and use real routes/MCP registration, never source-string assertions. |

## Exact R1 contract decisions

| Area | Decision |
| --- | --- |
| Event representation/authentication | A lease audit event is a versioned canonical payload included in a dedicated `X-OA-Task-Lease-*` header set and HMAC-stamped by a domain-separated `taskSigningSecret` recipe. Required durable fields: `event` (`claim`, `renew`, `release`, `expired`, `admin-close`), `actor`, `at`, `generation`; claim/renew add `claimedUntil` and private `tokenVerifier = HMAC(taskSigningSecret, taskId \| generation \| leaseToken)` with a distinct domain separator; release/admin-close may add bounded reason. Parser rejects event/header/payload disagreement, bad actor/participant relation, non-finite time, non-monotonic generation, or a bearer `leaseToken` field. Mailbox history is authoritative only when this stamp validates. |
| Secret and restart | The random high-entropy bearer `leaseToken` remains absent from email/header/body/log/list/detail/UI/notification/webhook/error surfaces. The canonical stamped event persists only its keyed non-bearer verifier. After restart, while `now < claimedUntil`, the server recomputes the verifier for a presented token and preserves that lease's validity/exclusivity. At `now >= claimedUntil`, a new claim increments generation; old token/verifier are stale. The verifier is private authority and must never enter a public projection. |
| Claim behavior | When enabled, only `task.to` may claim. Under the task lock, a submitted task becomes working, exactly one unexpired lease may win, and a successful claim returns `LeaseGrant`: `{task: TaskView, leaseToken, claimedUntil, leaseGeneration}`. A concurrent/non-expired claim is `409 lease_already_claimed`; terminal or admin-closed is `409 task_not_claimable`; outsider is `403 lease_recipient_required`. |
| Renew/release behavior | Both require the current unexpired token verifier and recipient actor under the lock. Renew changes expiry but not generation and is idempotent for identical retry identity (correlation remains unresolved). Release is idempotent for the current lease; success records a server-stamped release audit event and returns a token-free `TaskView`. Token mismatch/stale generation is `409 stale_lease`; malformed/missing token is `400 invalid_request`; non-recipient is `403`. |
| Fencing | The server maintains a monotonically increasing generation per task under the same lock. On claim/reclaim it increments. State update for an active lease requires a matching token; the server resolves generation through the keyed verifier, then rejects `409 stale_lease` before any SMTP write. A stale worker cannot complete/update after a reclaim. Generation is public, non-authoritative metadata. |
| State-update compatibility | `leaseToken` alone is optional in `POST /v1/tasks/:id/state` and in `task_update`; it does not send a public generation field. With `TASK_LEASES_ENABLED=false`, it is accepted and ignored and current participant behavior remains unchanged. With enforcement enabled, no active lease preserves current behavior; an active lease requires a matching lease credential for worker-originated state updates. |
| Admin close | Human/admin close acquires the same lock, appends its normal terminal close plus a token-free lease/admin-close audit event, invalidates the current lease/generation, and is auditable. It may override an active lease. The admin identity/actor representation remains an unresolved policy detail. |
| Expiry/reaper | All comparisons use injected server clock. Any claim/renew/state-mutating read observes expiry under lock. A reaper scans task snapshots and appends one stamped `expired` audit event for an expired lease; it must be idempotent and not delay reclaim. Rebuild treats `now >= claimedUntil` as unexpired=false regardless of reaper progress. |
| HTTP/MCP schemas | `leaseSec` defaults to `300` and accepts integer `30..3600` inclusive. REST claim body: `{leaseSec?: integer}`; renew: `{leaseToken: string, leaseSec?: integer}`; release: `{leaseToken: string, reason?: string}`. MCP equivalents have the card-specified positional fields. With leases disabled, direct claim/renew/release return `409 task_leases_disabled` without mutation. Claim is the only response with `leaseToken`; renew/release/state/list/detail/MCP task outputs expose at most `claimedUntil: ISO \| null` and `leaseGeneration: integer \| null`, never the verifier. |

## Lock order / linearization

```
route authentication + shape validation
  -> route ACL pre-check (not relied on for concurrency)
  -> withTaskLock(taskId)
       -> rebuild durable IMAP + queued overlay
       -> expiry observation / reaper event if required
       -> re-check ACL, terminal/admin-close and current generation
       -> validate presented token by recomputing the private verifier when required
       -> append stamped event / queue redacted overlay
       -> mutate/replace active verifier+generation state only after durable send acceptance
  -> redact to REST/MCP/UI/public task projection
```

`replyTask`, `closeTask`, approval decision/expiry, and ordinary `updateTask` must enter at the indicated lock point; they must call an unlocked helper once inside it rather than re-enter `withTaskLock`.

## R1 RED tests added

- `packages/api/test/task-leases-red.test.ts` calls `createTaskRoutes()` through real Hono requests. It independently freezes recipient-only claim ACL + two concurrent claims (`200`/`409`), optional `leaseToken` compatibility on `/state` while disabled by default, and list/detail timing+generation projection with secret redaction.
- `packages/mcp/test/tools.test.ts` uses actual `registerOpenAgentEmailTools()` through the stdio entrypoint. Inventory and schema checks independently fail with named assertions and return before any missing-tool dereference.
- `packages/api/test/mcp-http.test.ts` calls actual `/mcp` `tools/list`. Inventory/count and claim input/output schema are separate behavior-level REDs; the schema test reports a named missing-tool contract rather than being masked by the inventory failure. The test distinguishes the sole claim response bearer from the private verifier, which must never be advertised.

## Next GREEN rounds: exact deeper matrix

| Round | Fixture/seam | Assertion |
| --- | --- | --- |
| R2 | Deterministic `now=2026-08-24T00:00:00Z`, two Hono recipient claim requests held at the same post-lock barrier; in-memory durable event sink records accepted sends. | Exactly one `200 LeaseGrant`, one `409 lease_already_claimed`, one claim event, working state, generation 1, and event bytes contain no bearer token while canonical private authority contains only the domain-separated keyed verifier. |
| R2 | Created submitted task; requester, recipient, outsider, terminal task, and `closed_by_admin` task fixtures. | Claim ACL/status matrix: recipient 200; outsider 403; requester 403; terminal/admin-close 409; disabled switch returns the agreed unavailable/compatibility result without state mutation. |
| R3 | One claim token at generation 1; advance test clock to `claimedUntil - 1ms`, then `claimedUntil`; a second claimant reclaims at equality. | Before expiry renew succeeds; at equality old lease is inactive; reclaim generates 2; old token state update and terminal completion both return `409 stale_lease`, write no SMTP event, and cannot alter rebuilt state. |
| R3 | Current-lease retry fixture with explicit request-id/idempotency key selected by final API; run identical renew/release requests twice through REST and MCP. | The same current operation result is returned twice, no duplicate audit event, release leaves no active lease, and foreign/stale/malformed token errors never echo any token. |
| R4 | Send mail capture, IMAP raw-source capture, task list/detail/UI task view, MCP list/get/tool error payload, notification and webhook/email-source fixtures containing an adversarial token string and the computed verifier. | Recursive serialized public JSON/text scan proves no public/redacted projection contains either bearer token or verifier; only the immediate claim response contains the token. `claimedUntil` and generation remain visible where contract permits. |
| R4 | Claim at generation 1 with deterministic token, stop service, rebuild solely from stamped raw event at `claimedUntil - 1ms`; present old token to renew/update and attempt a second claim. Advance to exactly `claimedUntil`, then claim again. | Before expiry the recomputed verifier accepts old-token renew/update and the second claim is `409 lease_already_claimed`; at equality a new claim succeeds at generation 2; old token is `409 stale_lease`. Persisted raw source has verifier but never bearer token; neither is publicly projected. |
| R5 | Admin close races a held recipient renew/state update under the existing lock; use server clock and captured event ordering. | One linearized terminal admin close, lease invalidated, later worker operation is 409 and writes nothing; history shows auditable admin override without secret. |
| R5 | Real `/mcp` tools/call for claim/renew/release and REST counterparts with valid/invalid schema boundaries. | MCP schemas reject bad UUID/seconds/tokens before loopback; REST maps `400/403/404/409` identically by contract; responses satisfy advertised output schemas. |

## Unresolved choices requiring maintainer decision

1. How an otherwise idempotent renew is correlated without persisting a bearer secret: explicit idempotency key, unchanged expiry for repeated same input within a window, or another authenticated request identity.
2. Exact reaper scheduling and whether its auditable expiry event is emitted on first touch or by a periodic scan; expiry authority remains server time either way.
3. The durable representation of an admin actor.

## R4 RED/design decision table (2026-08-25)

| Question | Candidate contract | Status/evidence |
| --- | --- | --- |
| Repeated renew correlation | Explicit idempotency key | Preferred test contract: same authenticated key returns the same result and emits no duplicate event; requires maintainer/API choice because the current request has no key. |
| Repeated renew correlation | Token rotation | Not sufficient by itself to distinguish a retry from a later same-parameter request; do not encode as a RED assertion without approval. |
| Repeated renew correlation | Other authenticated identity | Requires a specified durable identity and replay window; unresolved. |
| Release replay | Durable authenticated verifier/audit marker recognizing the already-released generation without retaining the bearer | Must be proven in GREEN; an in-memory map is explicitly rejected. |
| State-token enforcement | Enabled: missing, malformed/foreign, and stale prior-generation token fail before mutation; disabled: optional token remains accepted/ignored | Frozen R4 REDs cover both branches and preserve the existing disabled positive control. |

Without maintainer selection of an authenticated correlation policy, strict repeated-renew identity and its exact idempotency test cannot be made honest.

## R4b RED/design correction (2026-08-25)

The opt-in route matrix was split into independent named cases: A1 disabled renew, A2 disabled release, B1 enabled foreign/stale state token, D1 renew projection/event, and D2 release projection/durable replay. Each uses the real Hono route seam and records the selected-service mutation counter. The current implementation produces five expected RED failures (the lease routes are not registered and state-token enforcement is not yet active), while the four pre-existing claim/projection controls remain green. No route-404 result is treated as deeper behavior evidence; route absence is recorded only as the current route-existence blocker for the renew/release cases.

The deeper GREEN matrix remains explicitly frozen for a production-core adapter: deterministic server-time generation-1 claim, `claimedUntil - 1ms` validity, equality expiry and generation-2 reclaim, independent stale-token fencing across renew/release/state/terminal completion, current-generation success, restart/rebuild from stamped events, and bearer-free private/public projections. Until those exported core seams exist, the corresponding assertions are policy/design requirements rather than copied test logic. Release replay requires a durable authenticated representation and no in-memory map. Strict repeated-renew identity remains policy-blocked pending maintainer choice among explicit idempotency key, token rotation, or another authenticated correlation identity.

## R4c executable staging (2026-08-25)

Executable now: the opt-in route-entry matrix contains independent A1–A21 cases for disabled renew/release, requester/outsider ACL, malformed UUID/JSON, token shape, lease-second bounds, selected-service capability isolation, and valid recipient call mapping; plus the deterministic claim/equality/rebuild authority baseline using the real core seams. The current route absence or inactive enforcement is reported as the observed RED mismatch for each case, never as deeper behavior evidence.

Blocked until route/core GREEN exists: renew/release event semantics, stale fencing across renew/release/state/terminal completion, current-generation operation success, and durable same-token release replay. Policy-blocked separately: repeated-renew retry identity pending maintainer choice among explicit idempotency key, token rotation, or another authenticated correlation identity.

## R4d test-only correction (2026-08-25)

The route harness now injects a test-only structural service with explicit `renew` and `release` methods that record operation/input and return a token-free task view. Only the two missing-capability cases select the original service without those methods. Route `lease` is mapped to the `renew` operation and `release` to `release`; each case uses one composite `{ status, selectedCalls }` assertion so current route absence cannot mask call-count evidence. No production type or behavior was changed.

## R5b production-core RED boundary (2026-08-25)

The opt-in `TASK_LEASES_R5B_RED=1` matrix uses the real production `taskService` and real Hono route registration with deterministic clock, delivery capture, parser, rebuild, and queued-overlay seams. It independently observes renew/release current/stale paths, equality generation fencing, stale state and terminal writes, current-generation state controls, durable release replay, restart rebuild, captured-event alteration rejection, and recursive bearer/verifier surface scans. Every case emits one composite status-plus-side-effect observation so the current deliberate `lease_service_unavailable` boundary and the current unenforced stale state writes remain visible without a bootstrap or `TypeError` substitute.

The test suite intentionally does not assert repeated-renew same-response identity or invent a retry identity. That remains policy-blocked until a written durable authenticated correlation choice—preferably an explicit `idempotencyKey`—is made. Release replay is separately retained as a settled durable contract.

## R5c test-only evidence correction (2026-08-25)

The opt-in R5b durable release-replay observation now parses the original captured claim and release with the production parser before rebuilding a fresh task solely from `submittedRaw + parsed claim + parsed release`. It records both parses, successful rebuild, and absence of an active lease, clears overlays, uses only that rebuilt task for the same-token/same-reason replay, and requires the original successful release, exactly one release delivery, equal successful closed replay body, and exactly claim-plus-one-release total delivery. At the frozen production `503` boundary these remain visible RED observations without a null dereference or fallback authority.

The captured renew/release relation proof now derives each altered relation in memory from its already parser-authenticated `RawTaskMessage`, changing only its outer `from`/`to` participant/actor relation while retaining the parsed payload and authentication result. Each variant is passed to `taskFromMessages` with the original submitted request and parsed claim, and the composite requires rebuild rejection. Existing raw payload/header/time/bearer alteration checks and non-monotonic rejection remain unchanged; no HMAC is forged or reimplemented. Strict renew replay identity remains policy-blocked.

## R6a independent REDs (2026-08-25)

The opt-in `TASK_LEASES_R6_RED=1` matrix adds three real-route, real-core RED observations while preserving every R1–R6 case. Each begins with a separately asserted authenticated production setup and keeps status, delivery, and rebuild facts in a single final composite observation.

1. With the same generation's claim, renew, and release all still in the queued overlay, the durable fixture is advanced to expose all three parser-authenticated events without clearing that map. Durable authority is correctly released, but the indexed release currently drops only its own overlay: the older queued **claim and renew overlays** are reapplied and renew reactivates the lease. The RED requires the public read to remain released and a same-token/same-reason replay to return the identical closed view with no fourth delivery. A later-generation indexed control is intentionally omitted because this same-generation ordering seam isolates the defect without widening scope.
2. An early `leaseSec=30` renew of a 300-second lease is schema-valid but cannot extend its existing expiry. The durable parser already rejects that non-monotonic renew history; the current core instead accepts and delivers it. The RED requires route-level fail-closed `409`, one claim-only delivery, unchanged current authority, and a rebuildable original signed claim/history.
3. A deterministic 1,001-character release reason must follow the established ordinary release/rebuild/same-reason replay contract. The accepted R3a route schema has no invented reason cap, but the current core rejects this input at 1,000 before delivery. The RED requires authenticated release parsing and released rebuild, `200`/`200` first/replay responses with equal closed bodies, and exactly claim-plus-one-release delivery. No replacement maximum is proposed.

Minimal GREEN design only: make queued-event suppression dominance-aware so an indexed same-generation release also suppresses its prior claim/renew overlays; reject a renew before delivery whenever `now + leaseSec` is not strictly later than the active `claimedUntil`; and remove the core/parser's unapproved 1,000-character release-reason threshold without selecting a new cap. No GREEN implementation is part of this round.

## R6a1 mechanical public-view correction (2026-08-25)

The indexed-release RED's released public expectation is corrected to `claimedUntil: null` and `leaseGeneration: null`; durable replay generation remains private in `releasedLease`.

## R6c test-only correction (2026-08-25)

After reproducing the sole R5b/R6 failure as `24/1/74`, the named R5b secrecy/redaction test alone now sends its existing renew request with `leaseSec: 301`. At the fixed clock this makes `now + 301s` strictly later than the fixture's active `now + 300s` expiry; it restores the existing six `200` statuses without changing operation order, fixture, assertions, bearer/verifier checks, release, or the strict-extension boundary. Proof: combined R5b/R6 `25/0/74`, full R5b `26/0/88`, R6a `12/0/61`, R5a `35/0/104`, R2b `13/0/75`, and MCP `33/0/335`; API and MCP TypeScript checks passed. Production is untouched by R6c.

R6b `durableOrdered` normalizes each lease message's effective date to authenticated `lease.at` before selecting the current message, building `messages`, and computing `updatedAt`. That preserves equality between the immediate release response (whose synthetic event uses `at`) and the later durable IMAP replay even if mail transport dates differ. It applies only to lease-bearing ordinary-task messages; non-lease messages and the separate approval branch retain their original dates/order.

## R6d RED/design (2026-08-25)

`TASK_LEASES_R6_RED=1 bun test test/task-lease-core.test.ts` is `12 pass / 1 intentional fail / 62 expect() calls`. The new real-route seam claims generation 1 for 300 seconds, renews it 30 seconds later for 300 seconds, parser-rebuilds durable authority from submitted + claim + renew, and changes only the injected durable read while retaining the real queued overlay. At one millisecond after the original expiry and before the renewed expiry, rebuilt authority remains generation 1 at `2026-08-24T00:05:30.000Z`; the queued earlier claim instead rewinds real detail to `2026-08-24T00:05:00.000Z`, making release `409` with two deliveries rather than the required `200` and three. Minimal GREEN design only: for an active durable authority with matching generation and verifier, treat an authenticated queued claim/renew as indexed or superseded when durable `claimedUntil >=` the queued event expiry; mismatched verifier, later queued expiry, different generation, and release handling remain fail-closed/unchanged.

## R6e GREEN (2026-08-25)

For matching active generation and verifier only, queued claim/renew indexing now compares authenticated expiry instants monotonically (`durable >= queued`); R6d is `13/0/62` and the combined R5b/R6 core gate is `26/0/75`.

## R7a idempotency RED/design (2026-08-25)

Ruling B is now represented only by the opt-in real-route/core/overlay matrix: a current unexpired token with candidate expiry `<=` active expiry (early `leaseSec=30` and omitted/default equal candidate) must return the identical token-free task snapshot with the original expiry/generation, claim-only delivery, and no second authenticated lease event; both currently expose the intended `409 stale_lease` RED. Immediate same-token/same-reason release replay is a green control (`200` identical closed snapshot, claim plus one release delivery), while a different reason remains `409`. Minimal future GREEN: after recipient/current/unexpired validation and candidate calculation, return the current view before any event, delivery, notification, cache, or overlay write whenever candidate `<= active claimedUntil`; strict extension retains normal renewal. No idempotency key or protocol surface was added.

## R7b idempotency GREEN (2026-08-25)

Ruling B is implemented only in `renewTask`: after the recipient/current/unexpired authority check and candidate expiry calculation, a candidate `<=` the active expiry returns the unchanged current snapshot before constructing a renew event or invoking delivery, notification, cache invalidation, or queued-overlay mutation. Strict extensions retain the existing signed-renew path. The R7b core gate is `15/0/64`; R5b, isolated R4/R2, ordinary tasks, and MCP regressions remain green. No idempotency key or protocol surface was added; release remains same-token/same-generation/same-reason replay only.

## R8a admin-close override GREEN proof (2026-08-25)

`task-lease-admin-override.test.ts` is an isolated real-production-seam proof: a real generation-1 recipient claim is current, then an authenticated `UiSessionStore` admin cookie invokes the exact mounted `POST /ui/api/tasks/:id/close` route with a participant-selected `from`. No `taskService.close` is injected or mocked. The response is `200 failed` with exactly `{ closed_by_admin: true, reason }`, emits exactly claim plus one signed close delivery, projects neither bearer/verifier nor public lease timing/generation, and parser-rebuilds from submitted + authenticated claim + authenticated close as terminal with no active/released authority. The old bearer is then fenced by the established distinct `409` boundaries for state (`task_already_terminal`), renew/release/reclaim (`task_not_claimable`) with zero further deliveries; a second UI close is `409 task_already_terminal` with no audit delivery. Identity close is `403`; admin missing/non-participant `from` each return the existing `400` boundary before a close delivery. Recursive captured mail/rebuild/public/error/warning scans contain neither bearer nor verifier. The current generic-admin credential model has no further authenticated actor identity to persist; the server-stamped terminal result plus explicit participant `from` is therefore a sufficient auditable record within the existing model, and no new identity field/event version is introduced.

## R8a1 evidence correction (2026-08-25)

The two live-claim setup calls in `task-lease-admin-override.test.ts` now invoke the shipped `taskService.claim(...)` registry object rather than a direct named import; `taskService.close` remains neither injected nor mocked. The R8a API package-wide `bunx tsc --noEmit` accounting is clarified: it must be reported as the documented nonzero package baseline when present, with zero diagnostics naming `task-lease-admin-override.test.ts`; it is not evidence of package-wide API TypeScript green. MCP local TypeScript remains a required passing gate.

R8a1 follow-up type correction: the test uses an `import('hono').Hono` type query rather than the dynamic-import value as a type, and each shipped-registry claim has a fail-closed `taskService.claim` presence assertion before the direct `taskService.claim(...)` invocation. Package-wide API `tsc` remains exit `2` only for pre-existing diagnostics outside this test; all diagnostics naming `task-lease-admin-override.test.ts` are zero.

## R8b explicit server lease reaper RED/design (2026-08-25)

`packages/api/test/task-lease-reaper-red.test.ts` is a new, standalone Bun-process RED using the shipped `taskService.claim` registry, injected server clock, production send seam, production parser, rebuild, per-task lock, and queued overlay. It claims generation 1, parser-rebuilds it from captured authenticated mail, clears the overlay to model restart, advances to exactly `claimedUntil`, then reclaims generation 2 through the same registry. The one composite desired observation requires one parser-authenticated `expired:1` audit delivery ordered between `claim:1` and `claim:2`, with durable rebuild retaining generation-2 authority and no generation-1 bearer in captured mail, public projection, or warnings. Current production is the sole intended RED: `3 pass / 1 fail / 11 expect()`; its final comparison observes only `['claim:1', 'claim:2']`, `deliveries: 2`, and no expiry audit, while generation 2 is current and generation 1 is fenced. Green controls prove: at one millisecond before equality no second claim/delivery occurs; terminal and `closed_by_admin` tasks are non-claimable with zero delivery; and an old generation-1 bearer is rejected after equality reclaim without a third delivery. No source-string assertion, fake event, copied task implementation, private-map inspection, skip, or missing-registry/parser bootstrap stands in for the failure.

### Minimal future GREEN design — not implemented

1. Add one exported/internal `materializeLeaseExpiryUnlocked(current)` that is callable only while holding `withTaskLock(id)`. It re-reads the durable-plus-overlay snapshot, returns unchanged unless an ordinary nonterminal active lease satisfies `now >= claimedUntil`, and writes/queues exactly one durable expiry receipt. Both equality reclaim and a future scan call this helper inside the same lock before their own mutation; claim then re-reads the resulting receipt so generation 2 cannot pass the receipt. This mirrors the existing approval `materializeApprovalExpiryUnlocked` pattern, but must not be hidden in a public read: it is explicit server recovery.
2. Prefer a new canonical, versioned **lease** event `expired` with `{ version, event, generation, tokenVerifier, claimedUntil, expiredAt }`, domain-separated HMAC over task id/state/envelope/payload, and a server-controlled actor/envelope representation. It must not carry a bearer and parser/rebuild must reject bad stamp, noncanonical keys, mismatched task/generation/verifier, replay across task or participants, an `expiredAt < claimedUntil`, or an expiry after release/terminal/admin close. Reusing the existing lease envelope is smaller and preserves one event ordering stream; a separate generic task event is less invasive to the lease union but weakens the generation/verifier binding and duplicates authentication. **Maintainer decision required:** the present envelope validation forces every lease event's actor to be the worker/recipient, which would falsely attribute server expiry. Choose either a fixed non-worker server principal plus an explicit parser exception, or a server-authored event sent as the requester with a distinct `actor: 'server'`; do not silently choose an attribution model.
3. Delivery is before overlay/memory mutation. Only after accepted SMTP does the helper queue its synthetic event; if SMTP fails it returns/throws without receipt and the next loop/reclaim retries. If SMTP accepts but IMAP indexing lags, the queued authenticated event dominates its expired claim/renew overlay; `eventIsIndexed` gains an expiry branch, and indexed receipt dominance removes all same-generation prior authority overlays. A durable receipt, not an in-memory map, provides restart-safe exactly-once semantics; after a failed index read, repeat snapshot/rebuild detects the receipt before any second send.
4. Preserve current paths: unexpired renew remains unchanged; release replay remains its durable receipt behavior; terminal/admin close cannot materialize expiry; leases-disabled startup does not start the loop; ordinary non-lease and approval tasks remain unchanged. The helper should reject/no-op before side effects for each of those cases.
5. `main.ts` currently starts retention via `startRetentionLoop()` before notification maintenance. A future `startLeaseExpiryReaper()` should follow its bounded, `unref()` interval, initial-grace, per-tick try/catch failure-isolation pattern, but enumerate lease snapshots and invoke only the locked helper. The issue/card does not authorize a cadence/config knob. Safest narrow default is a fixed bounded interval local to the reaper (with `unref`, no overlap, and a short post-boot first tick); maintainer must approve its value, or explicitly authorize a new lease-reaper config, before implementation. It must not reuse retention-days/hours: retention deletes mail whereas expiry materializes authority.

### Required future RED/GREEN matrix

| Scenario | Required proof |
| --- | --- |
| Pre-expiry / equality / delayed tick | no audit or second claim before equality; equality and late scan emit exactly one expiry then reclaim; late scan preserves `expiredAt`/ordering. |
| Restart | SMTP-accepted/indexed expiry rebuilds from signed raw mail alone; no in-memory receipt is needed and no duplicate audit is sent. |
| Reaper vs reclaim | shared lock produces exactly one expiry receipt before generation-2 claim in either arrival order. |
| Reaper vs renew/release/admin-close | linearized winner is auditable; valid pre-expiry renew prevents expiry, release/admin-close prevents reaper audit, and the loser writes nothing. |
| SMTP/index failure | failed SMTP writes no overlay/receipt and retries; accepted SMTP plus lag yields one queued audit that dominates old overlay until indexed. |
| Parser tamper/replay | altered payload/stamp/task/generation/verifier/envelope or duplicate UID/event fails rebuild and cannot attribute an expiry to the worker. |
| Duplicate index | repeated IMAP visibility and queued-to-index transition preserve one receipt, one audit message, and generation-2 authority. |
| Secret redaction | recursive mail, REST/UI/MCP/public/error/log scans contain neither bearer nor verifier; only the claim response carries its bearer. |

## R8c GREEN — server expiry receipt and fixed reaper (2026-08-25)

R8c implements written ruling A from verified internal-mail mirror #943 (`snd_0f0674bb`): `actor: 'server'` is canonical signed lease-expiry authority while the requester-to-recipient mail envelope is transport only. The version-1 `expired` event binds generation, the then-current `claimedUntil`, and server `at`/`expiredAt`; it carries neither bearer nor verifier. Parser/rebuild accepts it only at the matching current generation/window, leaves the non-secret `expiredLease` receipt needed for restart generation progression, and rejects a participant actor even when it has a newly valid HMAC. The single lock-held materializer is shared by equality reclaim and `reapExpiredTaskLeasesOnce`; SMTP precedes queued overlay state, failed delivery is retryable, and queued receipt dominance makes equality reclaim immediate before IMAP index visibility.

`task-lease-reaper.ts` owns only lifecycle: `TASK_LEASE_REAPER_INTERVAL_MS = 60_000` is explicitly fixed because #56 requires recovery but not configurability, starts from `main.ts` only when leases are enabled, is unref'd, single-flight, and catches one round's failure before later rounds. Focused behavior is `9/0/23`: equality ordering/rebuild/fencing; pre-expiry and terminal controls; server actor/envelope negative control; bearer+verifier scans; SMTP retry/index-lag; reaper/reclaim/renew/release/admin-close lock ordering; fixed cadence, overlap, failure recovery, and a real child-process unref proof.

## R8c1 frozen core-test correction (2026-08-25)

Verified correction card SHA-256: `4ac6f28410f50ffce95acf6d4b6d34943333b34cb4aac605ccd33a9b1b0402de`. FC independently confirmed all seven prior R6/R5b reds were stale captured-SMTP expectations, each exactly one delivery short because the authorized equality receipt is now ordered `claim:1 → expired:1 → claim:2`. The only mechanical test changes are: R2 queued-authority delivery `2→3` plus production-parser rebuild of the intervening expiry mail; four R5b equality stale-operation totals `2→3`; and one restart total `3→4`. Status, generation, state, stale-token, pre-expiry, renew/release, and secret assertions are unchanged. Gates return R6 `15/0/64`, R5b `22/0/68`, and focused R8c `9/0/23`.

## R8d reviewer RED — expiry duplicate/stale durability and exact races (2026-08-25)

Verified reviewer card SHA-256: `072f2e8c7d6c614b9867b55b08b167712496fbf524e07d185c995f545f798442`. Test-only changes retain the real `startTaskLeaseReaper()` child but correct its bounded deadline from 1.5s to 5s and assert its measured exit is below that bound; FC's observed ~2.3s natural exit is therefore no longer a false red. Focused result is `12 pass / 2 intended fail / 29 expect()`.

The two intentional RED composites use only captured production-signed mail plus the production parser/rebuild. `claim1 → expiry1 → exact duplicate expiry1` currently returns no rebuilt task, rather than a valid inactive generation-1 receipt that can reclaim generation 2. `claim1 → expiry1 → claim2 → late duplicate expiry1` likewise returns no rebuilt task rather than preserving current generation-2 bearer authority and fencing generation 1. A separately signed same-generation expiry with changed `claimedUntil`/`expiredAt` parses as a signed shape but is correctly rejected by rebuild, remaining green. Exact-boundary reaper-versus-renew/release tests prove stale operation, one expiry audit, and inactive authority; exact-boundary admin-close accepts either lock winner only with terminal final state, at most one expiry, and a following no-op reaper. Production remains frozen; the missing duplicate/stale dominance is the only requested future GREEN.

## R8e narrow GREEN — exact durable expiry duplicates (2026-08-25)

`taskFromMessages()` now retains a local per-generation map of expiry receipts that were successfully applied during the authenticated rebuild. The first expiry retains its existing server actor, active-generation/window, and time checks, then records its exact `{ generation, claimedUntil, expiredAt }` receipt. A later expiry is ignored only when all three fields exactly match that earlier applied receipt. The receipt map is intentionally retained across a later claim, so a late duplicate of generation 1 cannot clear generation 2 authority. Any timing/window mismatch, first/stale expiry without the exact receipt, or parser/authentication failure remains fail-closed. No overlay, scheduler, materializer, public projection, mail delivery, token, or verifier path changed.

Focused R8d is now `14/0/29`; frozen R8a, R6, R5b, lease-route, and ordinary-task gates remain `2/0/23`, `15/0/64`, `22/0/68`, `4/0/20`, and `9/0/22` respectively. The scoped `tasks.ts` TypeScript and MCP TypeScript checks pass. API package-wide TypeScript retains only its established unrelated baseline diagnostics and has none naming `tasks.ts` or R8e.

## R8f reviewer finding — exact duplicate still changes public projection (2026-08-25)

FC independently reproduced every R8e gate and the final fingerprint, then compared complete `toTaskView(...)` values from identical authenticated histories with and without an exact duplicate expiry. Rebuild authority is now valid, but the duplicate remains in `durableOrdered` and the public `messages` array: the baseline has 3 messages and the duplicate history has 4, so the public views are unequal. R8e therefore is not accepted as complete because its card explicitly required the ignored duplicate not to alter public messages/state/timestamps. R8f is test-only: two null-safe REDs must freeze adjacent and post-generation-2 exact duplicates as publicly invisible while retaining generation-2 authority and fencing generation 1; production remains frozen pending FC review.

## R8f reviewer RED — public projection of exact expiry duplicates (2026-08-25)

Two additional production-parser/rebuild REDs compare complete `toTaskView(...)` values rather than internal authority. Both authenticated rebuilds succeed. For `submitted → claim1 → expiry1`, replaying the exact parsed expiry at a later UID keeps the inactive generation-1 bearer fenced and state/`updatedAt` unchanged, but expands public messages from 3 to 4 and makes the full views unequal. For `submitted → claim1 → expiry1 → claim2`, the late exact generation-1 replay preserves current generation-2 authority and fences generation 1, with unchanged state/`updatedAt`, yet expands messages from 4 to 5 and makes the full views unequal. Focused result: `14 pass / 2 intentional fail / 31 expect()`; the only failures are the public-view equality contracts. No production or GREEN change was made.

## R8g narrow GREEN — exact duplicate public projection (2026-08-25)

The authenticated rebuild keeps a local identity set only for raw expiry messages that already passed the R8e exact prior-receipt branch. Authority validation still consumes every authenticated event. In the ordinary-task branch alone, that exact identity set is removed before `durableOrdered`, current selection, public `messages`, and `updatedAt` are built. The original expiry remains visible; no generation-only, body, or unauthenticated deduplication exists. Approval reconstruction, parser/HMAC, queued overlay, materializer, delivery, reaper, routes, and public projections outside this ordinary durable rebuild remain unchanged.

The R8f focused file is now `16/0/31`. Frozen R8a, R6, R5b, lease-route, and ordinary-task gates remain `2/0/23`, `15/0/64`, `22/0/68`, `4/0/20`, and `9/0/22`; MCP and scoped `tasks.ts` TypeScript checks pass. API package-wide TypeScript retains only its established unrelated baseline and has no diagnostics naming `tasks.ts` or `task-lease-reaper`.

## R9 final-surfaces RED/proof — dashboard, MCP calls, and shipped docs (2026-08-25)

The real cookie-session dashboard route receives an ordinary participant-readable task containing private lease authority plus adversarial bearer/verifier-shaped extra keys. List and detail remain `200` and correctly omit all private keys/values, but both omit the permitted public `claimedUntil`/`leaseGeneration` projection. The actual served `tasks.js` fake-DOM renderer likewise keeps both secret strings out of rendered text and does not label an inactive task, but it renders no neutral `Claimed until` indication for a public active lease in either detail or list.

The real production HTTP MCP transport is GREEN: identity-bound `task_claim`, `task_renew`, and `task_release` invoke only the selected service callbacks with exact identity-bound arguments, schema-invalid claim stops before a callback, and output exposes the opaque bearer only from claim while renew/release carry no verifier. Shipped documentation remains RED: root/package MCP docs lack the three exact lease signatures, opt-in/default-disabled compatibility, and bearer secrecy wording; `docs/security.md` still advertises 16 tools and does not classify all three lease tools as contained. Narrow results are UI `34 pass / 2 intentional fail / 159 expect()` and MCP `23 pass / 1 intentional fail / 101 expect()`; only those three final-surface contracts fail. No production or GREEN change was made.

## R9 remaining acceptance surfaces — test-only dispatch (2026-08-25)

After FC independently accepted R8g, production is frozen again. R9 may add only behavior evidence for: dashboard list/detail closed projection of `claimedUntil`/generation without lease secrets; exact served dashboard rendering of the claimed-until indicator with an inactive negative control; real HTTP MCP `tools/call` execution of claim/renew/release with selected-service identity binding and claim-only bearer return; and shipped README/security inventory for the three exact issue signatures, opt-in compatibility, secrecy, 19 tools and contained tier. Existing #55 approval docs remain required. Any missing behavior must remain RED until a separate GREEN authorization.

## R10 GREEN authorization — final dashboard/docs surfaces (2026-08-25)

FC independently reproduced R9. The only behavior gaps are the dashboard's missing permitted lease timing and shipped docs still describing the pre-#56 inventory. Real MCP claim/renew/release execution is already green and remains frozen. R10 may add only the explicit public timing fields to the closed UI projection, a neutral served-UI “Claimed until” indication with inactive/secret negatives, its mechanical JS hash pin, and exact 19-tool/contained/default-disabled/bearer-secrecy documentation. No lease controls, claimant identity, new protocol field, runtime MCP change or broader UI redesign is authorized.

## R8g GREEN authorization — projection-only duplicate removal (2026-08-25)

FC independently reproduced the R8f result and accepted both tests as the missing R8e contract. The only authorized GREEN is to retain an entry identity when the existing authenticated exact-receipt duplicate branch succeeds, then omit only that entry before ordinary-task current-message/public-message/`updatedAt` projection. The first expiry stays visible and every non-exact or unauthenticated event retains existing fail-closed behavior. Tests, parser/HMAC, overlay, materializer, delivery, reaper, routes, UI, MCP and docs remain frozen.

## R10 narrow GREEN — dashboard claimed-until and 19-tool docs (2026-08-25)

The UI board/detail type is now `TaskView & TaskOverdue`, and its explicit allowlist adds `claimedUntil` plus `leaseGeneration` only when the active private lease supplies both. The served task renderer shows the neutral literal `Claimed until` with the exact public timestamp and generation in both list and detail, and emits no lease indication for inactive/incomplete data. It adds no controls, claimant identity, bearer, verifier, or unknown-key serialization.

The root and package MCP tables now document the exact claim/renew/release signatures. Both state that leases are opt-in and default-disabled with `TASK_LEASES_ENABLED=false`, retain existing-client compatibility, and confine the opaque `leaseToken` bearer to claim response output rather than listing, rendering, logging, or email. Security now presents the current 19-tool inventory and classifies all three lease tools as `contained`, while retaining every prior tier and the #55 approval entry. The sole UI bundle SHA pin was mechanically updated; R9 tests and all MCP runtime/client/tool paths stayed frozen.

R10 gates are green: UI `36/0/159`, MCP HTTP `24/0/101`, UI real-files/hash `4/0/31`, R8 `16/0/31`, R8a `2/0/23`, R6 `15/0/64`, R5b `22/0/68`, lease routes `4/0/20`, and ordinary tasks `9/0/22`; MCP tsc and scoped authorized production checks pass; package-wide API tsc retains the established unrelated baseline and has zero diagnostics naming R10 authorized production paths. No external or worker-to-FC action was attempted.

## R17 GREEN — owner-approved 8,000-character release reason (2026-08-25)

Mail #996 supersedes the earlier no-cap ruling only for release reason. The sole source of truth is exported `TASK_LEASE_REASON_MAX_CHARS = 8_000`; route `releaseLeaseSchema` and `releaseTask` both use it. Route shape rejection returns the existing `400 invalid_request` before service lookup/invocation, delivery, event, or queue work. Core direct bypass rejects with the existing `invalid_request` before acquiring/mutating authority, delivery, or queue state. No truncation or new error surface exists.

The 8,000-character production wire proof captures the real release `SendInput`, serializes it through nodemailer stream transport, and parses the resulting RFC 5322 source through the production task parser before durable rebuild. Its canonical base64url lease payload is 10,908 characters, RFC-folded on the wire and exactly unfolded; production parser and released rebuild each restore the original 8,000-character reason. The established 1,001-character replay control additionally asserts exact parser and rebuild reason restoration, first `200`, same-token/same-reason replay `200` with an identical closed body, and only claim plus one release delivery. The 8,001 route and direct-core negatives are side-effect-free. No queue/TTL, claim, expiry, token/verifier, projection, or other protocol path changed.
