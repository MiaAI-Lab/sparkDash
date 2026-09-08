#!/bin/bash
# Post-checkout runtime guard for the live (LaunchAgent) deployment.
#
# Promote-night failure mode: a git checkout/merge wiped or left node_modules
# empty, and the server died instantly with ERR_MODULE_NOT_FOUND (missing
# express). launchd's KeepAlive then thrashed the bad state.
#
# This script self-heals BEFORE exec'ing the server:
#   1. If a runtime dependency (or node_modules itself) is missing -> npm ci --omit=dev
#   2. If dist/index.html (static UI served by the server) is missing -> npm run build
#      (devDeps installed temporarily, then pruned back with npm ci --omit=dev)
#   3. exec the real server so launchd keeps supervising node directly.
#
# Idempotent + cheap: the dependency probe is a single `node -e` import test.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { echo "[sparkdash-guard] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

deps_ok() {
  # One process, imports every runtime dep from server context.
  node -e 'import("express").then(async () => { await import("ws"); await import("undici"); await import("dotenv"); })' \
    >/dev/null 2>&1
}

if ! deps_ok; then
  log "runtime deps missing (empty node_modules or wiped deps) - running: npm ci --omit=dev"
  npm ci --omit=dev --no-audit --no-fund
  if ! deps_ok; then
    log "FATAL: deps still missing after npm ci - check npm cache / lockfile"
    exit 1
  fi
  log "runtime deps restored"
fi

if [ ! -f dist/index.html ]; then
  log "dist/index.html missing - building frontend"
  npm ci --no-audit --no-fund
  npm run build
  # Drop devDeps again so the runtime footprint stays production-only.
  npm ci --omit=dev --no-audit --no-fund
  log "frontend built"
fi

exec "${NODE_BIN:-node}" server/index.js "$@"
