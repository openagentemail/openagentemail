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

DUPLICATE_NON_CORE_OUTPUT="$TMP_ROOT/duplicate-non-core.out"
run_doctor '"v=DMARC1; p=reject; rua=mailto:first@example.test; RUA=mailto:second@example.test"' "$DUPLICATE_NON_CORE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'duplicate normalized DMARC tag names must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$DUPLICATE_NON_CORE_OUTPUT" 'FAIL'
assert_contains "$DUPLICATE_NON_CORE_OUTPUT" 'no valid DMARC policy'

MALFORMED_POLICY_OUTPUT="$TMP_ROOT/malformed-policy.out"
run_doctor '"v=DMARC1; p=reject bogus"' "$MALFORMED_POLICY_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'malformed DMARC policy must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$MALFORMED_POLICY_OUTPUT" 'FAIL'
assert_contains "$MALFORMED_POLICY_OUTPUT" 'no valid DMARC policy'

MISSING_SEPARATOR_OUTPUT="$TMP_ROOT/missing-separator.out"
run_doctor '"v=DMARC1; p=reject; rua"' "$MISSING_SEPARATOR_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'DMARC tag missing = must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$MISSING_SEPARATOR_OUTPUT" 'FAIL'
assert_contains "$MISSING_SEPARATOR_OUTPUT" 'no valid DMARC policy'

EMPTY_VALUE_OUTPUT="$TMP_ROOT/empty-value.out"
run_doctor '"v=DMARC1; p=reject; rua="' "$EMPTY_VALUE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'DMARC tag with empty value must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$EMPTY_VALUE_OUTPUT" 'FAIL'
assert_contains "$EMPTY_VALUE_OUTPUT" 'no valid DMARC policy'

INVALID_KEY_OUTPUT="$TMP_ROOT/invalid-key.out"
run_doctor '"v=DMARC1; p=reject; r1ua=mailto:postmaster@example.test"' "$INVALID_KEY_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'non-alphabetic DMARC tag name must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$INVALID_KEY_OUTPUT" 'FAIL'
assert_contains "$INVALID_KEY_OUTPUT" 'no valid DMARC policy'

INTERIOR_EMPTY_OUTPUT="$TMP_ROOT/interior-empty.out"
run_doctor '"v=DMARC1; p=reject;; rua=mailto:postmaster@example.test"' "$INTERIOR_EMPTY_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'interior empty DMARC tag fragment must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$INTERIOR_EMPTY_OUTPUT" 'FAIL'
assert_contains "$INTERIOR_EMPTY_OUTPUT" 'no valid DMARC policy'

UNKNOWN_TRAILING_OUTPUT="$TMP_ROOT/unknown-trailing.out"
run_doctor '"v=DMARC1; x=value; p=reject;"' "$UNKNOWN_TRAILING_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'valid unknown DMARC tag and trailing separator must not fail doctor\n' >&2; sed -n '1,240p' "$UNKNOWN_TRAILING_OUTPUT" >&2; exit 1; }
assert_contains "$UNKNOWN_TRAILING_OUTPUT" 'PASS'
assert_contains "$UNKNOWN_TRAILING_OUTPUT" 'DMARC policy is p=reject'

NON_ASCII_VALUE_OUTPUT="$TMP_ROOT/non-ascii-value.out"
run_doctor '"v=DMARC1; p=reject; x=é"' "$NON_ASCII_VALUE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'non-ASCII DMARC tag value must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$NON_ASCII_VALUE_OUTPUT" 'FAIL'
assert_contains "$NON_ASCII_VALUE_OUTPUT" 'no valid DMARC policy'

TAB_VALUE_OUTPUT="$TMP_ROOT/tab-value.out"
run_doctor $'"v=DMARC1; p=reject; x=hello\tworld"' "$TAB_VALUE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'control byte in DMARC tag value must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$TAB_VALUE_OUTPUT" 'FAIL'
assert_contains "$TAB_VALUE_OUTPUT" 'no valid DMARC policy'

LEADING_WSP_OUTPUT="$TMP_ROOT/leading-wsp.out"
run_doctor '"  v=DMARC1; p=reject"' "$LEADING_WSP_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'leading WSP before DMARC version must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$LEADING_WSP_OUTPUT" 'FAIL'
assert_contains "$LEADING_WSP_OUTPUT" 'no valid DMARC policy'

VALID_WSP_OUTPUT="$TMP_ROOT/valid-wsp.out"
run_doctor '"v = DMARC1;   p = reject;   x = value"' "$VALID_WSP_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'valid DMARC WSP around = and after separators must not fail doctor\n' >&2; sed -n '1,240p' "$VALID_WSP_OUTPUT" >&2; exit 1; }
assert_contains "$VALID_WSP_OUTPUT" 'PASS'
assert_contains "$VALID_WSP_OUTPUT" 'DMARC policy is p=reject'

