#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

FIXTURE_ROOT="$TMP_ROOT/repo"
FAKE_BIN="$TMP_ROOT/bin"
mkdir -p "$FIXTURE_ROOT/deploy" "$FAKE_BIN"
cp "$REPO_ROOT/deploy/dns-records.sh" "$REPO_ROOT/deploy/doctor.sh" "$FIXTURE_ROOT/deploy/"
printf '%s\n' 'DOMAIN=example.test' 'API_KEYS=test-admin-key' > "$FIXTURE_ROOT/.env"
chmod 600 "$FIXTURE_ROOT/.env"

cat > "$FAKE_BIN/dig" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"+short MX "*) printf '%s\n' '10 mail.example.test.' ;;
  *"+short A "*) printf '%s\n' '203.0.113.10' ;;
  *"+short -x "*) printf '%s\n' 'mail.example.test.' ;;
  *"_dmarc.example.test"*) [ -z "${DMARC_ANSWER:-}" ] || printf '%s\n' "$DMARC_ANSWER" ;;
  *"mail._domainkey.example.test"*) printf '%s\n' '"v=DKIM1; k=rsa; p=test"' ;;
  *"+short TXT example.test"*) printf '%s\n' '"v=spf1 mx ~all"' ;;
  *".zen.spamhaus.org"*|*".bl.spamcop.net"*|*".b.barracudacentral.org"*) ;;
  *) printf 'unexpected dig query: %s\n' "$*" >&2; exit 2 ;;
esac
EOF

cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"telnet://"*) printf '%s\n' '220 fixture ESMTP' ;;
  *) printf '%s\n' '{"ok":true}' ;;
esac
EOF

cat > "$FAKE_BIN/openssl" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  s_client) printf '%s\n' '-----BEGIN CERTIFICATE-----' 'fixture' '-----END CERTIFICATE-----' ;;
  x509)
    case "$*" in
      *"-checkend"*) exit 0 ;;
      *"-enddate"*) printf '%s\n' 'notAfter=Dec 31 23:59:59 2030 GMT' ;;
      *) exit 0 ;;
    esac
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$FAKE_BIN/dig" "$FAKE_BIN/curl" "$FAKE_BIN/openssl"

run_doctor() {
  local answer="$1"
  local output_file="$2"
  set +e
  (cd "$FIXTURE_ROOT" && DMARC_ANSWER="$answer" PATH="$FAKE_BIN:$PATH" bash deploy/doctor.sh 203.0.113.10) >"$output_file" 2>&1
  DOCTOR_STATUS=$?
  set -e
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$file" || {
    printf 'expected output to contain: %s\n' "$expected" >&2
    sed -n '1,240p' "$file" >&2
    exit 1
  }
}

DNS_OUTPUT="$TMP_ROOT/dns-records.out"
(cd "$FIXTURE_ROOT" && bash deploy/dns-records.sh 203.0.113.10) >"$DNS_OUTPUT"
assert_contains "$DNS_OUTPUT" '_dmarc.example.test.   TXT   "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.test"'
assert_contains "$DNS_OUTPUT" 'Start with p=quarantine. For the first observation week, you may use p=none. After doctor.sh is green, move to p=reject.'

INVALID_OUTPUT="$TMP_ROOT/invalid.out"
run_doctor '"v=DMARC1; sp=none; rua=mailto:postmaster@example.test"' "$INVALID_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'invalid DMARC must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$INVALID_OUTPUT" 'FAIL'
assert_contains "$INVALID_OUTPUT" 'no valid DMARC policy'
assert_contains "$INVALID_OUTPUT" 'create TXT: _dmarc.example.test. "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.test"'

MISSING_OUTPUT="$TMP_ROOT/missing.out"
run_doctor '' "$MISSING_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'missing DMARC must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$MISSING_OUTPUT" 'FAIL'
assert_contains "$MISSING_OUTPUT" 'no valid DMARC policy'
assert_contains "$MISSING_OUTPUT" 'create TXT: _dmarc.example.test. "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.test"'

