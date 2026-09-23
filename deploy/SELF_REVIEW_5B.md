# Self-Review — Batch 5B (Deploy + Docs + PR Prep)

Worker 5B, 2026-09-23. Scope: deployment layer (compose, install script,
Dockerfile, docs, PR description) + root `docker-compose.yml` / `.env.example`
extensions. No code in `agent/`, `server/`, or `src/` was modified.

## Expected inputs → outputs, and why they matter

| Input | Expected output | Why it matters |
|---|---|---|
| Repo checkout with Batches 0–4 committed | `deploy/docker-compose.yml` with `sparkdash` + `node-agent` services | One-file deployment on any LAN host; both services host-networked so the agent sees host state and the dashboard reaches nodes on LAN IPs |
| A Spark with Docker ≥ 20.0 | `deploy/install-node-agent.sh` → built image + running container + `/health` = `{"ok":true}` | Per-node install in one command; idempotent so fleet ops can re-run blindly |
| Repo root as build context | `deploy/Dockerfile.node-agent` builds `airhamer/sparkdash-node-agent:latest` | Multi-stage per spec (node:18-slim builder → runtime); zero-deps today, builder stage kept for forward-compat |
| Operator reading docs | `docs/NODE-AGENT.md`, `docs/DEPLOYMENT.md` | Documents the seam (env vars, endpoints, registry shape, poll behavior) exactly as the code implements it |
| Upstream maintainer | `deploy/PR-DESCRIPTION.md` | Ready-to-paste PR body for MiaAI-Lab/sparkDash, branch `airhamer/multi-spark-dashboard` |
| Existing root `docker-compose.yml` | Same `sparkdash` service + new `node-agent` service + two-service header comment | Dev mode keeps live-mount `./server`; node-agent mirrored from `deploy/docker-compose.yml` (build variant) |
| Existing `.env.example` | All old vars intact + node-agent vars + dashboard `NODES_JSON_PATH` | One reference for every env var both services consume |

## The seven questions

1. **Inputs that endanger the PROJECT goal — handled?**
   Yes. The project goal is a working multi-Spark dashboard; a deployment
   artifact that silently misroutes config would break it.
   - `RECIPES_PATH=/app/agent/config/recipes.json` is set in both compose files
     and matches `resolveRecipesPath()` in `agent/main.js` (L118–131): an
     explicitly set missing path degrades to an *empty catalog*, never the
     example — and both compose files' comments document that operators add a
     real `recipes.json` (install script does this: copies
     `agent/config/recipes.example.json` → `~/sparkdash-node-agent/config/recipes.json`,
     and never overwrites an existing one — idempotent + lossless).
   - `NODES_JSON_PATH=/app/config/nodes.json` matches `registry.js`'s default
     (`process.env.NODES_JSON_PATH || <repo>/config/nodes.json`, L37–39) and
     the `./config:/app/config` volume mount in both compose files.
   - `NODE_AGENT_PORT=30091` matches `readNodeIdentity()` default and the
     registry's `AGENT_PORT_DEFAULT = 30091`; install script hard-codes the
     same port for the health check (`curl http://127.0.0.1:30091/health`).

2. **Inputs that break THIS code — handled?**
   Yes, per deliverable:
   - `install-node-agent.sh`: `set -euo pipefail`; `command -v docker` missing
     → `exit 1` with error (spec step: graceful degradation); server version
     unreadable → exit 1; major < 20 → exit 1; unknown arg → exit 2 + usage;
     `--help` → usage + exit 0. Verified: `bash -n` clean, `shellcheck` clean
     (0 findings). Idempotency: `docker rm -f` of existing container before
     `docker run`; `mkdir -p`; recipes.json copy guarded by existence check
     (run 2 = same result, no clobber).
   - `Dockerfile.node-agent`: builder `npm install --production` runs even
     with zero deps (no-op, valid); runtime `USER node` — `agent/main.js`
     needs no root; `COPY --from=builder /app ./` lands `agent/main.js` at
     `/app/agent/main.js`, matching `CMD ["node", "agent/main.js"]` and
     `WORKDIR /app`.
   - Both compose files: `docker compose config` exit 0 on both (Docker
     29.8.1). `ports:` + `network_mode: host` coexistence is documented in a
     comment in each file (ports ignored under host network; kept as docs).

