#!/bin/sh
# Independent HTTPS probe. Run on a different host than the receiver.
# Default: every 30s, alarm after two failures, recovery notice, cooldown.
# Override CURL_BIN / ALERT_CMD in tests. Do not interpolate probe bodies.

set -eu

HEALTH_URL="${HEALTH_URL:-https://webhook-wake.example.com/health}"
INTERVAL_SEC="${INTERVAL_SEC:-30}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-2}"
COOLDOWN_SEC="${COOLDOWN_SEC:-300}"
CURL_BIN="${CURL_BIN:-curl}"
ALERT_CMD="${ALERT_CMD:-}"
STATE_FILE="${STATE_FILE:-/tmp/webhook-wake-monitor.state}"

consecutive=0
alarming=0
last_alert=0

if [ -f "$STATE_FILE" ]; then
	# shellcheck disable=SC1090
	. "$STATE_FILE"
fi

save() {
	printf 'consecutive=%s\nalarming=%s\nlast_alert=%s\n' "$consecutive" "$alarming" "$last_alert" > "$STATE_FILE"
}

now=$(date +%s)
if "$CURL_BIN" -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
	ok=1
else
	ok=0
fi

alert() {
	code="$1"
	if [ $((now - last_alert)) -lt "$COOLDOWN_SEC" ]; then
		return 0
	fi
	last_alert=$now
	if [ -n "$ALERT_CMD" ]; then
		# Fixed argument only; never pass curl output or URL query text.
		if ! $ALERT_CMD "$code"; then
			echo "monitor_alert_failed $code" >&2
			return 1
		fi
	else
		echo "ALERT $code" >&2
	fi
}

if [ "$ok" -eq 0 ]; then
	consecutive=$((consecutive + 1))
	if [ "$consecutive" -ge "$FAIL_THRESHOLD" ]; then
		if alert health_failed; then
			alarming=1
		fi
	fi
	save
	exit 1
fi

if [ "$alarming" -eq 1 ] || [ "$consecutive" -gt 0 ]; then
	if [ "$alarming" -eq 1 ]; then
		alert health_recovered || true
	fi
	alarming=0
	consecutive=0
fi
save
exit 0