DUPLICATE_OUTPUT="$TMP_ROOT/duplicate.out"
run_doctor '"v=DMARC1; p=reject; p=none"' "$DUPLICATE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'duplicate DMARC policy tags must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$DUPLICATE_OUTPUT" 'FAIL'
assert_contains "$DUPLICATE_OUTPUT" 'no valid DMARC policy'

MULTIPLE_OUTPUT="$TMP_ROOT/multiple.out"
run_doctor $'"v=DMARC1; p=reject"\n"v=DMARC1; p=none"' "$MULTIPLE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'multiple DMARC records must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$MULTIPLE_OUTPUT" 'FAIL'
assert_contains "$MULTIPLE_OUTPUT" 'no valid DMARC policy'

UNRELATED_OUTPUT="$TMP_ROOT/unrelated.out"
run_doctor $'"site-verification=fixture"\n"v=DMARC1; p=none; rua=mailto:postmaster@example.test"' "$UNRELATED_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'unrelated TXT plus one DMARC record must not fail doctor\n' >&2; sed -n '1,240p' "$UNRELATED_OUTPUT" >&2; exit 1; }
assert_contains "$UNRELATED_OUTPUT" 'WARN'
assert_contains "$UNRELATED_OUTPUT" 'DMARC policy is p=none'

CNAME_OUTPUT="$TMP_ROOT/cname.out"
run_doctor $'_dmarc.provider.example.\n"v=DMARC1; p=quarantine"' "$CNAME_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'CNAME answer plus one DMARC record must not fail doctor\n' >&2; sed -n '1,240p' "$CNAME_OUTPUT" >&2; exit 1; }
assert_contains "$CNAME_OUTPUT" 'PASS'
assert_contains "$CNAME_OUTPUT" 'DMARC policy is p=quarantine'

SPLIT_OUTPUT="$TMP_ROOT/split.out"
run_doctor '"v=DMARC1; p=quaran" "tine; rua=mailto:postmaster@example.test"' "$SPLIT_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'split DMARC TXT RR must not fail doctor\n' >&2; sed -n '1,240p' "$SPLIT_OUTPUT" >&2; exit 1; }
assert_contains "$SPLIT_OUTPUT" 'PASS'
assert_contains "$SPLIT_OUTPUT" 'DMARC policy is p=quarantine'

LOWERCASE_VERSION_OUTPUT="$TMP_ROOT/lowercase-version.out"
run_doctor '"v=dmarc1; p=reject"' "$LOWERCASE_VERSION_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'lowercase DMARC version must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$LOWERCASE_VERSION_OUTPUT" 'FAIL'
assert_contains "$LOWERCASE_VERSION_OUTPUT" 'no valid DMARC policy'

VERSION_NOT_FIRST_OUTPUT="$TMP_ROOT/version-not-first.out"
run_doctor '"rua=mailto:postmaster@example.test; v=DMARC1; p=reject"' "$VERSION_NOT_FIRST_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'DMARC version not first must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$VERSION_NOT_FIRST_OUTPUT" 'FAIL'
assert_contains "$VERSION_NOT_FIRST_OUTPUT" 'no valid DMARC policy'

POLICY_LATER_OUTPUT="$TMP_ROOT/policy-later.out"
run_doctor '"v=DMARC1; rua=mailto:postmaster@example.test; p=reject"' "$POLICY_LATER_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'DMARC policy after another tag must not fail doctor\n' >&2; sed -n '1,240p' "$POLICY_LATER_OUTPUT" >&2; exit 1; }
assert_contains "$POLICY_LATER_OUTPUT" 'PASS'
assert_contains "$POLICY_LATER_OUTPUT" 'DMARC policy is p=reject'

