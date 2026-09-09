#!/bin/sh
# Independent HTTPS probe. Run on a different host than the receiver.
# Default: every 30s, alarm after two failures, recovery notice, cooldown.
# State is plain key=value in a durable file — never sourced as shell.
# Alert is one absolute binary plus a fixed code argument, with a timeout.

set -eu

HEALTH_URL="${HEALTH_URL:-https://webhook-wake.example.com/health}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-2}"
COOLDOWN_SEC="${COOLDOWN_SEC:-300}"
CURL_BIN="${CURL_BIN:-curl}"
ALERT_BIN="${ALERT_BIN:-${ALERT_CMD:-}}"
ALERT_TIMEOUT_SEC="${ALERT_TIMEOUT_SEC:-2}"
TIMEOUT_BIN="${TIMEOUT_BIN:-timeout}"
STATE_FILE="${STATE_FILE:-/var/lib/webhook-wake-monitor/state}"
NOW_SEC="${NOW_SEC:-}"

consecutive=0
alarming=0
pending_recovery=0
last_alert=0

is_uint() {
	case "$1" in
		''|*[!0-9]*) return 1 ;;
		*) return 0 ;;
	esac
}

# Reject empty/signed/non-integer values before any arithmetic or cooldown math.
# Env knobs: at most 9 digits. Epochs (now / last_alert / NOW_SEC) are 10-digit
# Unix seconds today — do not reuse the 9-digit env cap on timestamps.
require_uint_ge() {
	name=$1
	value=$2
	min=$3
	if ! is_uint "$value" || [ "${#value}" -gt 9 ] || [ "$value" -lt "$min" ]; then
		echo "monitor_config_invalid $name" >&2
		exit 2
	fi
}

require_uint_ge FAIL_THRESHOLD "$FAIL_THRESHOLD" 1
require_uint_ge COOLDOWN_SEC "$COOLDOWN_SEC" 0
require_uint_ge ALERT_TIMEOUT_SEC "$ALERT_TIMEOUT_SEC" 1

# Consecutive is a counter (9 digits). last_alert is an epoch (10 digits).
# Overlong all-digit fields fail visibly so [ / $(( )) never see Illegal number.
accept_state_uint() {
	name=$1
	value=$2
	max_len=$3
	if ! is_uint "$value"; then
		return 1
	fi
	if [ "${#value}" -gt "$max_len" ]; then
		echo "monitor_config_invalid_state $name" >&2
		exit 2
	fi
	return 0
}

load_state() {
	[ -f "$STATE_FILE" ] || return 0
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in
			consecutive=*)
				v=${line#consecutive=}
				if accept_state_uint consecutive "$v" 9; then consecutive=$v; fi
				;;
			alarming=0|alarming=1) alarming=${line#alarming=} ;;
			pending_recovery=0|pending_recovery=1) pending_recovery=${line#pending_recovery=} ;;
			last_alert=*)
				v=${line#last_alert=}
				if accept_state_uint last_alert "$v" 10; then last_alert=$v; fi
				;;
		esac
	done < "$STATE_FILE"
}

save() {
	# Atomic rename across timer activations (StateDirectory). No fsync:
	# a crash between write and disk flush may roll back one tick. That is
	# a documented monitor limitation, not the receiver 2xx contract.
	dir=$(dirname "$STATE_FILE")
	mkdir -p "$dir"
	tmp="$STATE_FILE.tmp.$$"
	printf 'consecutive=%s\nalarming=%s\npending_recovery=%s\nlast_alert=%s\n' \
		"$consecutive" "$alarming" "$pending_recovery" "$last_alert" > "$tmp"
	mv "$tmp" "$STATE_FILE"
}

in_cooldown() {
	if [ "$last_alert" -eq 0 ]; then
		return 1
	fi
	# Future last_alert (clock step / persisted wall-clock) must not mute alerts.
	if [ "$now" -lt "$last_alert" ]; then
		return 1
	fi
	[ $((now - last_alert)) -lt "$COOLDOWN_SEC" ]
}

fixed_code() {
	case "$1" in
		health_failed|health_recovered|monitor_alert_failed) printf '%s' "$1" ;;
		*) printf '%s' 'health_failed' ;;
	esac
}

run_alert() {
	code=$(fixed_code "$1")
	if [ -z "$ALERT_BIN" ]; then
		echo "ALERT $code" >&2
		return 0
	fi
	case "$ALERT_BIN" in
		/*) ;;
		*)
			echo "monitor_alert_failed invalid_bin" >&2
			return 1
			;;
	esac
	if ! command -v "$TIMEOUT_BIN" >/dev/null 2>&1; then
		echo "monitor_alert_failed timeout_missing" >&2
		return 1
	fi
	if "$TIMEOUT_BIN" --signal=KILL "$ALERT_TIMEOUT_SEC" "$ALERT_BIN" "$code"; then
		return 0
	fi
	echo "monitor_alert_failed $code" >&2
	return 1
}

load_state
if [ -n "$NOW_SEC" ]; then
	# Same arithmetic path as last_alert. Keep 10-digit epochs; reject overflow.
	if ! is_uint "$NOW_SEC" || [ "${#NOW_SEC}" -gt 10 ]; then
		echo "monitor_config_invalid NOW_SEC" >&2
		exit 2
	fi
	now=$NOW_SEC
else
	now=$(date +%s)
fi

# Exact HTTP 200 only. Do not follow redirects (-L) and do not treat 3xx as ok.
http_code=$("$CURL_BIN" -sS -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || true)
if [ "$http_code" = "200" ]; then
	ok=1
else
	ok=0
fi

if [ "$ok" -eq 0 ]; then
	pending_recovery=0
	# Stay inside the 9-digit consecutive bound so the next tick can load state.
	if [ "$consecutive" -ge 999999999 ]; then
		consecutive=999999999
	else
		consecutive=$((consecutive + 1))
	fi
	if [ "$consecutive" -ge "$FAIL_THRESHOLD" ]; then
		if in_cooldown; then
			save
			exit 1
		fi
		if run_alert health_failed; then
			alarming=1
			last_alert=$now
		fi
	fi
	save
	exit 1
fi

if [ "$alarming" -eq 1 ] || [ "$pending_recovery" -eq 1 ]; then
	if in_cooldown; then
		pending_recovery=1
		consecutive=0
		save
		exit 0
	fi
	if run_alert health_recovered; then
		last_alert=$now
		alarming=0
		pending_recovery=0
		consecutive=0
	else
		pending_recovery=1
	fi
	save
	exit 0
fi

consecutive=0
save
exit 0
