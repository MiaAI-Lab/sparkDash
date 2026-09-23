# Multi-Spark Dashboard: per-node agent + fleet aggregation + frontend

**Target repo:** `MiaAI-Lab/sparkDash`
**Branch:** `airhamer/multi-spark-dashboard`

## What this PR adds

A multi-Spark dashboard: monitor and control a fleet of DGX Sparks from one
screen. Three new pieces, wired by the seam contract in `shared/`:

1. **Node agent** (`agent/`) — runs on each Spark. Exposes local telemetry
   (GPU/CPU/mem/disk/net), live model + engine versions, service catalog
   (recipes), memory budgeting, and service actions (start/stop/restart/switch)
   over a local HTTP API on `:30091`. Producer of `NodeAgentSnapshot`
   (validated against `shared/api.schema.json`).
2. **Dashboard server** (`server/fleet/`) — one instance (Narthex). A node
   registry (`registry.js`, backed by `config/nodes.json`, atomic writes,
   graceful degradation), a fleet connection manager (`connection.js`, polls
   each node agent, caches snapshots, online/offline tracking), request
   aggregation (`aggregate.js`, byModel/byEngine/byMachine), and a RoCE
   topology model (`topology.js`). Produces the aggregated `FleetSnapshot`.
3. **Frontend** (`src/`) — fleet overview (FleetCard/FleetPage), per-node
   detail (NodeDetail), RoCE diagram + topology (RoceDiagram/TopologyPage),
   service manager (ServiceManager), and requests visualization (Requests).

Plus a **deployment layer** (`deploy/`, this batch): docker-compose for both
services, a per-node install script, the node-agent Dockerfile, and docs
(`docs/NODE-AGENT.md`, `docs/DEPLOYMENT.md`).

## Changes

### Added — node agent
- `agent/main.js` — entry point; identity from env, catalog lifecycle, HTTP server
- `agent/http.js` — zero-dep HTTP server (bearer-token support, graceful shutdown)
- `agent/telemetry.js` + `agent/collectors/` — GPU/CPU/mem/disk/net collectors
- `agent/catalog/recipes.js` — recipe loading/validation (`shared/recipe.schema.json`)
- `agent/catalog/memory.js` — memory budgeting + make-room plan
- `agent/catalog/services.js` — recipe + live state → `ServiceInstance[]`
- `agent/catalog/media.js` — media pipeline recipes (Batch 5A)
- `agent/actions/docker.js`, `agent/actions/systemd.js`, `agent/actions/llm-switch.js`, `agent/actions/audit.js`
- `agent/config/recipes.example.json`
- `agent/*.test.js` (http, main, telemetry)

### Added — dashboard server (fleet)
- `server/fleet/registry.js` — node registry (normalize, atomic persist, ENOENT→empty)
- `server/fleet/connection.js` — poll/cached snapshots/status transitions
- `server/fleet/aggregate.js` — request stats → byModel/byEngine/byMachine
- `server/fleet/topology.js` — fleet RoCE graph (undirected dedup)
- `server/fleet/*.test.js`

### Added — frontend
- Fleet overview + per-node detail + topology/RoCE (Batch 4A)
- Service manager tab + requests viz + memory budgeting UI (Batch 4B)

### Added — deployment + docs (this batch)
- `deploy/docker-compose.yml`
- `deploy/Dockerfile.node-agent`
- `deploy/install-node-agent.sh`
- `deploy/PR-DESCRIPTION.md`
- `deploy/README.md`
- `docs/NODE-AGENT.md`
- `docs/DEPLOYMENT.md`
- `docker-compose.yml` (updated: node-agent service + comments)
- `.env.example` (updated: node-agent + dashboard env vars)

## Tests

All modules are zero-dependency Node ESM with `node --test` suites:

```bash
# Node agent
cd agent && npm test          # → node --test

# Fleet modules (from repo root)
node --test server/fleet/

# Seam validation (agent output vs api.schema.json; recipes vs recipe.schema.json)
# — see shared/README.md "How to validate"
```

Ground-truth tests included: registry normalize/round-trip (add/update/remove/
duplicate-id), connection manager poll success/failure/timeout + snapshot cache,
aggregateRequests empty/null/malformed inputs, buildTopology dedup + empty
inputs, recipe validation (valid + invalid), memory budgeting make-room plan.

## Screenshots

_(placeholder — add after the frontend is running: fleet overview, per-node
detail, RoCE topology, service manager, requests tab)_

## Notes / invariants

- Seam contract pinned in `shared/` (only Batch 0 / 5B may modify); this branch
  is a fork contribution targeting `MiaAI-Lab/sparkDash`.
- Node agent is pure-pull; dashboard is the only consumer.
- Graceful degradation throughout: missing registry → empty fleet; offline
  node → last snapshot kept; bad recipe file → empty catalog.
