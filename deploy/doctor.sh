#!/usr/bin/env bash
# openagent.email — deliverability doctor.
#
# Checks everything that decides whether your agents' mail actually lands in
# an inbox, and prints PASS / WARN / FAIL with a fix hint for each item.
#
#   DNS:   MX, A, SPF, DKIM, DMARC
#   IP:    PTR (reverse DNS), outbound port 25, DNSBL listings
#   TLS:   certificate validity/expiry on 465 + 993
#   ntfy:  private notification transport via POST /v1/notify/verify
#
# Deps: dig, curl, openssl (all standard on macOS/Linux). Read-only.
# Usage: ./deploy/doctor.sh [server-public-ipv4]

cd "$(dirname "$0")/.." 2>/dev/null || true

# ── config ───────────────────────────────────────────────────────────────────
DOMAIN=""
API_KEY=""
API_PORT="3100"
NTFY_ENABLED="true"
if [ -f .env ]; then
  DOMAIN="$(grep -E '^DOMAIN=' .env | head -1 | cut -d= -f2- | tr -d ' "')"
  API_KEY="$(grep -E '^API_KEYS=' .env | head -1 | cut -d= -f2- | cut -d, -f1 | tr -d ' "')"
  API_PORT="$(grep -E '^API_PORT=' .env | head -1 | cut -d= -f2- | tr -d ' "')"
  NTFY_ENABLED="$(grep -E '^NTFY_ENABLED=' .env | head -1 | cut -d= -f2- | tr -d ' "')"
fi
if [ -z "$DOMAIN" ]; then
  echo "ERROR: DOMAIN not found. Create .env (cp .env.example .env) first." >&2
  exit 1
fi
[ -n "$API_PORT" ] || API_PORT="3100"
[ -n "$NTFY_ENABLED" ] || NTFY_ENABLED="true"
MAIL_HOST="mail.${DOMAIN}"
DKIM_SELECTOR="mail"
DKIM_KEY_FILE="docker-data/dms/config/opendkim/keys/${DOMAIN}/${DKIM_SELECTOR}.txt"

docker_data_eacces() {
  echo "ERROR: cannot read '$1' (EACCES / permission denied)." >&2
  echo "Re-run with sudo: sudo ./deploy/doctor.sh" >&2
  exit 1
}

# DMS commonly creates this tree as root. A non-root doctor must fail clearly
# instead of reporting a readable-on-disk DKIM key as missing.
require_docker_data_access() {
  local path="docker-data"
  local part
  for part in dms config opendkim keys "$DOMAIN"; do
    [ -e "$path" ] || return 0
    { [ -r "$path" ] && [ -x "$path" ]; } || docker_data_eacces "$path"
    path="${path}/${part}"
  done
  [ -e "$path" ] || return 0
  { [ -r "$path" ] && [ -x "$path" ]; } || docker_data_eacces "$path"
  [ ! -e "$DKIM_KEY_FILE" ] || [ -r "$DKIM_KEY_FILE" ] || docker_data_eacces "$DKIM_KEY_FILE"
}

require_docker_data_access

