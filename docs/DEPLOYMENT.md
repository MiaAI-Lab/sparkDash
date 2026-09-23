# Deployment

How to deploy the **multi-Spark dashboard**: the dashboard server (one copy,
anywhere on the LAN — typically Narthex), the per-node agents (one copy per
DGX Spark), and the frontend.

---

## Overview

The dashboard gives one screen for a fleet of DGX Sparks: GPU/CPU/memory/disk
telemetry, live model + engine versions, running services, queued/running
requests, memory budgeting, RoCE topology, and remote service actions
(start/stop/switch).

It is three pieces:

| Piece | Runs on | Role |
|---|---|---|
| **node-agent** | each Spark | Per-node telemetry + catalog + actions over local HTTP (`:30091`). Producer of `NodeAgentSnapshot`. |
| **dashboard server** | one host (Narthex) | Polls every node agent, aggregates into `FleetSnapshot`, serves it to the frontend over HTTP/WebSocket. Producer of the aggregated view. |
| **frontend** | built into the dashboard image | Vite/React UI that consumes `FleetSnapshot`. |

The seam between pieces is pinned in [`shared/`](../shared/) — `types.ts`
(canonical shapes), `api.schema.json` (node-agent `/telemetry`), and
`recipe.schema.json` (per-node recipe files). Read
[`shared/README.md`](../shared/README.md) for the seam contract.

---

## Architecture

```
 Spark A :30091          Spark B :30091          Spark N :30091
 (node-agent)            (node-agent)            (node-agent)
        |                        |                        |
        +---- GET /telemetry ---+---- GET /telemetry -----+
                   (every 2s, per-node, 5s timeout)
                          |
        +-----------------v-----------------+
        |  Dashboard host (Narthex)        |
        |  sparkdash server :5555          |
        |  registry → connection →         |
        |  aggregate + topology            |
        |  Frontend (Vite/React)           |
        +----------------------------------+
```

- **Registry** — [`server/fleet/registry.js`](../server/fleet/registry.js) owns
  `config/nodes.json`: which nodes exist, their node-agent endpoints,
  roles/ranks, and RoCE links. Normalizes on load and write, persists
  atomically (temp + rename), and degrades gracefully: a missing `nodes.json`
  is an empty registry, a corrupt one is warn + empty.
- **Connection** —
  [`server/fleet/connection.js`](../server/fleet/connection.js) polls
  `http://<endpoint>/telemetry` for every registry node, caches the last good
  `NodeAgentSnapshot` per node, tracks online/offline transitions, and emits
  events the server fans out over WebSocket. Unreachable/timing-out/malformed
  nodes keep their last snapshot and are marked offline.
- **Aggregation** — [`server/fleet/aggregate.js`](../server/fleet/aggregate.js)
  builds `FleetSnapshot.requests` (byModel / byEngine / byMachine) from per-node
  request stats.
- **Topology** — [`server/fleet/topology.js`](../server/fleet/topology.js)
  assembles the fleet-wide RoCE graph from each node's registry record
  (deduplicating undirected links).
- **Frontend** — React (FleetCard, FleetPage, NodeDetail, RoceDiagram,
  TopologyPage, ServiceManager, Requests tabs) consuming `FleetSnapshot`.

---

## Deployment

### 1. Node agents — one per Spark

On each Spark, from a checkout of the repo:

```bash
./deploy/install-node-agent.sh
```

Idempotent. It builds `airhamer/sparkdash-node-agent:latest`, provisions
`~/sparkdash-note-agent` → `~/sparkdash-node-agent/config/recipes.json`, starts
the container on host networking, and verifies `/health`. Or via compose:

```bash
docker compose -f deploy/docker-compose.yml up -d node-agent
```

Full node-agent details: [`docs/NODE-AGENT.md`](NODE-AGENT.md).

### 2. Dashboard — one host

On the dashboard host (Narthex):

```bash
# Build the dashboard image (frontend + server):
docker build -t airhamer/sparkdash:latest .

# Start just the dashboard service:
docker compose -f deploy/docker-compose.yml up -d sparkdash
# — or use the repo-root compose, which mounts live server code:
docker compose up -d sparkdash
```

The dashboard listens on `:5555`. It reads its node registry from
`config/nodes.json` (see next section).

### 3. Verify

```bash
curl -s http://<dashboard-host>:5555/api/fleet | head
# → FleetSnapshot: nodes[], topology{nodes,links}, requests{...}, memory{...}
```

---

## Configuration

Environment variables (see [`deploy/docker-compose.yml`](../deploy/docker-compose.yml)
and [`.env.example`](../.env.example)):

### Dashboard

| Variable | Default | Meaning |
|---|---|---|
| `NODES_JSON_PATH` | `<repo>/config/nodes.json` | Where the dashboard reads its node registry (in-container: `/app/config/nodes.json`). |
| `PORT` | `5555` | Dashboard HTTP port. |
| `BIND_HOST` | `127.0.0.1` | Listen address. Non-loopback binds fail closed unless remote auth is on. |
| `SPARKDASH_TOKEN` | *(empty)* | Optional bearer token for the dashboard HTTP API. |
| `SPARKDASH_ALLOW_OPEN_REMOTE` | `1` | Tokenless remote bind; set `0` to fail closed without a token. |
| `LLM_PORT` | `8888` | (Legacy local-Spark path) LLM port probed by the single-node monitor. |
| `POLL_INTERVAL_*` | see `.env.example` | Per-metric poll cadences for the legacy local-Spark monitor. |

