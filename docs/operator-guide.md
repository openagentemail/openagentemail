# Operator guide

[Back to README](../README.md)

This guide keeps deployment and operating detail out of the landing-page narrative.
Commands are explicit operator actions, not steps performed by the documentation.
Use a test environment before changing a running deployment. Keep populated
configuration and secret material private; never commit an actual `.env`.

## Bundled deployment

The bundled stack operates docker-mailserver, the API and private ntfy. You need
Docker Compose, a domain and correct DNS, reachable inbound SMTP, and either outbound
port 25 or a configured SMTP relay. A successful local SMTP enqueue alone is not
proof the destination received a message.

For a new checkout:

```bash
git clone https://github.com/openagentemail/openagentemail.git
cd openagentemail
cp .env.example .env
chmod 600 .env
# Edit the new .env privately and fill every required value before starting.
# In particular: DOMAIN, API_KEYS, MAIL_PASSWORD, NTFY_ADMIN_PASSWORD,
# and a stable high-entropy TASK_SIGNING_SECRET. Do not use example placeholders.
docker compose up -d
sudo ./deploy/dns-records.sh
sudo ./deploy/doctor.sh
```

Do not overwrite an existing populated `.env`. The DNS script prints records to
create; it does not configure your registrar. Docker Mailserver can create
`docker-data/` as root, hence `sudo` for the DNS/doctor scripts.

Doctor checks `.env` permissions, MX/A/SPF/DKIM/DMARC, PTR, outbound port 25,
blocklists, certificates on 465/993 and the server-side notification verification
endpoint. It does **not** log in over IMAP/SMTP or send a round-trip mail. Confirm an
actual inbound/read and outbound/delivery path; then try the
[first task handoff](first-task-handoff.md).

The API binds to `127.0.0.1` by default. For a remote host use an SSH tunnel or an
HTTPS reverse proxy. Do not change the bind address as a substitute for TLS and
access configuration. `UI_ENABLED=false` disables the UI, not the REST/MCP service.
API/MCP paths are exact; use `/v1/notify`, not `/v1/notify/`.

## Public mail TLS

Mail TLS on 465/993 and HTTPS for API/MCP/UI are different endpoints. The following
changes mailserver certificates; it does not expose a secured public HTTP API.

The default bundled deployment is self-signed. It does not start/pull Certbot or
publish TCP 80. Before opting in, point the mail hostname's A/AAAA records to the
host and allow inbound TCP 80. HTTP-01 cannot create those prerequisites.

After backing up the running configuration, set these values intentionally in the
operator's private configuration (the example domain must be replaced):

```dotenv
SSL_TYPE=letsencrypt
SSL_DOMAIN=mail.example.com
LETSENCRYPT_EMAIL=admin@example.net
```

Use the configured `mail.$DOMAIN`; a reachable contact address outside this
mailserver is preferable. Do not start the mailserver in Let's Encrypt mode until
first certificate issuance succeeds:

```bash
docker compose --profile letsencrypt-bootstrap up -d certbot-bootstrap
docker compose logs -f certbot-bootstrap
# After successful issuance, confirm files (replace the example hostname):
docker compose --profile letsencrypt-bootstrap run --rm --no-deps \
  --entrypoint ls certbot-bootstrap -l \
  /etc/letsencrypt/live/mail.example.com/fullchain.pem \
  /etc/letsencrypt/live/mail.example.com/privkey.pem
```

If issuance fails, the one-shot container stops rather than retrying indefinitely.
Correct DNS, firewall or domain configuration before explicitly running the
bootstrap command again. Never run `letsencrypt-bootstrap` and `letsencrypt`
together: both use host TCP 80.

The persistent volume contains the **whole** `/etc/letsencrypt` tree. `live/` entries
link into `archive/`; mounting only `live/` is incorrect. The mailserver mounts this
volume read-only. After successful bootstrap:

```bash
docker compose --profile letsencrypt up -d
sudo ./deploy/doctor.sh
openssl s_client -connect mail.example.com:465 -servername mail.example.com </dev/null \
  2>/dev/null | openssl x509 -noout -issuer -subject -dates
openssl s_client -connect mail.example.com:993 -servername mail.example.com </dev/null \
  2>/dev/null | openssl x509 -noout -issuer -subject -dates
```

The renewal sidecar checks renewal every 12 hours and restarts with Docker. The
configured docker-mailserver certificate-change detection reloads Postfix/Dovecot;
verify endpoint certificates after issuance/renewal instead of assuming success.
Keep the renewal profile running after opting in. Omitting it does not keep renewal
running or undo a private `.env` setting of `SSL_TYPE=letsencrypt`; default self-signed
behavior applies only to an unmodified/default configuration.

