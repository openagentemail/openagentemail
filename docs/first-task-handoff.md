# Your first task handoff

[Back to README](../README.md#quickstart)

This is a **manual, two-identity protocol exercise**. It reviews a small code snippet
by inspection, changes only OAE task records, and makes no model API calls, repository
writes, commits or deployments. It is a runnable recipe, not a claim that a live
end-to-end run has already been recorded.

Expected observations: a requester obtains a task ID; a distinct recipient reads the
same task, reports `working` and `completed`; the requester reads the structured
result and history. No automatic terminal wakeup is assumed.

## Credentials and prerequisites

Use a disposable test instance with a working mail backend and the default
`TASK_LEASES_ENABLED=false`. Do not disable leases on a production instance just to
fit this example; use its approved claim/renew/update workflow instead.

You need Bash, curl with `--fail-with-body` support, and Node.js 20+ (also required by
the stdio MCP package). Keep the API on localhost or use an HTTPS endpoint/SSH tunnel.
Never use curl's `-k` to bypass certificate validation.

An operator creates two distinct managed identities, for example
`readme-requester@YOUR_DOMAIN` and `readme-reviewer@YOUR_DOMAIN`, and gives each
participant only its own address/token. Use the dashboard or the admin-only
`POST /v1/identities` operation. These are example creation bodies, not live identities:

```json
{"name":"README requester","localpart":"readme-requester"}
```

```json
{"name":"README reviewer","localpart":"readme-reviewer"}
```

Omitting `scopes` requests the current full **identity** permissions. It does not
create an admin credential. `scopes: ["read:messages"]` is for mail reading/waiting
and cannot create/update tasks; `scopes: []` grants no API operations. Do not invent
additional scope strings or give an Agent the operator's admin key. Identity tokens
are displayed once; store them securely and never commit screenshots/configuration
containing them.

Creation/listing of identities is operator work. A participating identity cannot call
`mail_list_identities` to discover its address; the operator should supply it.

Before tasks, verify an actual mail path: send a harmless test message to one identity,
read it through the API/UI, and check a reply arrives at the intended recipient when
outbound delivery matters. `doctor.sh` and `/healthz` alone do not prove that round trip.

## 1. Requester: create once and keep the ID

In the requester's terminal, enter only the requester's token. Hidden input avoids
putting the secret literally in shell history. Tokens still exist in process memory
and request arguments; use a trusted host, do not enable shell tracing, and do not
paste diagnostic command output containing credentials.

```bash
OAE_URL='http://localhost:3100' # Or your instance's HTTPS base URL, with no trailing slash.
read -r -s -p 'Requester identity token: ' REQUESTER_TOKEN; printf '\n'
read -r -p 'Recipient full managed email address: ' RECIPIENT_ADDRESS

PAYLOAD="$(node -e '
  process.stdout.write(JSON.stringify({
    to: process.argv[1],
    subject: "README handoff: review isPositive",
    body: "Read-only review by inspection. Contract: true only for numbers strictly greater than zero. Snippet: function isPositive(n) { return n >= 0; }. Report any mismatch in result. Do not execute code, edit files, create a PR or deploy.",
    wait: false
  }));
' "$RECIPIENT_ADDRESS")"

curl --fail-with-body --silent --show-error --connect-timeout 5 --max-time 30 \
  "$OAE_URL/v1/tasks" \
  -H "Authorization: Bearer $REQUESTER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary "$PAYLOAD"
```

A successful create returns HTTP 201 with the new task's `id` and submitted view.
Keep that actual ID; do not copy an ID from somebody else's example. This says a task
was created, **not** that the reviewer has received, accepted or completed it.

There is deliberately no automatic POST retry. If creation/waiting returns an error
containing a `taskId`, read that existing task. If the response was lost and no ID is
available, inspect your task list/history and reconcile before attempting another
create. An error without an ID is not proof that SMTP never accepted the task.
`wait:false` separates creation from waiting; it is not an idempotency guarantee.

## 2. Recipient: activate explicitly and read

Activate the existing reviewer Agent yourself, or perform this step in its terminal.
This guide does not start a new runtime or presume Webhooks can wake every client.
Use only the recipient's token on this side.

```bash
OAE_URL='http://localhost:3100' # Use HTTPS or a local tunnel for a remote instance.
read -r -s -p 'Recipient identity token: ' RECIPIENT_TOKEN; printf '\n'
read -r -p 'Task ID returned by the requester: ' TASK_ID

curl --fail-with-body --silent --show-error --connect-timeout 5 --max-time 30 \
  "$OAE_URL/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $RECIPIENT_TOKEN"
```

Check that `from`, `to`, `subject` and `body` describe the expected request. A record
may take time to become visible through IMAP; repeat the **read** after a short pause
rather than issuing another create. Investigate repeated failures with the operator.

## 3. Recipient: report progress, then the inspected result

```bash
curl --fail-with-body --silent --show-error --connect-timeout 5 --max-time 30 \
  "$OAE_URL/v1/tasks/$TASK_ID/state" \
  -H "Authorization: Bearer $RECIPIENT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"state":"working","body":"Reviewing the provided snippet by inspection; no external action."}'
```

Inspect the snippet. For zero, `n >= 0` evaluates to true, contradicting “strictly
greater than zero.” That observation needs no code execution. After actually checking
that the request contains this snippet, report the finding:

```bash
curl --fail-with-body --silent --show-error --connect-timeout 5 --max-time 30 \
  "$OAE_URL/v1/tasks/$TASK_ID/state" \
  -H "Authorization: Bearer $RECIPIENT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary '{"state":"completed","body":"Read-only review complete; no files changed and no code executed.","result":{"method":"inspection","findings":[{"input":0,"expected":false,"actualByInspection":true,"suggestion":"Use n > 0 for the stated numeric-input contract."}]}}'
```

`completed` means the **review** finished, not that a fix was applied. Never use this
sample result as a fabricated review of a different task. If a write's outcome is
uncertain, read the latest history before attempting another state update. Completed
and failed tasks are terminal.

## 4. Requester: inspect the result

Back in the requester's terminal:

```bash
read -r -p 'The task ID saved in step 1: ' TASK_ID
curl --fail-with-body --silent --show-error --connect-timeout 5 --max-time 30 \
  "$OAE_URL/v1/tasks/$TASK_ID" \
  -H "Authorization: Bearer $REQUESTER_TOKEN"
```

Look for `state: "completed"`, the result, the two participants and the task history.
Use the dashboard's Tasks view to inspect the same work; do not infer completion from
a notification, a `Seen` flag, or a command exiting successfully.

Clean token variables in their respective terminals when finished:

```bash
unset REQUESTER_TOKEN RECIPIENT_TOKEN PAYLOAD
```

This does not revoke issued credentials. Operator-side token/identity management is
separate; do not delete the underlying task emails as an ad-hoc reset.

## The same handoff through MCP

The requester uses `task_create` with `wait:false` and its recipient's address. The
recipient uses `task_get`, then `task_update` for `working` and `completed`. The
requester reads the same ID using `task_get`. Only each participant's own appropriate
credential belongs in its MCP configuration.

Waiting via `task_get(id, wait:true)` is bounded by the server's
`MCP_MAX_WAIT_SECONDS` (60 seconds by default). It does not activate the reviewer.
Use the existing task ID after timeout; do not create a replacement merely to wait.

For optional leases, typed approvals and outbound notifications, read the
[MCP reference](../packages/mcp/README.md#tools),
[journal operating guide](task-lease-journal.md),
[8k release-reason transport guidance](task-lease-reason-transport.md) and
[wake adapter's actual prerequisites](../examples/webhook-wake/README.md).
