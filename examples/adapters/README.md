# OpenAgentEmail adapter examples

Install and run deterministic, no-key checks:

```bash
cd examples/adapters
npm ci
npm run typecheck
npm test
npm audit --audit-level=moderate
```

## Environment and local API boundary

For a real OpenAgentEmail deployment, provide the local API URL and each pre-provisioned participant's own identity/address and scoped token through the shell that runs the adapter. The names are `OPENAGENTEMAIL_API_URL`, `OAE_REQUESTER_EMAIL`, `OAE_RESPONDER_EMAIL`, `OAE_REQUESTER_TOKEN`, and `OAE_RESPONDER_TOKEN`; never put token values in YAML, state, receipts, or timelines. This example does not create identities or use an admin/bootstrap credential.

The checked-in scenario command is different: it supplies deterministic placeholder scopes only to its child process and injects an in-memory fake OAE service. It requires the URL variable as an authority boundary but never contacts that URL or any live endpoint.

The R2 OpenAI Agents SDK tests use the SDK's local `ScriptedModel`; they create no API key and make no paid or live OpenAI API calls. They pause an approval-required function tool, save sensitive `RunState` only in owner-only local files, and restore it in a fresh process.

The deterministic OpenAI pause/decision/resume fixture is independently runnable. Create an owner-only temporary directory, then use the same directory for all four fresh processes:

```bash
r2_state="$(mktemp -d)" && chmod 700 "$r2_state"
env -u OPENAI_API_KEY node node_modules/tsx/dist/cli.mjs test/fixtures/openai-r2-child.ts pause "$r2_state" approved
env -u OPENAI_API_KEY node node_modules/tsx/dist/cli.mjs test/fixtures/openai-r2-child.ts decide "$r2_state" approved
env -u OPENAI_API_KEY node node_modules/tsx/dist/cli.mjs test/fixtures/openai-r2-child.ts resume "$r2_state" approved
env -u OPENAI_API_KEY node node_modules/tsx/dist/cli.mjs test/fixtures/openai-r2-child.ts resume "$r2_state" approved
```

This uses a local durable fake OAE task, not the real API URL. The final resume is a fresh-process replay/no-op check. To exercise rejection, repeat the four commands in a fresh directory with `rejected` in place of `approved`. The `run-state.json` and `tool-receipt.json` files are owner-only framework state/evidence with fixed basenames; raw workflow input may appear only in `run-state.json`, never in correlation records, receipts, or sanitized timelines. A `resume-started` record never retries a tool without a fully bound final state and receipt.

Live execution is optional and must be explicitly invoked by a user who supplies their own `OPENAI_API_KEY`. With no key, the live boundary returns `skipped-no-key` before constructing a client, model, or network request. CI and acceptance tests never make paid API requests.

## R3 LangGraph SQLite interruption

The R3 adapter uses exact `@langchain/langgraph@1.4.13` and `@langchain/langgraph-checkpoint-sqlite@1.0.4` dependencies. Its real `StateGraph` pauses through `interrupt()` and resumes the same persistent `thread_id` with `new Command({ resume })`; no model is constructed or called. `langgraph-checkpoints.sqlite` and any SQLite sidecars are sensitive framework state: they live only in an owner-only `0700` directory as owner-only regular files, while the bound LangGraph receipt and correlation records contain hashes and identifiers rather than raw workflow content. A `resume-started` record without a matching receipt and final checkpoint fails closed rather than re-running `Command`.

Run the local fake-OAE LangGraph sequence with one private directory and the same explicit thread/correlation identity across all four fresh processes:

```bash
r3_state="$(mktemp -d)" && chmod 700 "$r3_state"
r3_thread='r3-thread-000000000001'
r3_correlation='77777777-7777-4777-8777-777777777777'
env -u OPENAI_API_KEY node node_modules/tsx/dist/cli.mjs test/fixtures/langgraph-r3-child.ts pause "$r3_state" approved "$r3_thread" "$r3_correlation"
env -u OPENAI_API_KEY node node_modules/tsx/dist/cli.mjs test/fixtures/langgraph-r3-child.ts decide "$r3_state" approved "$r3_thread" "$r3_correlation"
env -u OPENAI_API_KEY node node_modules/tsx/dist/cli.mjs test/fixtures/langgraph-r3-child.ts resume "$r3_state" approved "$r3_thread" "$r3_correlation"
env -u OPENAI_API_KEY node node_modules/tsx/dist/cli.mjs test/fixtures/langgraph-r3-child.ts resume "$r3_state" approved "$r3_thread" "$r3_correlation"
```

These fixtures never contact `OPENAGENTEMAIL_API_URL`; they use a local durable fake OAE task and real SQLite checkpoint/receipt/effect files. The final resume proves replay safety. To exercise rejection, repeat with a fresh directory and `rejected` in place of `approved`.