### Node agent

| Variable | Default | Meaning |
|---|---|---|
| `NODE_AGENT_PORT` | `30091` | Node-agent HTTP port. |
| `NODE_AGENT_BIND` | `0.0.0.0` | Bind address. |
| `RECIPES_PATH` | `/app/agent/config/recipes.json` | Recipe catalog path (in-container). |
| `NODE_AGENT_TOKEN` | *(unset)* | Optional bearer token for the agent API. |
| `NODE_ID` / `NODE_NAME` | hostname | Node identity (id must match the registry). |
| `NODE_LAN_IP` | auto-detect | LAN IP reported in snapshots. |

Copy [`.env.example`](../.env.example) to `.env` and adjust to taste.

---

## Node registry

The dashboard's node list lives in `config/nodes.json` (one object,
`{ "nodes": [...] }`). The registry normalizes each record on load **and**
write, so hand edits are tolerated:

```json
{
  "nodes": [
    {
      "id": "gx10-1c2c",
      "name": "Node 1",
      "endpoint": "192.168.50.226:30091",
      "lanIp": "192.168.50.226",
      "role": "head",
      "rank": 0,
      "groupId": "tp2-glm",
      "headId": null,
      "agentPort": 30091,
      "isLocal": false,
      "links": [
        { "from": "gx10-1c2c", "to": "gx10-27c1",
          "fromIf": "enp1s0f1np1", "toIf": "enp1s0f1np1",
          "speedMbps": 200000, "transport": "roce", "up": true }
      ]
    },
    {
      "id": "gx10-27c1",
      "name": "Node 2",
      "endpoint": "192.168.50.44:30091",
      "lanIp": "192.168.50.44",
      "role": "worker",
      "rank": 1,
      "groupId": "tp2-glm",
      "headId": "gx10-1c2c",
      "agentPort": 30091,
      "isLocal": false,
      "links": []
    }
  ]
}
```

- **Add a node:** add a record with a valid `id` (matches
  `^[a-z0-9][a-z0-9._-]{0,63}$`), `endpoint` (`<lan-ip>:30091`), and the
  node-agent running there. Restart/reload the dashboard (or let it re-read on
  the next cycle). The connection manager will start polling it immediately.
- **Remove a node:** delete the record. The dashboard stops polling it and its
  card disappears from the fleet view.
- **Roles / RoCE:** `role` (`head`/`worker`/`standalone`), `rank`, `groupId`,
  `headId`, and `links` are **manual designation** in v1 (not auto-detected).
  List each RoCE link on at least one of its endpoints; the topology model
  deduplicates undirected pairs, so listing A→B on both nodes is fine.
- **Duplicate ids** in the file are rejected on write (first occurrence wins on
  load). A missing or corrupt `nodes.json` degrades to an empty registry, not a
  crash.

`isLocal: true` marks the node the dashboard itself runs on (useful for the
legacy single-node local-Spark monitor that reads host `/proc`/`/sys`).

---

## Fleet connection

[`server/fleet/connection.js`](../server/fleet/connection.js)
(`createFleetConnection`) is the poller:

- **Poll cadence** — default every `2000 ms`, per-node HTTP timeout
  `5000 ms` (both configurable).
- **Resolution** — prefers `endpoint`; falls back to `lanIp` + `agentPort`; a
  record with neither is skipped (never guesses `127.0.0.1`).
- **Caching** — keeps the last good `NodeAgentSnapshot` per node in a `Map`;
  `getSnapshot(nodeId)` / `getAllSnapshots()` expose it.
- **Status** — `isOnline(nodeId)`; `onStatus` fires only on transitions
  (online↔offline).
- **Graceful degradation** — an unreachable, timing-out, or malformed-JSON node
  keeps its last snapshot and is marked offline; the fleet never blanks out one
  card because one node hiccuped.
- **Events** — `onSnapshot` fires after each successful poll, so the server can
  fan fresh data out over WebSocket without clients polling.

---

## Frontend build

The frontend is a Vite/React app under `src/`. In development:

```bash
npm install
npm run build        # → dist/
```

The dashboard image bakes the built frontend in (the repo-root
[`docker-compose.yml`](../docker-compose.yml) passes `VITE_HISTORY_HOURS` as a
build arg for metrics-history retention). Rebuild the image after changing
that arg.

---

## PR prep — submitting to `MiaAI-Lab/sparkDash`

This branch is a fork contribution. To submit:

1. **Push your fork branch** (e.g. `airhamer/multi-spark-dashboard`):

   ```bash
   git push origin multi-spark-dashboard
   ```

2. **Open a PR** on GitHub: `MiaAI-Lab/sparkDash` ← your fork's
   `multi-spark-dashboard`. Use
   [`deploy/PR-DESCRIPTION.md`](../deploy/PR-DESCRIPTION.md) as the PR body.

3. **Checklist before opening:**
   - `git status` clean; all batches committed.
   - `node --test` passes (agent + fleet modules).
   - Seam shapes untouched since Batch 0 (or changed end-to-end per
     `shared/README.md`).
   - Screenshots of the running frontend attached (placeholder in the PR
     description until the frontend is captured).

---

## See also

- [`docs/NODE-AGENT.md`](NODE-AGENT.md) — node-agent deep-dive.
- [`shared/README.md`](../shared/README.md) — seam contract.
- [`deploy/README.md`](../deploy/README.md) — quick-start.
- [`deploy/PR-DESCRIPTION.md`](../deploy/PR-DESCRIPTION.md) — PR body.
