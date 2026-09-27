#!/usr/bin/env bash
# sparkDash Mac Studio deploy: pinned SHA -> isolated-port smoke -> LaunchAgent swap -> verify.
# Usage: scripts/deploy.sh <sha|ref>            (real deploy onto the live LaunchAgent)
#        scripts/deploy.sh --dry-run <sha|ref>  (full pipeline, isolated port only, no swap)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; shift; fi
TARGET_REF="${1:-}"
[[ -z "$TARGET_REF" ]] && die "usage: deploy.sh [--dry-run] <sha|ref>"

REMOTE="${SPARKDASH_REMOTE:-mike}"
SMOKE_PORT="${SPARKDASH_SMOKE_PORT:-5599}"
mkdir -p "$BACKUP_ROOT" "$STATE_DIR"
cd "$REPO_DIR"

# --- 1. Fetch + checkout pinned SHA -------------------------------------------
log "fetch $REMOTE"
git fetch --all --prune >/dev/null
SHA="$(git rev-parse --verify "${TARGET_REF}^{commit}" 2>/dev/null || true)"
[[ -z "$SHA" ]] && die "cannot resolve ref '$TARGET_REF'"
SHORT="$(git rev-parse --short "$SHA")"
log "target SHA $SHORT ($SHA)"

DIRTY="$(git status --porcelain | grep -v '^??' || true)"
[[ -n "$DIRTY" ]] && die "working tree has tracked modifications, refusing to deploy:
$DIRTY"

PREV_SHA="$(git rev-parse HEAD)"
log "previous SHA $(git rev-parse --short HEAD)"
git checkout --quiet --detach "$SHA"

# --- 2. Install prod deps ------------------------------------------------------
# Post-checkout hardening (promote-night failure mode): the checkout can land
# with node_modules wiped. Probe the actual runtime imports, not just the dir.
runtime_deps_ok() {
  ( cd "$REPO_DIR" && "$NODE_BIN" -e 'import("express").then(async () => { await import("ws"); await import("undici"); await import("dotenv"); })' ) >/dev/null 2>&1
}
if ! runtime_deps_ok; then
  log "runtime deps missing after checkout — npm ci --omit=dev --ignore-scripts"
fi
runtime_deps_ok || npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 || \
  die "npm ci failed"
runtime_deps_ok || die "deps still missing after npm ci"

# Frontend build tools are devDeps; keep node_modules complete for the build,
# then prune. dist/ is what the server serves.
if [[ ! -x node_modules/.bin/vite ]]; then
  log "npm ci (full, for build tooling)"
  npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 || die "npm ci (dev) failed"
fi
if [[ ! -f dist/index.html ]] || [[ dist/index.html -ot src/main.tsx ]]; then
  log "vite build"
  npm run build >/dev/null 2>&1 || { git checkout --quiet --detach "$PREV_SHA"; die "vite build failed"; }
fi

# --- 3. Smoke test on isolated port --------------------------------------------
log "smoke test on isolated port $SMOKE_PORT"
SMOKE_PID="$(smoke_run "$REPO_DIR" "$SMOKE_PORT" | tail -1)"
trap 'smoke_stop "$SMOKE_PORT"' EXIT
if ! wait_healthy "$SMOKE_PORT" 30 1; then
  log "smoke FAILED — rolling repo back to $(git rev-parse --short $PREV_SHA), live service untouched"
  smoke_stop "$SMOKE_PORT"
  git checkout --quiet --detach "$PREV_SHA"
  exit 1
fi
smoke_stop "$SMOKE_PORT"

if [[ "$DRY_RUN" == 1 ]]; then
  log "DRY RUN complete: $SHORT boots + serves healthy on :$SMOKE_PORT. No LaunchAgent swap."
  git checkout --quiet --detach "$PREV_SHA"
  exit 0
fi

# --- 4. Backup + swap LaunchAgent ----------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/pre-deploy-$STAMP"
mkdir -p "$BACKUP"
cp "$PLIST" "$BACKUP/plist" 2>/dev/null || log "WARN: no existing plist to back up"
echo "$PREV_SHA" > "$BACKUP/prev-sha"
ln -sfn "$BACKUP" "$BACKUP_ROOT/latest"
log "backup at $BACKUP (prev SHA $(git rev-parse --short $PREV_SHA))"

plutil -lint "$PLIST" >/dev/null || die "existing plist invalid, refusing to swap"

log "swapping LaunchAgent $LABEL"
agent_load || { log "bootstrap FAILED — restoring previous SHA"; git checkout --quiet --detach "$PREV_SHA"; exit 1; }

# --- 5. Verify live :5555 JSON health ------------------------------------------
if ! wait_healthy "$PROD_PORT" 30 1; then
  log "PROD HEALTH FAILED after swap — invoking rollback"
  "$SCRIPT_DIR/rollback.sh"
  exit 1
fi

# --- 6. Tailscale reachability -------------------------------------------------
TS_RESULT="$(tailscale_check "$PROD_PORT" || true)"
log "tailscale check: $TS_RESULT"

PID="$(agent_running_pid || echo '?')"
log "DEPLOY OK: $SHORT live on :$PROD_PORT (pid $PID, prev $(git rev-parse --short $PREV_SHA) saved to $BACKUP)"
