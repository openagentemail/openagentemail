# #55 typed approval tasks — R1 architecture map and RED contract

Task: `b3f3b030-b5f4-4545-b5de-02f3b3290bf1`
Scope: #55 only. This is a design/RED checkpoint; it makes no production change.

## Current architecture map

| Concern | Current owner | Relevant boundary |
|---|---|---|
| Durable task model / state machine | `packages/api/src/lib/tasks.ts` | `Task`, `TaskMessage`, `RawTaskMessage`; messages are IMAP-backed and `taskFromMessages()` rebuilds the thread. |
| Server event provenance | `packages/api/src/lib/tasks.ts` | `taskStamp()` / `parseTaskMessage()` validate `X-OA-Task*`; result JSON is carried in the textual message body. |
| Atomic task mutations | `packages/api/src/lib/tasks.ts` | `withTaskLock()` wraps `updateTask`, `replyTask`, `remindTask`, and `closeTask`; queued overlays prevent an IMAP-indexing race from reopening a just-written state. |
| REST task API / ACL | `packages/api/src/routes/tasks.ts` | `/v1/tasks`, `/:id`, `/:id/state`; `actorAddress`, `known`, and `taskParticipants` enforce existing managed-identity and participant rules. |
| REST client + MCP | `packages/api/src/mcp/client.ts`, `packages/api/src/mcp/tools.ts` | Client mirrors task routes; MCP exposes `task_create`, `task_list`, `task_get`, and `task_update` with independently broadcast output schemas. |
| Dashboard | `packages/api/src/routes/ui.ts`, `packages/api/src/ui/client/pages/tasks.js` | Cookie ACL mirrors task participants. The client builds nodes with `textContent`, so it has a safe rendering primitive already; current actions are reply/remind/close only. |
| Push previews | `packages/api/src/lib/notify.ts`, `packages/api/src/lib/notification-watcher.ts` | Server-originated task mail invokes `notifyTrustedAgentDelivery()` (address-only). Generic IMAP arrival preview is constructed in `processWatchedMessage()`. |
| Fixtures / seams | `packages/api/test/tasks.test.ts`, `task-board.test.ts`, `ui-tasks.test.ts`, `notification-watcher.test.ts`, `mcp-http.test.ts`, `packages/mcp/test/tools.test.ts` | Task get/send/clock/list seams and route-local mock services exist; tests are the correct place to extend them, not a new store. |

## Smallest additive persisted event model

Ordinary tasks remain byte-for-byte compatible: `kind` is absent and their existing stamp/parser path is unchanged.

An approval request is an optional generic task creation shape:

```ts
{
  kind: 'approval',
  to: reviewer,                 // requester is the authenticated `from`
  subject,
  body?,
  approval: {
    action: { type, name, arguments },
    expiresAt: ISO_8601_UTC
  },
  wait?
}
```

The server rejects equal requester/reviewer and unknown managed identities before it writes. It canonicalizes `action` as UTF-8 JSON with recursively lexicographically sorted object keys, preserved array order, and no whitespace; SHA-256 over those UTF-8 bytes is the lower-case hex `digest`. It stores the canonical action plus `{ reviewer, expiresAt, digest }` in a marked, parseable initial task-message body. The initial approval event carries a versioned approval header containing the digest and an approval-specific HMAC stamp. On rebuild, the parser recomputes the digest from the action and discards the event if it differs or its approval stamp is invalid. This prevents a body-only tamper from changing the displayed/executed snapshot.

The only approval mutation is:

```ts
POST /v1/tasks/:id/decision
{ from?: reviewer, decision: 'approved' | 'rejected' }
```

Identity tokens derive `from`; admin requests must explicitly name the reviewer. The service, not the route, acquires the existing per-task lock and then re-reads the task/queued overlay. Inside that one critical section it verifies all of: approval kind, requester != reviewer, caller == stored reviewer, task is `input-required`, and `now < expiresAt`. It writes exactly one terminal, approval-specific signed event referencing the original digest:

```ts
{ decision: 'approved' | 'rejected', digest, reviewer, decidedAt }
```

`approved` and `rejected` are `completed`; expiry is a server-written `failed` event with `{ decision: 'expired', digest, expiredAt }`. A decision after expiry first records/observes expiry, then returns a conflict; any second/concurrent terminal decision returns `409 task_already_decided`. A generic `/:id/state` update must reject approval tasks, so it cannot bypass this decision gate. `waitForTerminal()` stays unchanged and returns the terminal structured result to the requester once the signed event is visible or in its queue overlay. OpenAgentEmail records this decision only; it never invokes `action`.

### IMAP/stamp detail

Keep the current task headers for ordinary threads. For approval messages add an explicitly versioned metadata header (containing only `kind`, `event`, and `digest`) and calculate a distinct HMAC domain over `id`, state, participants, event, and digest. The large canonical action remains in the signed-by-digest marked body, not an RFC header. Rebuild accepts only:

