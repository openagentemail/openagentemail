#!/usr/bin/env bash
# openagent.email — print the exact DNS records you must create.
#
# Reads .env in the repo root, asks for your server's public IPv4 (or take it
# as $1), and prints copy-pasteable A / MX / SPF / DKIM / DMARC records.
#
# DKIM: after `docker compose up -d` has run once, the public key is read from
# ./docker-data/dms/config/opendkim/keys/<DOMAIN>/mail.txt. If it's not there
# yet, we print the command to generate it instead.

set -euo pipefail
cd "$(dirname "$0")/.."

# ── load .env ────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "ERROR: .env not found. Run: cp .env.example .env  (and fill it in)" >&2
  exit 1
fi
set -a; # shellcheck disable=SC1091
. ./.env; set +a

: "${DOMAIN:?DOMAIN is not set in .env}"

# ── server IP: argument, or prompt ──────────────────────────────────────────
SERVER_IP="${1:-}"
if [ -z "$SERVER_IP" ]; then
  if [ -t 0 ]; then
    read -rp "Public IPv4 of this server: " SERVER_IP
  else
    SERVER_IP="<YOUR-SERVER-IPv4>"
  fi
fi

MAIL_HOST="mail.${DOMAIN}"
DKIM_KEY_FILE="docker-data/dms/config/opendkim/keys/${DOMAIN}/mail.txt"

docker_data_eacces() {
  echo "ERROR: cannot read '$1' (EACCES / permission denied)." >&2
  echo "Re-run with sudo: sudo ./deploy/dns-records.sh" >&2
  exit 1
}

# DMS commonly creates this tree as root. Do not silently claim that DKIM has
# not been generated when the real problem is that this user cannot read it.
require_docker_data_access() {
  local path="docker-data"
  local part
  for part in dms config opendkim keys "$DOMAIN"; do
    [ -e "$path" ] || return
    { [ -r "$path" ] && [ -x "$path" ]; } || docker_data_eacces "$path"
    path="${path}/${part}"
  done
  [ -e "$path" ] || return 0
  { [ -r "$path" ] && [ -x "$path" ]; } || docker_data_eacces "$path"
  [ ! -e "$DKIM_KEY_FILE" ] || [ -r "$DKIM_KEY_FILE" ] || docker_data_eacces "$DKIM_KEY_FILE"
}

require_docker_data_access

cat <<EOF

────────────────────────────────────────────────────────────────────────────
 DNS records for ${DOMAIN}
 Create these at your DNS provider (Cloudflare, Route53, Namecheap, ...).
 TTL 300 everywhere is fine while setting up.
────────────────────────────────────────────────────────────────────────────

1) A record — the mail server itself
   ${MAIL_HOST}.   A   ${SERVER_IP}
   (add AAAA too if the server has IPv6)

2) MX record — deliver all mail for the domain here
   ${DOMAIN}.   MX   10 ${MAIL_HOST}.

3) SPF — only the MX host may send for this domain
   ${DOMAIN}.   TXT   "v=spf1 mx ~all"

4) DKIM — mail signing
EOF

if [ -f "$DKIM_KEY_FILE" ]; then
  # DMS writes a standard bind-style TXT record; normalize to a single-line
  # value for providers that want the bare "v=DKIM1; k=rsa; p=..." string.
  DKIM_VALUE="$(tr -d '\n' < "$DKIM_KEY_FILE" | sed -e 's/^[^(]*( *//' -e 's/)[^)]*$//' -e 's/"[[:space:]]*"//g' -e 's/"//g' -e 's/^ *//' -e 's/ *$//')"
  cat <<EOF
   mail._domainkey.${DOMAIN}.   TXT   "${DKIM_VALUE}"
   (source: ${DKIM_KEY_FILE})
EOF
else
  cat <<EOF
   NOT GENERATED YET. Start the stack once, then either re-run this script:
     docker compose up -d && sudo ./deploy/dns-records.sh
   or generate the key manually:
     docker compose run --rm mailserver setup config dkim domain ${DOMAIN} selector mail
   The record to publish will be in:
     ${DKIM_KEY_FILE}
EOF
fi

cat <<EOF

5) DMARC — starter policy (monitoring only; tighten to quarantine/reject later)
   _dmarc.${DOMAIN}.   TXT   "v=DMARC1; p=none; rua=mailto:postmaster@${DOMAIN}"

6) Reverse DNS (PTR) — set at your VPS HOST (not your DNS provider):
   ${SERVER_IP}  ->  ${MAIL_HOST}
   (DO/Vultr: rename the droplet/instance to ${MAIL_HOST}; Hetzner/AWS: set rDNS in console)

────────────────────────────────────────────────────────────────────────────
 When DNS has propagated, verify everything with:  sudo ./deploy/doctor.sh
────────────────────────────────────────────────────────────────────────────
EOF