PASS=0; WARN=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
warn() { WARN=$((WARN+1)); printf '  \033[33mWARN\033[0m  %s\n  %s\n' "$1" "$2"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n  %s\n' "$1" "$2"; }
hint() { printf '       hint: %s\n' "$1"; }

# .env includes mail and ntfy administrator passwords. Keep it owner-readable
# only; accepting a looser mode here would turn doctor into a false assurance.
echo "[SECURITY] .env permissions"
ENV_MODE="$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null || true)"
if [ "$ENV_MODE" = "600" ]; then
  ok ".env mode is 600"
else
  warn ".env mode is ${ENV_MODE:-unknown}, expected 600" "       hint: chmod 600 .env"
fi

for cmd in dig curl openssl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: '$cmd' not found in PATH" >&2; exit 1; }
done

# ── server IP: arg > A record of mail host > prompt ─────────────────────────
SERVER_IP="${1:-}"
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(dig +short A "$MAIL_HOST" | grep -E '^[0-9.]+$' | head -1 || true)"
fi
if [ -z "$SERVER_IP" ] && [ -t 0 ]; then
  read -rp "Public IPv4 of this server: " SERVER_IP
fi

reverse_ip() { echo "$1" | awk -F. '{print $4"."$3"."$2"."$1}'; }

echo ""
echo "openagent.email doctor — ${DOMAIN} (${MAIL_HOST}${SERVER_IP:+, ${SERVER_IP}})"
echo "──────────────────────────────────────────────────────────────"

# ── 1. MX ────────────────────────────────────────────────────────────────────
echo "[DNS] MX record"
MX="$(dig +short MX "$DOMAIN" | sort -n | head -1 | awk '{print $2}' | sed 's/\.$//')"
if [ "$MX" = "$MAIL_HOST" ]; then
  ok "MX ${DOMAIN} -> ${MX}"
elif [ -n "$MX" ]; then
  bad "MX points to '${MX}', expected '${MAIL_HOST}'"
  hint "set: ${DOMAIN}. MX 10 ${MAIL_HOST}."
else
  bad "no MX record for ${DOMAIN}"
  hint "create: ${DOMAIN}. MX 10 ${MAIL_HOST}. (run sudo ./deploy/dns-records.sh)"
fi

# ── 2. A record ─────────────────────────────────────────────────────────────
echo "[DNS] A record"
A="$(dig +short A "$MAIL_HOST" | grep -E '^[0-9.]+$' | head -1 || true)"
if [ -n "$A" ]; then
  ok "A ${MAIL_HOST} -> ${A}"
  [ -n "$SERVER_IP" ] && [ "$A" != "$SERVER_IP" ] && \
    warn "A record (${A}) differs from the server IP you gave (${SERVER_IP})" \
         "       make sure ${SERVER_IP} is this machine's real public IP"
else
  bad "no A record for ${MAIL_HOST}"
  hint "create: ${MAIL_HOST}. A <server-ip>"
fi

# ── 3. SPF ───────────────────────────────────────────────────────────────────
echo "[DNS] SPF"
TXT="$(dig +short TXT "$DOMAIN" | tr -d '\\"')"
if echo "$TXT" | grep -q 'v=spf1'; then
  SPF="$(echo "$TXT" | tr ' ' '\n' | grep '^v=spf1' | head -1)"
  ok "SPF present ($(dig +short TXT "$DOMAIN" | grep -i 'v=spf1' | head -1 | tr -d '"'))"
  echo "$TXT" | grep -q 'v=spf1 [^ ]*mx\|v=spf1 mx\|v=spf1.* mx' || \
    warn "SPF does not include 'mx'" "       hint: recommended value: \"v=spf1 mx ~all\""
else
  bad "no SPF record for ${DOMAIN}"
  hint "create TXT: ${DOMAIN}. \"v=spf1 mx ~all\""
fi

# ── 4. DKIM ──────────────────────────────────────────────────────────────────
echo "[DNS] DKIM (${DKIM_SELECTOR}._domainkey)"
DKIM="$(dig +short TXT "${DKIM_SELECTOR}._domainkey.${DOMAIN}" | tr -d '" ')"
if echo "$DKIM" | grep -q 'v=DKIM1'; then
  ok "DKIM public key published"
else
  bad "no DKIM record at ${DKIM_SELECTOR}._domainkey.${DOMAIN}"
  if [ -f "$DKIM_KEY_FILE" ]; then
    hint "publish the key from ./deploy/dns-records.sh output (it's generated locally already)"
  else
    hint "start the stack once (docker compose up -d), then run sudo ./deploy/dns-records.sh"
  fi
fi

# ── 5. DMARC ─────────────────────────────────────────────────────────────────
echo "[DNS] DMARC"
DMARC="$(dig +short TXT "_dmarc.${DOMAIN}" | tr -d '\\"')"
dmarc_tag_value() {
  printf '%s\n' "$1" | awk -v wanted="$2" '
    {
      tag_count = split($0, tags, ";")
      for (i = 1; i <= tag_count; i++) {
        tag = tags[i]
        sub(/^[[:space:]]*/, "", tag)
        sub(/[[:space:]]*$/, "", tag)
        separator = index(tag, "=")
        if (!separator) continue
        key = substr(tag, 1, separator - 1)
        value = substr(tag, separator + 1)
        gsub(/[[:space:]]/, "", key)
        gsub(/^[[:space:]]*|[[:space:]]*$/, "", value)
        if (tolower(key) == tolower(wanted)) print tolower(value)
      }
    }
  '
}

DMARC_RECORD_COUNT="$(printf '%s\n' "$DMARC" | awk 'NF { count++ } END { print count + 0 }')"
DMARC_VERSIONS="$(dmarc_tag_value "$DMARC" v)"
DMARC_POLICIES="$(dmarc_tag_value "$DMARC" p)"
DMARC_VERSION_COUNT="$(printf '%s\n' "$DMARC_VERSIONS" | awk 'NF { count++ } END { print count + 0 }')"
DMARC_POLICY_COUNT="$(printf '%s\n' "$DMARC_POLICIES" | awk 'NF { count++ } END { print count + 0 }')"
DMARC_VERSION="$(printf '%s\n' "$DMARC_VERSIONS" | head -1)"
DMARC_POLICY="$(printf '%s\n' "$DMARC_POLICIES" | head -1)"
if [ "$DMARC_RECORD_COUNT" -ne 1 ] || [ "$DMARC_VERSION_COUNT" -ne 1 ] || \
   [ "$DMARC_POLICY_COUNT" -ne 1 ] || [ "$DMARC_VERSION" != "dmarc1" ]; then
  bad "no valid DMARC policy"
  hint "create TXT: _dmarc.${DOMAIN}. \"v=DMARC1; p=quarantine; rua=mailto:postmaster@${DOMAIN}\""
else
  case "$DMARC_POLICY" in
    none)
      warn "DMARC policy is p=none (monitoring only)" \
           "       hint: upgrade to p=quarantine after the first observation week"
      ;;
    quarantine)
      ok "DMARC policy is p=quarantine"
      hint "p=reject is the next stage after doctor.sh stays green"
      ;;
    reject)
      ok "DMARC policy is p=reject"
      ;;
    *)
      bad "no valid DMARC policy"
      hint "create TXT: _dmarc.${DOMAIN}. \"v=DMARC1; p=quarantine; rua=mailto:postmaster@${DOMAIN}\""
      ;;
  esac