1. one valid immutable request snapshot whose recomputed digest matches its stamped digest; then
2. its first valid decision/expiry event whose digest equals that snapshot digest.

All later decision events are retained as non-authoritative evidence only if they are validly stamped; the reconstructed task always uses the first valid terminal event. The live per-task lock prevents the server from emitting more than one in the normal case, while this replay rule is fail-safe for mailbox duplication.

## REST, MCP, dashboard, and notification surface

- Extend `task_create` / `OpenAgentEmailClient.createTask` additively with optional `kind: 'approval'` and the typed `approval` object; ordinary callers retain the current `{to, subject, body, wait}` contract.
- Add `task_decide` / `OpenAgentEmailClient.decideTask(id, decision)` instead of overloading `task_update`. Its output is the existing task shape extended additively with `kind?: 'approval'` and `approval?: { action, reviewer, expiresAt, digest }` plus the structured terminal result.
- Dashboard UI API gets `POST /ui/api/tasks/:id/decision`. It uses the authenticated reviewer (or an admin-selected reviewer), delegates to the same service method, and maps already-decided/expired to 409.
- For approval detail, render action type/name and a `<pre>`/table built exclusively with `textContent`; never use `innerHTML`. Native `<button type="button">Approve</button>` and `<button type="button">Reject</button>` provide Enter/Space keyboard operation, must have explicit accessible labels, and use the same decision route.
- Trusted task notification remains address-only. The generic watcher must recognize valid approval task mail and use a fixed approval preview (subject/status/digest is acceptable), never any serialized action `arguments` or body snapshot.
- MCP output schemas must include all new optional approval fields, and its tools/list count/contract test must be updated deliberately. No #56 claim, lease, or ownership fields are introduced.

## RED test contract and acceptance mapping

`packages/api/test/approval-red.test.ts` is intentionally RED until the above production work exists. It specifies these focused groups:

1. canonical-equivalent action digest stability; changed content divergence; array order sensitivity;
2. managed requester/reviewer distinction and reviewer-only/admin-on-behalf ACL;
3. one lock-protected decision, repeat/concurrent conflict, and expiry conflict;
4. approved/rejected terminal result and waiter payload;
5. inert escaped action arguments, native keyboard controls, and preview redaction;
6. IMAP rebuild of request plus decision, including digest linkage; and
7. ordinary-task reconstruction compatibility.

The first RED round may report missing proposed helpers/routes rather than assertion mismatches. That is intentional: the test names and expected payloads are the implementation checklist, and no production shim is added merely to make RED look cleaner.

## Design choices / non-goals

- Digest reference, not a reviewer nonce/challenge, is the v1 decision binding.
- SHA-256 is a reproducibility/integrity identifier; the server HMAC stamp is the authorization provenance. Neither causes action execution.
- The existing IMAP event log remains the only durable storage; no database, attachment, policy engine, quorum, remote reviewer, framework adapter, or #56 lease behavior is introduced.
- Expected remaining rounds: R2 GREEN service+IMAP stamps; R3 REST/MCP/UI/preview and focused GREEN; R4 full regression, security review, and FC review. This R1 does not start them.

## R1 self-review

| Severity | Result |
|---|---|
| P0 | No credentials or realistic secrets added; action fixtures are inert. |
| P1 | Snapshot immutability and one-decision atomicity are both server-side, not UI/client assertions. |
| P2 | Ordinary task REST/MCP/rebuild paths are explicitly additive and have a compatibility RED case. |
| P3 | No unrelated cleanup or #56 behavior is proposed. |

## R1b — FC behavioral RED correction

This revision replaces the earlier symbol-presence and static-only RED checks.
It keeps the same two-file scope and adds no production source. The exact
behavioral test plan now uses these production-facing seams:

1. Canonical JSON and digest call their own helpers, with no shared guard.
2. The decision test calls the proposed service concurrently against the
   existing per-task lock, captures actual mail writes, retries, and crosses
   the expiry boundary.
3. Approve and reject each use `waitForTaskTerminal()` and assert the returned
   persisted structured result, rather than comparing a literal object.
4. Route tests authenticate reviewer/requester/outsider/admin independently
   and assert generic `/:id/state` is rejected for approval tasks.
5. IMAP reconstruction builds RFC-822 request/decision messages from captured
   server sends and passes them through an explicit test-only wrapper around
   the real private stamp/parser; tampered body, wrong digest, and competing
   valid terminal events are all exercised. The watcher separately receives a
   request encoded by the real request stamper.
6. The watcher is invoked with the actual captured approval message and an
   inert metacharacter action. The final dashboard behavior test executes the
   exact served `TASKS_PAGE_JS` renderer through its fake-DOM harness and
   observes the actual nodes (text, tag, type, and accessible label);
   substring inspection is retained only as a negative guard against
   `innerHTML`, not as proof of presentation behavior.
