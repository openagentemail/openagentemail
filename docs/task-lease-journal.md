# Task-lease pending journal — trusted first provision

The pending-lease journal is opt-in (`TASK_LEASES_PENDING_JOURNAL`, default `false`, requires `TASK_LEASES_ENABLED`). The API **never** creates it on boot. Enabling the flag against a missing journal fails closed (`lease_journal_not_bootstrapped`).

## Genuine first provision only

Run this **once** on a host that has never had `DATA_DIR/task-lease-journal/`. Exclusive `mkdir` fails if the directory already exists (`lease_journal_already_initialized`).

This is **not** recovery. Wiping (`rm -rf` of the journal directory) is an **unsupported recovery operation**: afterwards each missing piece simply fails closed per its state (`lease_journal_not_bootstrapped` / `lease_journal_lost` / `lease_journal_corrupt` as applicable — a cold total wipe presents as `not_bootstrapped`). Re-running provision after a wipe is a trust-boundary decision for the operator, not a supported restoration path; nothing here mechanically blocks a trusted operator from provisioning again, and no attestation or supported restore mechanism exists.

Shipped image entry (built next to `main.js` / `ntfy-provision.js`):

```text
dist/task-lease-provision.js
```

Bundled compose (same `api` image and `DATA_DIR` volume as the API):

```sh
docker compose run --rm --no-deps --entrypoint bun api dist/task-lease-provision.js
```

API-only compose:

```sh
docker compose -f compose.api-only.yaml run --rm --no-deps --entrypoint bun api dist/task-lease-provision.js
```

Exit 0 prints `{"status":"provisioned",...}`. A second run exits 1 with `lease_journal_already_initialized`.

## Signing key lifecycle (read before first provision)

The journal seal and activated-marker MACs (and every lease-token verifier) are HMAC-derived from `taskSigningSecret`, which is `TASK_SIGNING_SECRET` when set and **falls back to `SMTP_PASS`** when it is not (`packages/api/src/lib/config.ts`). Set a **stable, explicit `TASK_SIGNING_SECRET` before the first provision** whenever you intend to use the journal. If the effective key changes afterwards — rotating `TASK_SIGNING_SECRET`, or rotating `SMTP_PASS` while relying on the fallback — every existing seal/marker MAC fails verification and the journal latches permanently `lease_journal_corrupt` (journal-backed lease operations fail closed with 503). **There is no supported reseal, rotation, or recovery procedure in this card**; a wipe is an unsupported recovery operation whose missing pieces then fail closed per state. The base runtime schema requires a minimum of 16 characters with no flag attached. Two conditional 32-character requirements exist elsewhere in config validation and are unrelated to this journal: `WEBHOOKS_ENABLED=true` requires an explicit `TASK_SIGNING_SECRET` of at least 32 characters, and the external compliance archive does the same. For the journal itself, choosing a longer secret (e.g. 32+) remains an operator hardening recommendation, not a runtime requirement.

## Emitter

Production expiry-audit SMTP remains **hard-disabled** even when the journal flag is on. Emission is a separate commander-approved card; these flags do not opt in to sending postponed expiry audits.

**M3 + journal capacity consequence (accepted per commander-2091):** with `TASK_LEASES_EXPIRY_AUDIT_M3=true` and the journal enabled, each reclaimed lease window writes an expired-kind `intent` record for the expired claim window. While the emitter is hard-disabled these records have **no production drain**: they remain OPEN, they block whole-task exit (which requires zero open records), and they can accumulate until the 10,000-record journal capacity is exhausted, after which lease mutations fail closed with `lease_journal_capacity_exhausted`. Do **not** enable `TASK_LEASES_EXPIRY_AUDIT_M3` in production before the separately approved emitter work is implemented; this cost is reassessed on that card. There is intentionally no runtime guard — this is operator policy, not enforced behavior.