DECIMAL_HTAB_WSP_OUTPUT="$TMP_ROOT/decimal-htab-wsp.out"
run_doctor '"v\009=\009DMARC1\009;\009p\009=\009reject\009;"' "$DECIMAL_HTAB_WSP_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'decimal-escaped HTAB in equals/separator WSP must not fail doctor\n' >&2; sed -n '1,240p' "$DECIMAL_HTAB_WSP_OUTPUT" >&2; exit 1; }
assert_contains "$DECIMAL_HTAB_WSP_OUTPUT" 'PASS'
assert_contains "$DECIMAL_HTAB_WSP_OUTPUT" 'DMARC policy is p=reject'

DECIMAL_CONTROL_OUTPUT="$TMP_ROOT/decimal-control.out"
run_doctor '"v=DMARC1; p=reject; x=\009"' "$DECIMAL_CONTROL_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'decimal-escaped control byte must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$DECIMAL_CONTROL_OUTPUT" 'FAIL'
assert_contains "$DECIMAL_CONTROL_OUTPUT" 'no valid DMARC policy'

DECIMAL_NON_ASCII_OUTPUT="$TMP_ROOT/decimal-non-ascii.out"
run_doctor '"v=DMARC1; p=reject; x=\195\169"' "$DECIMAL_NON_ASCII_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'decimal-escaped non-ASCII bytes must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$DECIMAL_NON_ASCII_OUTPUT" 'FAIL'
assert_contains "$DECIMAL_NON_ASCII_OUTPUT" 'no valid DMARC policy'

PRINTABLE_DECIMAL_OUTPUT="$TMP_ROOT/printable-decimal.out"
run_doctor '"v=DMARC1; p=reject; x=\065"' "$PRINTABLE_DECIMAL_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'printable decimal TXT escape must not fail doctor\n' >&2; sed -n '1,240p' "$PRINTABLE_DECIMAL_OUTPUT" >&2; exit 1; }
assert_contains "$PRINTABLE_DECIMAL_OUTPUT" 'PASS'
assert_contains "$PRINTABLE_DECIMAL_OUTPUT" 'DMARC policy is p=reject'

ESCAPED_BACKSLASH_OUTPUT="$TMP_ROOT/escaped-backslash.out"
run_doctor '"v=DMARC1; p=reject; x=left\\right"' "$ESCAPED_BACKSLASH_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'literal escaped backslash in valid unknown value must not fail doctor\n' >&2; sed -n '1,240p' "$ESCAPED_BACKSLASH_OUTPUT" >&2; exit 1; }
assert_contains "$ESCAPED_BACKSLASH_OUTPUT" 'PASS'
assert_contains "$ESCAPED_BACKSLASH_OUTPUT" 'DMARC policy is p=reject'

ESCAPED_QUOTE_OUTPUT="$TMP_ROOT/escaped-quote.out"
run_doctor '"v=DMARC1; p=reject; x=left\"right"' "$ESCAPED_QUOTE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'literal escaped quote in valid unknown value must not fail doctor\n' >&2; sed -n '1,240p' "$ESCAPED_QUOTE_OUTPUT" >&2; exit 1; }
assert_contains "$ESCAPED_QUOTE_OUTPUT" 'PASS'
assert_contains "$ESCAPED_QUOTE_OUTPUT" 'DMARC policy is p=reject'

TERMINAL_POLICY_SP_OUTPUT="$TMP_ROOT/terminal-policy-sp.out"
run_doctor '"v=DMARC1; p=reject "' "$TERMINAL_POLICY_SP_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'terminal SP in DMARC policy must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$TERMINAL_POLICY_SP_OUTPUT" 'FAIL'
assert_contains "$TERMINAL_POLICY_SP_OUTPUT" 'no valid DMARC policy'

TERMINAL_POLICY_TAB_OUTPUT="$TMP_ROOT/terminal-policy-tab.out"
run_doctor $'"v=DMARC1; p=reject\t"' "$TERMINAL_POLICY_TAB_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'terminal TAB in DMARC policy must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$TERMINAL_POLICY_TAB_OUTPUT" 'FAIL'
assert_contains "$TERMINAL_POLICY_TAB_OUTPUT" 'no valid DMARC policy'

TERMINAL_TEST_SP_OUTPUT="$TMP_ROOT/terminal-test-sp.out"
run_doctor '"v=DMARC1; p=reject; t=y "' "$TERMINAL_TEST_SP_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'terminal SP in DMARC test mode must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$TERMINAL_TEST_SP_OUTPUT" 'FAIL'
assert_contains "$TERMINAL_TEST_SP_OUTPUT" 'no valid DMARC policy'

