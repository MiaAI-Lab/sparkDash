#!/usr/bin/env bash
# sparkDash Mac Studio rollback: restore pre-deploy repo SHA + plist in one step.
# Usage: scripts/rollback.sh            (restore $BACKUP_ROOT/latest)
#        scripts/rollback.sh <backup>   (restore a named backup dir)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

BACKUP="${1:-$BACKUP_ROOT/latest}"
[[ -d "$BACKUP" ]] || die "no backup at $BACKUP — nothing to roll back to"
[[ -f "$BACKUP/prev-sha" ]] || die "backup $BACKUP missing prev-sha"

cd "$REPO_DIR"
PREV_SHA="$(cat "$BACKUP/prev-sha")"
log "rollback target: $(git rev-parse --short "$PREV_SHA" 2>/dev/null || echo "$PREV_SHA") from $BACKUP"

# 1. Repo back to the pre-deploy SHA.
git checkout --quiet --detach "$PREV_SHA" || die "git checkout $PREV_SHA failed"
log "repo restored to $(git rev-parse --short HEAD)"

# 2. plist restored (if one was captured).
if [[ -f "$BACKUP/plist" ]]; then
  cp "$BACKUP/plist" "$PLIST"
  plutil -lint "$PLIST" >/dev/null || die "restored plist failed lint"
  log "plist restored"
else
  log "WARN: backup has no plist snapshot; keeping current plist"
fi

# 3. Reload the agent against the restored tree.
agent_load || die "launchctl bootstrap failed after rollback"

# 4. Verify JSON health on the live port.
PROD_PORT="${SPARKDASH_PORT:-5555}"
if ! wait_healthy "$PROD_PORT" 30 1; then
  die "ROLLBACK VERIFY FAILED: :$PROD_PORT not healthy after restore — manual intervention needed"
fi

TS_RESULT="$(tailscale_check "$PROD_PORT" || true)"
log "tailscale check: $TS_RESULT"
PID="$(agent_running_pid || echo '?')"
log "ROLLBACK OK: $(git rev-parse --short HEAD) live on :$PROD_PORT (pid $PID)"