The bundled private-hop certificate-verification defaults accommodate self-signed
certificates. External providers with valid public certificates should use
`IMAP_TLS_REJECT_UNAUTHORIZED=true` and `SMTP_TLS_REJECT_UNAUTHORIZED=true`, as shown
in `.env.api-only.example`. Review both settings explicitly; do not rely on a Compose
fallback or disable verification to fix an unrelated connection failure.

## External mail server and isolated instances

Use [compose.api-only.yaml](../compose.api-only.yaml) with an existing provider's
catch-all account and SMTP sender permissions. Read the
[external-provider guide](https://openagent.email/docs/guides/external-mailserver/)
and the [two-instance example](../README.md#using-your-own-mail-server).

The standalone default Compose project is `openagentemail`. If a full stack shares
the host, choose an explicitly different `-p` / `COMPOSE_PROJECT_NAME`. Each instance
needs its own environment file, project, host port, volume, independently generated
secrets and intended mailbox boundary. Container port 3100 is not the host
`API_PORT`. This supports separate deployments, not multiple writers for one mailbox.

The executable documentation assertions for project/port/secret separation still
read the preserved advanced example in the root README. Keep that safety contract
when relocating the example in a later change; do not remove the assertions.

## Multiple domains

`DOMAIN` plus `EXTRA_DOMAINS` describes domains owned by one OAE instance. Explicit
identities with the same localpart on different configured domains can coexist;
the complete address must remain unique. Cross-domain local task participants still
must be known identities in that instance. This is not federation with arbitrary
external OAE deployments.

The API recognizing an additional domain does not create its catch-all route, DNS,
DKIM records or certificates. The deployment automation still primarily configures
the primary domain. Arrange the extra MTA/provider routing and per-domain DNS/DKIM
requirements before advertising an extra domain as operational. Agent discovery
metadata still centers on the primary domain. Changes to send-domain restrictions
must be reflected in the release/operating guidance.

## UI access and sessions

Open `/ui` through localhost, a tunnel or HTTPS and log in using an admin or identity
token appropriate to the task. Identity sessions are restricted; admin sessions can
manage identities and inspect the admin overview. The UI is not read-only: it can
mark Seen and perform authorized task/identity operations.

A pasted token is exchanged for an `HttpOnly` session cookie rather than persisted
as a raw token in browser storage. Ordinary sessions expire after 12 idle hours or
24 total hours; trusted sessions use a sliding 30-day lifetime and are persisted in
`DATA_DIR/ui-sessions.json` using token hashes. Therefore an API restart does not
log out every trusted browser. There is a five-session-per-token ceiling; a new
login evicts the least-recently-used session when necessary. Revocation/rotation
and authorization still matter; persistence is not perpetual access.

Prefer the normal login form to URL tokens. A legacy `/ui?token=...` link first carries
a real credential: reverse-proxy logs and other upstream handling may observe it
before the server's single-use exchange and URL cleanup. `no-store`, `no-referrer`
and `history.replaceState` cannot erase an earlier upstream log. Never accept such
links from someone else or use an admin-token URL as a share link. If an operator
must use this mechanism, percent-encode reserved characters, scrub proxy logs and
rotate a leaked token. See the [security guide](security.md).

Rendered mail is treated as hostile HTML, sanitized and placed in a separate sandbox
with restrictive CSP. Plain text and bounded Source views are alternatives; Source
is fetched on demand with `no-store` and is not inserted as HTML. Do not weaken these
boundaries to make a screenshot look richer. The exact-version HTML sanitizer and
poison-message tests remain runtime security controls.

Inbox/All Mail reflect IMAP; Sent is the API/MCP send audit for its retention window,
not a complete history of direct SMTP activity. Read/unread flags affect all consumers
of the mailbox. Use per-consumer cursors/reconciliation, not Seen alone, for independent
Agent processing. Reading a message does not mark it Seen.

## Overview counts

The admin overview is a **bounded observation**, not an exact lifetime dashboard.
The current window scans the newest 500 catch-all messages. A message delivered to
multiple identities counts in each relevant row and only once in the total. The
window label identifies how much of the mailbox was scanned.

Large recipient lists or global scan bounds can leave counts incomplete. `>=N` /
`Unknown` and `unmatchedInWindow: null` communicate uncertainty; a new identity not
yet covered by the snapshot should not receive an invented zero. The endpoint
returns counts/timestamps, not mail bodies or OTP codes.

Snapshots are cached for 15 seconds and can be reused for up to 10 minutes while
refreshing. Refresh has a five-second floor; failures cool down and preserve the
last usable snapshot with a failure indication. Cold scans can return 202 while the
identity list renders with loading counts. Expired snapshots are not made current
by a failed refresh. Request deadlines include connection work; late responses do
not revive a timed-out scan.

The client schedules bounded follow-up reads while loading/refreshing (up to 15
attempts over 20 seconds, respecting retry hints), not continuous steady-state
polling. Up to 200 identities render in one pass; filtering/sorting are currently
client-side. These details belong here, not in the product headline. Check
[UI routes](../packages/api/src/routes/ui.ts) when changing the behavior.

## Optional compliance archive

`ALWAYS_BCC=archive@example.net` is **off by default**. Enable it only when your
privacy/compliance policy permits another off-domain recipient. It adds an SMTP
envelope recipient, not a visible MIME Bcc header, and does not change visible To,
header From or envelope MAIL FROM. It is an independent, trusted archive boundary;
access, retention, aliases and forwarding remain operator/MTA responsibilities.

A same-domain archive is rejected: another alias in a shared catch-all is not an
independent archive. For all-local visible recipients the archive receives exact
MIME, including internal-message stamps. Do not treat this archive as an ordinary
untrusted recipient or promise that self-hosting keeps that copy on the OAE host.

Every enabled archive requires an explicit high-entropy `TASK_SIGNING_SECRET` of at
least 32 characters. Length checking does not prove entropy; generate a secret with
an appropriate generator such as `openssl rand -hex 32`. Compose requires this
secret already; historical bare-process SMTP-password fallback applies only with
no archive. Keep the task secret stable across SMTP-password rotation.

SMTP success can be partial. If an original recipient was accepted but the archive
was rejected, the API preserves partial success with a content-free warning. An
accepted archive with no accepted original recipient is not successful primary
delivery. Failures occurring after SMTP acceptance appear in relay logs/DSNs, not
necessarily in the API response.

Recipient matching preserves localpart spelling and matches domains
case-insensitively. Case-rewriting relays and case-folding mailbox providers can
produce conservative failures or multiple copies; use consistent recipient spelling
and validate the chosen relay. Never interpret deduplication as an archive privacy
boundary.

## Leases, waits and recovery

[The MCP reference](../packages/mcp/README.md#task-contracts) explains claim/renew/release,
approval bounds and the disabled defaults. Before enabling pending journal writes,
read [task-lease-journal.md](task-lease-journal.md). For the 8_000-character release
`reason` bound on the wire (`X-OA-Task-Lease-Payload` ASCII ≈10.9KiB；非 ASCII 最坏更高：BMP ≈31.3KiB / JSON 转义 ≈62.6KiB 级，见专页),
Postfix `header_size_limit`, and commercial-relay header risk notes, read
[task-lease-reason-transport.md](task-lease-reason-transport.md). Do not remove OPEN records to free
capacity, infer rejected SMTP delivery from a terminal task, or use first provision
as a corruption-recovery command. Preserve the documented evidence and rollback rules.

Server wait requests use `MCP_MAX_WAIT_SECONDS` (default 60; supported 1–600). The MCP
mail client has its own requested total deadline (default 120, schema maximum 600)
and uses shorter REST segments; it re-arms only on a validated genuine timeout within
that total budget. A task wait is one capped turn. These are not interchangeable
limits, and no wait starts an Agent. Check an existing task after a partial/uncertain
create result instead of creating another one.

Webhook retries recover already-recorded pending deliveries. They do not capture
all messages that arrived while the API was stopped, guarantee unlimited retries or
prove an Agent consumed a notification. Integrations need startup/reconnect
reconciliation; see [architecture](architecture.md#event-delivery-and-recovery).

## Resource planning

Do not size the host from an undated idle-memory figure or a cheap-VPS promotion.
Use the current stack configuration and a representative workload: active identities,
mail size/arrival rate, task history, retained delivery logs, notification settings
and any enabled spam/antivirus services. Check provider port and sender policies
before buying capacity. Self-hosting does not remove those policies or infrastructure
costs.

The ordinary-mail sweeper defaults to 30 days but excludes task-marked mail. Task
history and local operational files therefore need their own capacity and backup
planning. Back up the mailbox, `DATA_DIR` and stable signing secrets together; retain
separate backups of external Agent sessions/workspaces when those matter. An old
mailbox restored with mismatched local state or secrets is not a verified recovery.

Record version, host, enabled features, test workload, date and measurement procedure
before publishing a new resource benchmark. A successful restore and a real message/task
round trip are more meaningful than HTTP liveness alone.