For an explicit user live invocation (never an acceptance command), run `node node_modules/tsx/dist/cli.mjs src/openai-live.ts "your safe prompt"` only with the user's own key present in that shell. Without a key, the directly runnable acceptance-safe check is `env -u OPENAI_API_KEY node node_modules/tsx/dist/cli.mjs src/openai-live.ts "no-key check"`; it prints `skipped-no-key` and exits before live setup.

OAE runtime identities remain user-provided participant environment variable names (for example `OAE_REQUESTER_EMAIL`, `OAE_RESPONDER_EMAIL`, `OAE_REQUESTER_TOKEN`, and `OAE_RESPONDER_TOKEN`); no token values are written to adapter state, receipts, or timelines.

## R4 caller-supplied local scenarios

R4 adds a deterministic, local-only YAML scenario runner. It never contacts the URL in `OPENAGENTEMAIL_API_URL`: that variable is required as an authority boundary, while the runner injects an in-memory fake service. Each YAML participant declares only an email address and the *name* of its scoped token variable, for example `OAE_FIXTURE_REQUESTER_TOKEN`; token values, Authorization headers, shared/admin credentials, and identity-provisioning operations are forbidden in YAML and all durable output.

Run the checked-in complete fixture exactly as follows:

```bash
cd examples/adapters
npm ci
npm run fixture -- scenarios/input-resume.yaml
```

The package command supplies deterministic placeholder requester/responder scopes to that child process only. The resulting JSON shows the seeded stable task/correlation identity, `submitted → input-required → working → completed` authorship order, structured decision, and one pause/resume. You can pass an arbitrary caller-owned `.yaml` path to the same command. The documented boundary accepts only the restricted map/list/scalar YAML subset used by `scenarios/`: it rejects aliases, tags, flow collections, directives, duplicate keys, unsafe indentation, unknown fields, copied markers, swapped participants, unsafe strings, and duplicate identities or seed IDs before any local service mutation.

The adverse fixtures are `duplicate-delivery.yaml`, `timeout.yaml`, `stale-update.yaml`, `wrong-responder.yaml`, `swapped-participants.yaml`, and `copied-marker.yaml`. They are executable through the same command. A scenario wait uses a real bounded monotonic delay; timeout exits non-zero while the expected `completed` state is absent and the current state is `working`, with measured elapsed metadata. A transition scheduled before the deadline completes; one after it is never scheduled after the runner returns. Duplicate input/completion is idempotent; stale, wrong-responder, swapped, and copied-marker paths stop before a new framework resume. Ordinary `get` polling reports non-terminal state. `wait=true` is terminal-only: both non-terminal and terminal wait responses carry the same local cap header.

Scenario success/failure exports are allowlisted to scenario, step, code, expected/observed state, task ID, correlation ID, and bounded elapsed time. They use fixed contained filenames in an exact-`0700` owner directory, write through an exclusive no-follow `0600` temporary file, flush, validate, and atomically replace only an unchanged owner-only regular target. They never contain tokens, Authorization values, raw mail/workflow bodies, stack/environment dumps, or transport response bodies. The local correlation file is owner-only; R2 `run-state.json` and R3 `langgraph-checkpoints.sqlite`/sidecars remain the only documented owner-only framework locations that may contain raw workflow input. Tests scan scenario exports together with correlation, receipt, OpenAI state, LangGraph SQLite/effect/timeline artifacts for credential canaries.

All R4 fixtures are no-key and deterministic. They do not construct a model or make a live OAE call. The opt-in `src/openai-live.ts` entrypoint remains separate: it requires a user-provided `OPENAI_API_KEY`, skips before client construction when absent, and is never run by these fixtures or tests.

## Runtime and durable-store operations

`createRuntimeParticipants` in `src/oae-runtime.ts` is executable opt-in caller-side wiring: it reads the documented participant variables, accepts HTTPS or exact loopback HTTP only, constructs no identities, and makes no I/O until a caller uses one of the scoped clients. Addresses must already be canonical lowercase. No acceptance command invokes it against a live endpoint.

LangGraph receipts are named by correlation identity, so separately bound threads in one trusted directory never share replay evidence. Credential-shape detection (including `raw-body` variants) is defense in depth only: explicit allowlisted schemas and direct canary scans are the primary controls that keep secrets out of persistence.

The checkpoint-contradiction regression retains a pinned SQLite mutation: LangGraph's public `updateState` only creates a valid checkpoint and cannot express the hostile, correctly-bound-but-contradictory persisted row the adapter must reject. The test therefore mutates the exact durable SQLite evidence and verifies the public resume boundary fails before an effect.

Correlation and fixture stores fail closed on a residual owner-only lock; they never steal it by age. An operator may inspect only the exact `<state-directory>/correlation/<uuid>.lock` path, verify it is an owner-owned regular lock for that correlation and confirm no writer remains, then remove that exact lock manually before a controlled resume. Never remove a wildcard or another correlation's lock.

This package requires Node `>=22`. Acceptance runs `npm audit`; a pinned transitive deprecated-install warning with no compatible upstream replacement remains a monitored residual, not a reason to disable SQLite install scripts.
