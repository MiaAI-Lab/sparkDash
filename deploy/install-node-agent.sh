#!/usr/bin/env bash
#
# sparkDash node-agent — per-node install script
#
# Idempotent: run twice = same result. Installs the node-agent Docker image
# on this host, provisions its config, and (re)starts the container.
#
# Usage:
#   deploy/install-node-agent.sh          # install/reinstall on this host
#   deploy/install-node-agent.sh --help   # usage
#
# The node agent runs under host networking and listens on 30091. The
# dashboard (on another host) reaches it at <this-host-LAN-IP>:30091.

set -euo pipefail

IMAGE="airhamer/sparkdash-node-agent:latest"
CONTAINER="sparkdash-node-agent"
CONFIG_DIR="${HOME}/sparkdash-node-agent/config"
AGENT_PORT="30091"

log()  { printf '[install-node-agent] %s\n' "$*"; }
err()  { printf '[install-node-agent] ERROR: %s\n' "$*" >&2; }

usage() {
  grep -E '^#( |$)' "$0" | sed -e 's/^#//' -e 's/^#//'
  exit 0
}

# ── 0. Args ────────────────────────────────────────────────────────────────
case "${1:-}" in
  -h|--help|help) usage ;;
  "") ;;
  *) err "unknown argument: $1 (try --help)"; exit 2 ;;
esac

# ── 1. Require docker (>= 20.0) ────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  err "docker not found on PATH. Install Docker Engine >= 20.0 and re-run."
  exit 1
fi

docker_major="$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1 || true)"
if [[ -z "${docker_major}" ]]; then
  err "could not read docker server version (is the daemon running? try: docker info)"
  exit 1
fi
if [[ "${docker_major}" -lt 20 ]]; then
  err "docker ${docker_major} is too old; need >= 20.0"
  exit 1
fi
log "docker $(docker version --format '{{.Client.Version}}') ok"

# ── 2. Resolve repo root (two levels up from this script) ─────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ── 3. Build the image ──────────────────────────────────────────────────────
log "building ${IMAGE} ..."
docker build -t "${IMAGE}" -f deploy/Dockerfile.node-agent .

# ── 4. Provision config (idempotent: never overwrite an existing recipes.json)
mkdir -p "${CONFIG_DIR}"
if [[ -f "${CONFIG_DIR}/recipes.json" ]]; then
  log "config dir ${CONFIG_DIR} already has recipes.json — leaving it untouched"
else
  cp agent/config/recipes.example.json "${CONFIG_DIR}/recipes.json"
  log "wrote ${CONFIG_DIR}/recipes.json (from recipes.example.json)"
fi

# ── 5. (Re)start the container (idempotent: remove any existing one first) ─
if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  log "stopping existing ${CONTAINER} ..."
  docker rm -f "${CONTAINER}" >/dev/null
fi

docker run -d \
  --name "${CONTAINER}" \
  --restart always \
  --network host \
  -p "${AGENT_PORT}:${AGENT_PORT}" \
  -v "${CONFIG_DIR}:/app/agent/config" \
  "${IMAGE}" >/dev/null

log "started ${CONTAINER}"

# ── 6. Verify /health ───────────────────────────────────────────────────────
sleep 1
body="$(curl -s --max-time 5 "http://127.0.0.1:${AGENT_PORT}/health" || true)"
if [[ "${body}" == *'"ok":true'* ]]; then
  log "health ok: ${body}"
  log "node-agent live on this host at 127.0.0.1:${AGENT_PORT}"
  log "add this host to the dashboard's config/nodes.json (id, endpoint <lan-ip>:${AGENT_PORT})"
else
  err "health check returned unexpected body: ${body:-<empty>}"
  err "inspect with: docker logs ${CONTAINER}"
  exit 1
fi
