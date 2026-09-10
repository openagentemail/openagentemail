# Task-lease pending journal — trusted first provision

The pending-lease journal is opt-in (`TASK_LEASES_PENDING_JOURNAL`, default `false`, requires `TASK_LEASES_ENABLED`). The API **never** creates it on boot. Enabling the flag against a missing journal fails closed (`lease_journal_not_bootstrapped`).

## Genuine first provision only

Run this **once** on a host that has never had `DATA_DIR/task-lease-journal/`. Exclusive `mkdir` fails if the directory already exists (`lease_journal_already_initialized`).

This is **not** recovery. A wipe (`rm -rf` of the journal directory) is `recovery_required`. Do not re-run provision after a wipe.

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

## Emitter

Production expiry-audit SMTP remains **hard-disabled** even when the journal flag is on. Emission is a separate commander-approved card; these flags do not opt in to sending postponed expiry audits.
