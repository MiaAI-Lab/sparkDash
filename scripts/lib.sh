#!/usr/bin/env bash
# Shared constants + helpers for sparkDash Mac Studio deployment scripts.
# Sourced by scripts/deploy.sh and scripts/rollback.sh.
# NOTE: bash 3.2 compatible — never expand $var inside a `local` declaration
# list (bash 3.2 + set -u reads $2 for later locals as unbound).

REPO_DIR="${SPARKDASH_REPO_DIR:-/Users/openclaw/repos/sparkDash}"
LABEL="ai.onyx.sparkdash"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
PROD_PORT="${SPARKDASH_PORT:-5555}"
NODE_BIN="${SPARKDASH_NODE:-/Users/openclaw/.hermes/node/bin/node}"
STATE_DIR="$HOME/.sparkdash-deploy"
BACKUP_ROOT="$STATE_DIR/backups"
RUNLOG="$STATE_DIR/deploy.log"
TAILSCALE_BIN="${TAILSCALE_BIN:-/usr/local/bin/tailscale}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$RUNLOG"; }
die() { log "FATAL: $*"; exit 1; }

# JSON health check: hit /api/health on a port, require {"ok":true}.
health_json() {
  local port="$1"
  curl -fsS --max-time 5 "http://127.0.0.1:${port}/api/health" 2>/dev/null
}

wait_healthy() {
  # wait_healthy <port> [attempts] [sleep_s]
  local port="$1"
  local attempts="${2:-30}"
  local sleep_s="${3:-1}"
  local i body
  for ((i = 1; i <= attempts; i++)); do
    body="$(health_json "$port")" || true
    if printf '%s' "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
      log "health OK on port $port (attempt $i): $body"
      return 0
    fi
    sleep "$sleep_s"
  done
  log "health FAILED on port $port after $attempts attempts (last body: ${body:-<none>})"
  return 1
}

# Run the built server on an isolated port, detached, echo its PID.
# usage: smoke_run <workdir> <port> -> prints PID
smoke_run() {
  local dir="$1"
  local port="$2"
  local pidfile="$STATE_DIR/smoke-$port.pid"
  mkdir -p "$STATE_DIR"
  PORT="$port" BIND_HOST=127.0.0.1 SPARKDASH_SMOKE=1 \
    "$NODE_BIN" "$dir/server/index.js" \
    >>"$STATE_DIR/smoke-$port.log" 2>&1 &
  local pid=$!
  echo "$pid" >"$pidfile"
  echo "$pid"
}

# Targeted: only kill the recorded PID, never pkill -f (would kill prod).
smoke_stop() {
  local port="$1"
  local pidfile="$STATE_DIR/smoke-$port.pid"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(cat "$pidfile")"
    kill "$pid" 2>/dev/null || true
    # wait up to 5s for graceful exit
    local t
    for t in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  fi
}

# Load (or reload) the LaunchAgent for the given UID domain.
# launchd needs the old job fully gone before bootstrap accepts the new one;
# a bare bootout->bootstrap races and fails with error 5 (Input/output error).
agent_load() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
  local attempt
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
      sleep 1
      return 0
    fi
    sleep 1
  done
  return 1
}

agent_running_pid() {
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null \
    | awk '/^[[:space:]]*pid = /{print $3; exit}'
}

ts_lan_ip() { "$TAILSCALE_BIN" ip -4 2>/dev/null | head -1; }

# Tailscale reachability check against a port. Prints PASS/FAIL line.
tailscale_check() {
  local port="$1"
  local ip
  ip="$(ts_lan_ip)"
  [[ -z "$ip" ]] && { echo "FAIL: tailscale IP not found"; return 1; }
  if curl -fsS --max-time 5 "http://${ip}:${port}/api/health" 2>/dev/null \
      | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    echo "PASS: http://${ip}:${port}/api/health ok:true"
  else
    echo "FAIL: http://${ip}:${port}/api/health not ok"
    return 1
  fi
}