fi

# ── 6. PTR (reverse DNS) ────────────────────────────────────────────────────
echo "[IP] PTR (reverse DNS)"
if [ -n "$SERVER_IP" ]; then
  PTR="$(dig +short -x "$SERVER_IP" | sed 's/\.$//' | head -1)"
  if [ "$PTR" = "$MAIL_HOST" ]; then
    ok "PTR ${SERVER_IP} -> ${PTR}"
  elif [ -n "$PTR" ]; then
    warn "PTR is '${PTR}', expected '${MAIL_HOST}'" \
         "       hint: set rDNS at your VPS host (many providers: rename the instance to ${MAIL_HOST})"
  else
    bad "no PTR record for ${SERVER_IP}"
    hint "set reverse DNS to ${MAIL_HOST} at your VPS provider — many spam filters reject mail without it"
  fi
else
  warn "server IP unknown — skipping PTR/DNSBL/port-25 checks" \
       "       hint: re-run as ./deploy/doctor.sh <server-public-ipv4>"
fi

# ── 7. Outbound port 25 ─────────────────────────────────────────────────────
echo "[NET] Outbound port 25"
if curl -s --max-time 6 "telnet://gmail-smtp-in.l.google.com:25" </dev/null 2>/dev/null | grep -q '^220'; then
  ok "can reach an external MX on port 25 (direct sending possible)"