3. **Outputs detrimental to the PROJECT — prevented?**
   Yes. Nothing in this batch can drop node data: the install script removes
   only the `sparkdash-node-agent` container it manages (name-pinned via
   `grep -qx`), never images or other containers; config writes are
   create-only (never overwrite `recipes.json`); registry writes are the
   dashboard's job, not the installer's. Docs explicitly warn that the
   recipe `name` pattern and `nodeId`/registry `id` must match
   (`^[a-z0-9][a-z0-9._-]{0,63}$`, mirrored from `registry.js` ID_RE L41).

4. **Outputs that break the NEXT package — prevented?**
   Yes. PR description lists exact added-file set + test commands
   (`cd agent && npm test`, `node --test server/fleet/`), so a reviewer or
   Batch 5B-finalization can re-run ground truth. Seam files untouched
   (verified: `git diff --stat` shows only `.env.example` +
   `docker-compose.yml` modified; `shared/`, `agent/`, `server/`, `src/`
   unmodified).

5. **Optimal input → optimal output — confirmed?**
   Yes. Verified end-to-end:
   - `docker compose -f deploy/docker-compose.yml config` → exit 0, both
     services resolved with expected env/volumes/network_mode (sample output
     in commit report).
   - `docker compose -f docker-compose.yml config` → exit 0 after the
     node-agent section was corrected to mirror the deploy compose (no
     invented `/proc`/`/sys` mounts — see finding F1 below).
   - Install script static checks: `bash -n` + `shellcheck` → 0 findings.
   - Test suites (unchanged code, ground-truth confirmation): fleet
     `__tests__` 63/63 pass; agent 204/205 (one pre-existing failure, F2).

6. **Degenerate input — prevents bad output?**
   Yes. Specified degenerate paths:
   - Docker absent → installer exits 1 with a message before touching
     anything (verified by code path; `command -v` is the first gate after
     arg parsing).
   - `docker version` empty (daemon down) → `exit 1` with "try: docker info".
   - No existing container on a fresh host → `grep -qx` finds nothing,
     `docker run` proceeds (idempotent both ways).
   - Compose on a host with `SPARKDASH_TOKEN` unset →
     `${SPARKDASH_TOKEN:-}` resolves to empty string (verified in
     `docker compose config` output: `SPARKDASH_TOKEN: ""`), matching
     `.env.example` semantics.

7. **Out-of-bounds input — reasonable error before crashing?**
   Yes. Installer: unknown first arg → usage + exit 2 (no shell globbing or
   eval of user input; all user-influenced values are quoted). Compose: env
   interpolation uses `${VAR:-}` defaults so an unset `.env` cannot produce a
   broken document. Dockerfile: no user input at build time.

## Findings

- **F1 (fixed, 1 pass):** Root `docker-compose.yml` node-agent initially
  included `/proc:/host/proc` + `/sys:/host/sys` mounts and a comment
  claiming agent support — invented beyond the work-plan spec and unverifiable
  (collectors are outside this batch's Read-List). **Fix:** removed; the
  service now mirrors `deploy/docker-compose.yml` exactly (build variant).
  Witness: `docker compose config` exit 0 before and after; diff shows only
  the two volume lines + comment removed.
- **F2 (note-in-summary, not mine to fix):** `agent/catalog/__tests__/media.test.js`
  → `listMediaServices: known-answer (video recipe × live port 8188)` fails
  (expected `'ltx-2.3-22b'`, got `null`). Both `agent/catalog/media.js` and
  its test are **untracked** in git (never committed) — pre-existing, Batch 5A
  media territory. My diff does not touch `agent/`; this batch does not fix
  it. Flagged for the orchestrator.
- **F3 (note-in-summary):** `node --test <dir>` on this host (Node v24.21.0)
  errors with `MODULE_NOT_FOUND` for the directory path itself; passing
  explicit test files works (63/63). PR-DESCRIPTION.md's test instructions
  use `node --test server/fleet/` — a reviewer on a differently-patched Node
  may need `node --test server/fleet/__tests__/` or explicit files. Documented
  in this review; not a product defect.

## Verification summary (evidence in commit report)

| Check | Result |
|---|---|
| `bash -n deploy/install-node-agent.sh` | OK |
| `shellcheck deploy/install-node-agent.sh` | 0 findings |
| `docker compose -f deploy/docker-compose.yml config` | exit 0 |
| `docker compose -f docker-compose.yml config` | exit 0 |
| Fleet tests (aggregate/connection/registry/topology) | 63/63 pass |
| Agent tests | 204/205 (1 pre-existing untracked media test, F2) |
| `git diff --stat` | `.env.example` +22, `docker-compose.yml` +46 only |