TERMINAL_TEST_TAB_OUTPUT="$TMP_ROOT/terminal-test-tab.out"
run_doctor $'"v=DMARC1; p=reject; t=y\t"' "$TERMINAL_TEST_TAB_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'terminal TAB in DMARC test mode must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$TERMINAL_TEST_TAB_OUTPUT" 'FAIL'
assert_contains "$TERMINAL_TEST_TAB_OUTPUT" 'no valid DMARC policy'

TERMINAL_POLICY_DECIMAL_HTAB_OUTPUT="$TMP_ROOT/terminal-policy-decimal-htab.out"
run_doctor '"v=DMARC1; p=reject\009"' "$TERMINAL_POLICY_DECIMAL_HTAB_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'terminal decimal-escaped HTAB in DMARC policy must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$TERMINAL_POLICY_DECIMAL_HTAB_OUTPUT" 'FAIL'
assert_contains "$TERMINAL_POLICY_DECIMAL_HTAB_OUTPUT" 'no valid DMARC policy'

TERMINAL_TEST_DECIMAL_HTAB_OUTPUT="$TMP_ROOT/terminal-test-decimal-htab.out"
run_doctor '"v=DMARC1; p=reject; t=y\009"' "$TERMINAL_TEST_DECIMAL_HTAB_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'terminal decimal-escaped HTAB in DMARC test mode must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$TERMINAL_TEST_DECIMAL_HTAB_OUTPUT" 'FAIL'
assert_contains "$TERMINAL_TEST_DECIMAL_HTAB_OUTPUT" 'no valid DMARC policy'

WSP_BEFORE_SEPARATOR_OUTPUT="$TMP_ROOT/wsp-before-separator.out"
run_doctor $'"v=DMARC1; p=reject \t ; t=n"' "$WSP_BEFORE_SEPARATOR_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'WSP before a real DMARC separator must not fail doctor\n' >&2; sed -n '1,240p' "$WSP_BEFORE_SEPARATOR_OUTPUT" >&2; exit 1; }
assert_contains "$WSP_BEFORE_SEPARATOR_OUTPUT" 'PASS'
assert_contains "$WSP_BEFORE_SEPARATOR_OUTPUT" 'DMARC policy is p=reject'

TRAILING_SEPARATOR_WSP_OUTPUT="$TMP_ROOT/trailing-separator-wsp.out"
run_doctor '"v=DMARC1; p=reject;   "' "$TRAILING_SEPARATOR_WSP_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'single trailing separator WSP must not fail doctor\n' >&2; sed -n '1,240p' "$TRAILING_SEPARATOR_WSP_OUTPUT" >&2; exit 1; }
assert_contains "$TRAILING_SEPARATOR_WSP_OUTPUT" 'PASS'
assert_contains "$TRAILING_SEPARATOR_WSP_OUTPUT" 'DMARC policy is p=reject'

VALID_PLUS_NUL_CANDIDATE_OUTPUT="$TMP_ROOT/valid-plus-nul-candidate.out"
run_doctor '"v=DMARC1; p=reject"'$'\n''"v=DMARC1; p=none; x=\000"' "$VALID_PLUS_NUL_CANDIDATE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'valid plus later-NUL DMARC candidates must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$VALID_PLUS_NUL_CANDIDATE_OUTPUT" 'FAIL'
assert_contains "$VALID_PLUS_NUL_CANDIDATE_OUTPUT" 'no valid DMARC policy'

VALID_PLUS_HTAB_CANDIDATE_OUTPUT="$TMP_ROOT/valid-plus-htab-candidate.out"
run_doctor '"v=DMARC1; p=reject"'$'\n''"v=DMARC1; p=none; x=bad\009value"' "$VALID_PLUS_HTAB_CANDIDATE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'valid plus later-invalid-HTAB DMARC candidates must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$VALID_PLUS_HTAB_CANDIDATE_OUTPUT" 'FAIL'
assert_contains "$VALID_PLUS_HTAB_CANDIDATE_OUTPUT" 'no valid DMARC policy'

VALID_PLUS_NON_ASCII_CANDIDATE_OUTPUT="$TMP_ROOT/valid-plus-non-ascii-candidate.out"
run_doctor '"v=DMARC1; p=reject"'$'\n''"v=DMARC1; p=none; x=\195\169"' "$VALID_PLUS_NON_ASCII_CANDIDATE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'valid plus later-non-ASCII DMARC candidates must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$VALID_PLUS_NON_ASCII_CANDIDATE_OUTPUT" 'FAIL'
assert_contains "$VALID_PLUS_NON_ASCII_CANDIDATE_OUTPUT" 'no valid DMARC policy'

