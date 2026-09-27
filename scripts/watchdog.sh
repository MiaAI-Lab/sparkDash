#!/bin/bash
# sparkDash crash watchdog.
#
# launchd KeepAlive(SuccessfulExit=false) does NOT fire when a process dies to
# an uncaught signal (SIGSEGV/SIGKILL/etc) or when the whole service gets
# bootout-ed. This watchdog closes that gap:
#   - 3 consecutive failed health probes  -> launchctl kickstart -k
#   - recovery confirmed                  -> one-shot alert
#   - still down after recovery           -> one-shot alert (needs a human)
# Runs at most one recovery per DOWN episode so it can't thrash.
#
# Stateless: last known state lives in a marker file. Safe to run from cron,
# a second LaunchAgent, or manually.
#
# NOTE: keep this file ASCII-only. UTF-8 punctuation (em-dash, arrows) has
# broken printf/grep under launchd's stripped locale + pipefail before.
set -uo pipefail
export LC_ALL=C
export LANG=C

# Isolate for testing: WATCHDOG_STATE_FILE / WATCHDOG_ALERT_LOG env overrides.
STATE_FILE="${WATCHDOG_STATE_FILE:-$HOME/Library/Logs/sparkdash-watchdog.state}"
ALERT_LOG="${WATCHDOG_ALERT_LOG:-$HOME/Library/Logs/sparkdash-alerts.log}"
LABEL="${SPARKDASH_LABEL:-ai.onyx.sparkdash}"
# Default matches deploy/lib.sh JSON health (server exposes /api/health -> {"ok":true}).
# grep -F: literal match - the body marker contains regex metacharacters (:).
URL="${SPARKDASH_HEALTH_URL:-http://127.0.0.1:${PORT:-5555}/api/health}"
OK_BODY="${WATCHDOG_OK_BODY:-ok:true}"
THRESHOLD="${WATCHDOG_FAIL_THRESHOLD:-3}"
NOW="$(date '+%Y-%m-%d %H:%M:%S')"

alert() {
  printf '[%s] %s\n' "$NOW" "$*" >> "$ALERT_LOG"
  # Fleet hook: hermes kanban/notify integrations can tail this file.
  # Intentionally no outbound messaging from here - alerts land in the log.
}

mark() { printf '%s\n' "$1" > "$STATE_FILE"; }
last_state() { cat "$STATE_FILE" 2>/dev/null || echo "up"; }

probe() {
  local body
  body=$(curl -fsS --max-time 5 "$URL" 2>/dev/null) || return 1
  printf '%s' "$body" | grep -qF "$OK_BODY"
}

if probe; then
  if [ "$(last_state)" = "down" ]; then
    alert "RECOVERED $LABEL is answering $URL after recovery"
  fi
  rm -f "$STATE_FILE.fail"
  mark "up"
  exit 0
fi

# Probe failed - count consecutive failures.
count=$(awk '{print $1+0}' "$STATE_FILE.fail" 2>/dev/null || echo 0)
count=$((count + 1))
printf '%s\n' "$count" > "$STATE_FILE.fail"

if [ "$count" -lt "$THRESHOLD" ]; then
  # Transient blip (server restarting, brief network glitch). Not yet an incident.
  exit 0
fi

if [ "$(last_state)" = "down" ]; then
  # Already flagged + already attempted recovery for this episode. Stay quiet.
  exit 0
fi

alert "DOWN $LABEL failed ${count} consecutive health probes ($URL) - attempting launchctl kickstart"
mark "down"
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || alert "kickstart FAILED for $LABEL (service not loaded? launchctl bootstrap needed)"

# Give the guard + node up to 45s, then re-probe.
for i in 5 10 15 20 25 30 35 40 45; do
  sleep 5
  if probe; then
    alert "RECOVERED $LABEL auto-recovered via kickstart after ${i}s"
    rm -f "$STATE_FILE.fail"
    mark "up"
    exit 0
  fi
done

alert "STILL DOWN $LABEL unrecoverable after kickstart - human intervention required (tail ~/Library/Logs/sparkdash.err.log)"
exit 1