REJECT_TEST_MODE_OUTPUT="$TMP_ROOT/reject-test-mode.out"
run_doctor '"v=DMARC1; p=reject; t=y"' "$REJECT_TEST_MODE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'p=reject with t=y must retain effective quarantine without failing doctor\n' >&2; sed -n '1,240p' "$REJECT_TEST_MODE_OUTPUT" >&2; exit 1; }
assert_contains "$REJECT_TEST_MODE_OUTPUT" 'PASS'
assert_contains "$REJECT_TEST_MODE_OUTPUT" 'configured p=reject; t=y; effective policy is p=quarantine'
assert_contains "$REJECT_TEST_MODE_OUTPUT" 'remove t=y or set t=n to enforce p=reject'

QUARANTINE_TEST_MODE_OUTPUT="$TMP_ROOT/quarantine-test-mode.out"
run_doctor '"v=DMARC1; p=quarantine; T=Y"' "$QUARANTINE_TEST_MODE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'p=quarantine with t=y must retain effective none without failing doctor\n' >&2; sed -n '1,240p' "$QUARANTINE_TEST_MODE_OUTPUT" >&2; exit 1; }
assert_contains "$QUARANTINE_TEST_MODE_OUTPUT" 'WARN'
assert_contains "$QUARANTINE_TEST_MODE_OUTPUT" 'configured p=quarantine; t=y; effective policy is p=none'
assert_contains "$QUARANTINE_TEST_MODE_OUTPUT" 'remove t=y or set t=n to enforce p=quarantine'

DUPLICATE_TEST_MODE_OUTPUT="$TMP_ROOT/duplicate-test-mode.out"
run_doctor '"v=DMARC1; p=reject; t=n; t=y"' "$DUPLICATE_TEST_MODE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'duplicate DMARC test-mode tags must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$DUPLICATE_TEST_MODE_OUTPUT" 'FAIL'
assert_contains "$DUPLICATE_TEST_MODE_OUTPUT" 'no valid DMARC policy'

INVALID_TEST_MODE_OUTPUT="$TMP_ROOT/invalid-test-mode.out"
run_doctor '"v=DMARC1; p=reject; t=maybe"' "$INVALID_TEST_MODE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'invalid DMARC test-mode value must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$INVALID_TEST_MODE_OUTPUT" 'FAIL'
assert_contains "$INVALID_TEST_MODE_OUTPUT" 'no valid DMARC policy'

NONE_OUTPUT="$TMP_ROOT/none.out"
run_doctor '"v=DMARC1; P = NoNe; rua=mailto:postmaster@example.test; SP = reject"' "$NONE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'p=none must not fail doctor\n' >&2; sed -n '1,240p' "$NONE_OUTPUT" >&2; exit 1; }
assert_contains "$NONE_OUTPUT" 'WARN'
assert_contains "$NONE_OUTPUT" 'DMARC policy is p=none'
assert_contains "$NONE_OUTPUT" 'upgrade to p=quarantine'

QUARANTINE_OUTPUT="$TMP_ROOT/quarantine.out"
run_doctor '"V=DMARC1; P = Quarantine; SP=none; rua=mailto:postmaster@example.test"' "$QUARANTINE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'p=quarantine must pass doctor\n' >&2; exit 1; }
assert_contains "$QUARANTINE_OUTPUT" 'PASS'
assert_contains "$QUARANTINE_OUTPUT" 'DMARC policy is p=quarantine'
assert_contains "$QUARANTINE_OUTPUT" 'hint: p=reject is the next stage after doctor.sh stays green'
if grep -F 'DMARC policy is p=quarantine' "$QUARANTINE_OUTPUT" | grep -Fq 'WARN'; then
  printf 'p=quarantine must not be a warning\n' >&2
  exit 1
fi

REJECT_OUTPUT="$TMP_ROOT/reject.out"
run_doctor '"v=DMARC1; p = REJECT; sp=none"' "$REJECT_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'p=reject must pass doctor\n' >&2; exit 1; }
assert_contains "$REJECT_OUTPUT" 'PASS'
assert_contains "$REJECT_OUTPUT" 'DMARC policy is p=reject'
if grep -Fq 'DMARC policy is p=none' "$REJECT_OUTPUT"; then
  printf 'sp=none must not be mistaken for p=none\n' >&2
  exit 1
fi

printf '%s\n' 'mail-security shell tests: 18 passed'