7. Ordinary IMAP reconstruction and the current MCP client's ordinary
   `task_create` request are positive controls.

The three proposed test-only wrappers (`parseStampedTaskMessageForTests`,
`encodeStampedApprovalRequestForTests`, and
`encodeStampedApprovalDecisionForTests`) must delegate to the real production
parser/stamper. They are not alternative implementations or durable APIs. Each
RED group asserts its own missing behavior before it can pass; this prevents a
single multi-symbol guard from masking coverage.

## R2 — service and IMAP core implemented

R2 implements only the durable core in `lib/tasks.ts` plus additive approval
creation validation in the existing task-create route. The request action is
canonicalized into a detached JSON snapshot, SHA-256 digested, persisted in a
marked body block, and bound to a domain-separated HMAC event stamp. Approval
request, decision, and expiry events have distinct authenticated metadata;
the parser recomputes the snapshot digest and rejects body tampering, digest
substitution, or mismatched terminal results before rebuild.

The existing per-task lock now guards a re-read of the queued overlay before
one reviewer decision. Generic state mutations reject approval tasks. Expiry
writes a `failed` event then rejects the late decision; approve/reject write a
single `completed` result. Rebuild chooses the first parser-valid terminal
approval event and ordinary task handling remains on its original path.

R2 deliberately leaves three R3 behaviors red: `POST /v1/tasks/:id/decision`
and its client/MCP surface, dashboard approval rendering/controls, and the
watcher preview redaction. OpenAgentEmail still records decisions only and
does not invoke an action.

## R2b — timestamp-bound authoritative event payload

Every approval RFC now carries exactly one canonical JSON payload in the
base64url `X-OA-Task-Approval-Payload` header and the domain-separated HMAC
signs that payload together with task id, state, and RFC participants. Its
fixed shapes are:

- request: `event`, `digest`, `reviewer`, `expiresAt`;
- decision: `event`, `digest`, `decision`, `reviewer`, `decidedAt`;
- expiry: `event`, `digest`, `expiredAt`.

The parser accepts only a canonical, finite-timestamp payload, recomputes the
same production HMAC, then cross-checks its fields against both headers and
the structured RFC body. This binds `expiresAt`, `decidedAt`, and `expiredAt`:
changing only any one of those body values in an otherwise captured RFC makes
the event invalid. Expiry results have their own strict three-key shape.

The parser/rebuild tests deliberately use the same production event encoder
and parser, cover all three single-timestamp mutations, and retain the
first-valid-terminal replay assertion. The three R3 RED cases remain unchanged.

## R2c — lazy expiry materialization

Expiry is now materialized only on the next approval detail read, waiter
lookup, or decision attempt; there is no background scheduler, cron, store,
or list sweep. Public `getTask()` obtains an immutable raw/queued snapshot and,
when an approval is still `input-required` at `now >= expiresAt`, enters the
existing per-task lock, re-reads that raw snapshot, and writes the one signed
failed expiry event. Lock-holding writers use the raw snapshot helper so this
read path cannot self-deadlock.

The decision-after-expiry branch delegates to that same locked materializer.
Thus a pre-boundary reviewer decision can win, but boundary-time concurrent
detail/wait/decision activity emits exactly one terminal event; queued overlay
state makes later calls observe it rather than writing another. Captured
request+expiry RFC reconstruction remains a failed approval task. The three
R3 RED cases remain unchanged.

## R3 — REST, MCP, dashboard, and watcher surface

R3 exposes the existing approval service without creating a second decision
state machine. REST and dashboard decision endpoints accept only a strict
`{ from?, decision }` body, derive identity callers from their session/token,
require an admin to name the stored reviewer, and map not-found, reviewer ACL,
expiry, terminal, and non-approval cases to stable public responses. Generic
state mutation remains unable to decide an approval.

The MCP client keeps ordinary `task_create` bytes unchanged, adds typed
approval creation plus `task_decide(id, decision)`, and broadcasts optional
approval task/message fields in task create/list/get/decide schemas. The new
decision tool is contained and does not accept a caller-controlled `from`.

Dashboard task projection carries the optional approval snapshot. Its real
page asset uses only DOM nodes and `textContent` for action type/name/arguments
and presents native labelled approve/reject buttons only to an unexpired stored
reviewer; the button posts to the dashboard endpoint and presents the returned
task. The watcher asks the production signed-message parser for a narrow
authenticated approval event, then emits a fixed bounded request/decision/
expiry preview. Forged lookalike headers retain ordinary preview behavior.

Independent read-only R3 audit confirmed these four boundaries and P0–P3:
no action execution/HTML injection or watcher body leakage (P0); reviewer ACL
and terminal mapping remain server-side (P1); ordinary client/watcher/task
behavior stays covered (P2); only #55 surface files changed, with no #56 work
(P3).