VALID_PLUS_OUT_OF_RANGE_CANDIDATE_OUTPUT="$TMP_ROOT/valid-plus-out-of-range-candidate.out"
run_doctor '"v=DMARC1; p=reject"'$'\n''"v=DMARC1; p=none; x=\256"' "$VALID_PLUS_OUT_OF_RANGE_CANDIDATE_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'valid plus later-out-of-range DMARC candidates must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$VALID_PLUS_OUT_OF_RANGE_CANDIDATE_OUTPUT" 'FAIL'
assert_contains "$VALID_PLUS_OUT_OF_RANGE_CANDIDATE_OUTPUT" 'no valid DMARC policy'

INVALID_UNRELATED_CONTROL_OUTPUT="$TMP_ROOT/invalid-unrelated-control.out"
run_doctor '"site-verification=bad\000value"'$'\n''"v=DMARC1; p=reject"' "$INVALID_UNRELATED_CONTROL_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'invalid unrelated TXT plus one valid DMARC candidate must not fail doctor\n' >&2; sed -n '1,240p' "$INVALID_UNRELATED_CONTROL_OUTPUT" >&2; exit 1; }
assert_contains "$INVALID_UNRELATED_CONTROL_OUTPUT" 'PASS'
assert_contains "$INVALID_UNRELATED_CONTROL_OUTPUT" 'DMARC policy is p=reject'

INVALID_FIRST_TAG_OUTPUT="$TMP_ROOT/invalid-first-tag.out"
run_doctor '"v=DM\000ARC1; p=none"'$'\n''"v=DMARC1; p=reject"' "$INVALID_FIRST_TAG_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'invalid byte inside first tag must not manufacture a DMARC candidate\n' >&2; sed -n '1,240p' "$INVALID_FIRST_TAG_OUTPUT" >&2; exit 1; }
assert_contains "$INVALID_FIRST_TAG_OUTPUT" 'PASS'
assert_contains "$INVALID_FIRST_TAG_OUTPUT" 'DMARC policy is p=reject'

VALID_SUBPOLICIES_OUTPUT="$TMP_ROOT/valid-subpolicies.out"
run_doctor '"v=DMARC1; p=reject; SP=NoNe; nP=QuArAnTiNe"' "$VALID_SUBPOLICIES_OUTPUT"
[ "$DOCTOR_STATUS" -eq 0 ] || { printf 'valid mixed-case sp/np policies must not fail doctor\n' >&2; sed -n '1,240p' "$VALID_SUBPOLICIES_OUTPUT" >&2; exit 1; }
assert_contains "$VALID_SUBPOLICIES_OUTPUT" 'PASS'
assert_contains "$VALID_SUBPOLICIES_OUTPUT" 'DMARC policy is p=reject'

INVALID_SP_OUTPUT="$TMP_ROOT/invalid-sp.out"
run_doctor '"v=DMARC1; p=reject; sp=bogus"' "$INVALID_SP_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'invalid sp must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$INVALID_SP_OUTPUT" 'FAIL'
assert_contains "$INVALID_SP_OUTPUT" 'no valid DMARC policy'

INVALID_SP_RUA_OUTPUT="$TMP_ROOT/invalid-sp-rua.out"
run_doctor '"v=DMARC1; p=reject; sp=bogus; rua=mailto:a@example.test"' "$INVALID_SP_RUA_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'invalid sp with rua must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$INVALID_SP_RUA_OUTPUT" 'FAIL'
assert_contains "$INVALID_SP_RUA_OUTPUT" 'no valid DMARC policy'

INVALID_NP_OUTPUT="$TMP_ROOT/invalid-np.out"
run_doctor '"v=DMARC1; p=reject; np=bogus"' "$INVALID_NP_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'invalid np must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$INVALID_NP_OUTPUT" 'FAIL'
assert_contains "$INVALID_NP_OUTPUT" 'no valid DMARC policy'

INVALID_NP_RUA_OUTPUT="$TMP_ROOT/invalid-np-rua.out"
run_doctor '"v=DMARC1; p=reject; np=bogus; rua=mailto:a@example.test"' "$INVALID_NP_RUA_OUTPUT"
[ "$DOCTOR_STATUS" -eq 1 ] || { printf 'invalid np with rua must exit 1, got %s\n' "$DOCTOR_STATUS" >&2; exit 1; }
assert_contains "$INVALID_NP_RUA_OUTPUT" 'FAIL'
assert_contains "$INVALID_NP_RUA_OUTPUT" 'no valid DMARC policy'

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

printf '%s\n' 'mail-security shell tests: 54 passed'