else
  warn "outbound port 25 appears blocked/filtered" \
       "       hint: many VPS providers block it — request unblocking, or configure a relay in .env (RELAY_HOST, e.g. Amazon SES)"
fi

# ── 8. DNSBL listings ───────────────────────────────────────────────────────
echo "[IP] DNS blocklists"
if [ -n "$SERVER_IP" ]; then
  REV="$(reverse_ip "$SERVER_IP")"
  for BL in zen.spamhaus.org bl.spamcop.net b.barracudacentral.org; do
    R="$(dig +short "${REV}.${BL}" | grep -E '^127\.' | head -1 || true)"
    if [ -n "$R" ]; then
      bad "IP ${SERVER_IP} is LISTED on ${BL} (${R})"
      hint "delisting: check ${BL}'s lookup page; if this is a fresh VPS IP, consider replacing it or using a relay"
    else
      ok "not listed on ${BL}"
    fi
  done
fi

# ── 9. TLS on 465 / 993 ─────────────────────────────────────────────────────
echo "[TLS] Certificates"
for PORT in 465 993; do
  CERT="$(echo | openssl s_client -connect "${MAIL_HOST}:${PORT}" -servername "$MAIL_HOST" 2>/dev/null)"
  if echo "$CERT" | openssl x509 -noout -enddate -checkend 604800 >/dev/null 2>&1; then
    EXPIRY="$(echo "$CERT" | openssl x509 -noout -enddate | cut -d= -f2)"
    ok "port ${PORT}: cert valid until ${EXPIRY}"
  elif echo "$CERT" | openssl x509 -noout >/dev/null 2>&1; then
    warn "port ${PORT}: cert expires within 7 days" \
         "       hint: if using Let's Encrypt, check DMS cert renewal; else re-issue"
  else
    VERIFY="$(echo "$CERT" | grep -i 'verify error' | head -1)"
    if echo "$CERT" | grep -q 'BEGIN CERTIFICATE'; then
      warn "port ${PORT}: cert present but not trusted/expired (${VERIFY:-unparsable})" \
           "       hint: a self-signed cert is OK for agent-to-agent use; enable SSL_TYPE=letsencrypt in .env for real trust"
    else
      bad "port ${PORT}: no TLS cert (is the mailserver up? DNS pointed here?)"
      hint "docker compose ps; docker compose logs mailserver"
    fi
  fi
done

# ── 10. ntfy server-side self-check ─────────────────────────────────────────
echo "[NTFY] Notification transport"
if [ "$NTFY_ENABLED" = "false" ]; then
  warn "ntfy API/watcher disabled (NTFY_ENABLED=false)" \
       "       hint: the ntfy container still runs by design; set true to enable server-side notifications"
elif [ -z "$API_KEY" ]; then
  bad "API_KEYS missing; cannot run notify_verify"
  hint "set API_KEYS in .env, then re-run doctor"
else
  VERIFY_RESPONSE="$(curl -sS --max-time 12 \
    -H "Authorization: Bearer ${API_KEY}" \
    -H 'Content-Type: application/json' \
    -X POST "http://127.0.0.1:${API_PORT}/v1/notify/verify" 2>/dev/null || true)"
  if echo "$VERIFY_RESPONSE" | grep -q '"ok":true'; then
    ok "ntfy publish + cache poll verified"
  else
    bad "ntfy notify_verify failed"
    hint "docker compose ps ntfy; docker compose logs ntfy api"
  fi
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo "──────────────────────────────────────────────────────────────"
printf 'Result: \033[32m%d pass\033[0m, \033[33m%d warn\033[0m, \033[31m%d fail\033[0m\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
