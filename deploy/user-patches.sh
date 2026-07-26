#!/bin/bash
# docker-mailserver "user-patches" hook — runs INSIDE the mailserver container at
# the end of every startup (mounted to /tmp/docker-mailserver/user-patches.sh).
# Idempotent: safe on every restart.
#
# Provisions everything openagent.email needs on the mail side:
#   1. ONE catch-all mailbox account ($MAIL_ACCOUNT@$DOMAIN)
#   2. A wildcard alias (@$DOMAIN -> that account) so ANY identity address
#      (fox-k7d2@$DOMAIN, ...) lands in the same mailbox. The api then matches
#      messages to identities via the To/Delivered-To headers over IMAP.
#      Because every address is an alias of the authenticated account,
#      docker-mailserver's sender-login checks also allow SENDING with a
#      rewritten From of any identity address.
#   3. DKIM keys for $DOMAIN (selector "mail") if missing. The public key lands
#      in config/opendkim/keys/$DOMAIN/mail.txt for deploy/dns-records.sh.

set -e

DOMAIN="${OVERRIDE_HOSTNAME#mail.}"            # strip the mail. prefix
ACCOUNT="${MAIL_ACCOUNT:-agent}@${DOMAIN}"

echo "[openagent] provisioning catch-all account: ${ACCOUNT}"

# 1. mailbox account (setup email add is idempotent-ish; skip if present)
if ! grep -q "^${ACCOUNT}|" /tmp/docker-mailserver/postfix-accounts.cf 2>/dev/null; then
  setup email add "${ACCOUNT}" "${MAIL_PASSWORD}"
  echo "[openagent] account created"
else
  echo "[openagent] account already exists, skipping"
fi

# 2. wildcard catch-all alias
if ! grep -q "^@${DOMAIN} " /tmp/docker-mailserver/postfix-virtual.cf 2>/dev/null; then
  setup alias add "@${DOMAIN}" "${ACCOUNT}"
  echo "[openagent] catch-all alias @${DOMAIN} -> ${ACCOUNT} created"
else
  echo "[openagent] catch-all alias already exists, skipping"
fi

# 3. DKIM keys (first boot only)
if [ ! -f "/tmp/docker-mailserver/opendkim/keys/${DOMAIN}/mail.txt" ]; then
  echo "[openagent] generating DKIM keys for ${DOMAIN} (selector: mail)"
  setup config dkim domain "${DOMAIN}" selector mail
fi

echo "[openagent] provisioning complete"
