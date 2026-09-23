# Node Agent (`sparkdash-node-agent`)

The node agent is the **per-node** half of the multi-Spark dashboard. It runs
on each DGX Spark (and on Narthex, the gateway host) and exposes that single
machine's live state over a local HTTP API. The dashboard server polls these
agents and aggregates them into a fleet view.

This is a **producer**: it produces `NodeAgentSnapshot` (and the other seam
shapes in [`shared/types.ts`](../shared/types.ts)). It does not talk to other
nodes — the dashboard is the only consumer.

---

## What it does

Three jobs, all about *this* machine:

1. **Telemetry** — GPU (temp, utilization, power, VRAM, top processes), CPU
   (usage, temp, draw, TDP), memory, per-mount disk, and per-interface network
   speed. Collected by `agent/collectors/` and assembled into a
   `NodeAgentSnapshot` by `agent/telemetry.js`.
2. **Catalog** — the declarative "what *can* run here" side: recipes
   (`agent/catalog/recipes.js`), live versions (`/versions`), service
   instances (`/services`), and memory budgeting (`agent/catalog/memory.js`).
3. **Actions** — start / stop / restart / switch services, via Docker
   (`agent/actions/docker.js`), systemd (`agent/actions/systemd.js`), or an LLM
   engine switch (`agent/actions/llm-switch.js`). Every action is recorded to
   the audit log (`agent/actions/audit.js`).

Entry point: [`agent/main.js`](../agent/main.js). It reads identity from env,
loads the recipe catalog, and starts the HTTP server (`agent/http.js`).

---

## Architecture — how it fits the dashboard

```
+---------------------------+      +---------------------------+
|  Spark  A (DGX)           |      |  Spark  B (DGX)           |
|  node-agent :30091        |      |  node-agent :30091        |
|  (telemetry/catalog/act)  |      |  (telemetry/catalog/act)  |
+-------------^-------------+      +-------------^-------------+
              |  GET /telemetry                  |
              +----------------------------------+
                      (HTTP, every 2s)
+-----------------------------------------------------------+
|  Dashboard host (Narthex)                                 |
|  sparkdash server :5555                                   |
|   - fleet/registry.js   (node registry, config/nodes.json)|
|   - fleet/connection.js (polls each node agent, caches)   |
|   - fleet/aggregate.js  (requests byModel/Engine/Machine) |
|   - fleet/topology.js   (RoCE graph)                      |
|  Frontend (Vite/React) consumes FleetSnapshot             |
+-----------------------------------------------------------+
```

One node agent per machine. One dashboard anywhere on the LAN. The dashboard's
connection manager ([`server/fleet/connection.js`](../server/fleet/connection.js))
polls `http://<lan-ip>:30091/telemetry` for each registry node, caches the last
good `NodeAgentSnapshot`, and marks a node offline on timeout (keeping its last
snapshot). The agent never initiates; it is pure pull.

---

## Deployment

Two equivalent ways to get the agent running on a Spark:

### A. Install script (recommended per node)

```bash
# On the Spark, from a checkout of the repo:
./deploy/install-node-agent.sh
```

It builds the image, provisions `~/sparkdash-node-agent/config/recipes.json`,
and starts the `sparkdash-node-agent` container on host networking. **Idempotent**
— re-running removes and re-creates the container, and never overwrites an
existing `recipes.json`. See [`deploy/install-node-agent.sh`](../deploy/install-node-agent.sh).

### B. docker-compose

```bash
# On the Spark:
docker compose -f deploy/docker-compose.yml up -d node-agent
```

The `node-agent` service in
[`deploy/docker-compose.yml`](../deploy/docker-compose.yml) builds from
`deploy/Dockerfile.node-agent`.

> **Note:** under `network_mode: host` the `ports:` entries in compose are
> ignored by Docker — host networking binds the port directly. They are kept as
> documentation of which host port the agent owns.

After install, verify:

```bash
curl -s http://127.0.0.1:30091/health   # → {"ok":true,...}
```

Then register the node in the dashboard's `config/nodes.json` (below).

---

## Configuration

All configuration is by environment variable (see
[`agent/main.js`](../agent/main.js) → `readNodeIdentity` / `resolveRecipesPath`).

| Variable | Default | Meaning |
|---|---|---|
| `NODE_AGENT_PORT` | `30091` | HTTP port the agent listens on. |
| `NODE_AGENT_BIND` | `0.0.0.0` | Bind address. |
| `NODE_AGENT_TOKEN` | *(unset)* | Optional bearer token; when set, all endpoints require `Authorization: Bearer <token>`. |
| `NODE_ID` | hostname | Node id (must match the registry id the dashboard uses). |
| `NODE_NAME` | hostname | Human-readable node name. |
| `NODE_LAN_IP` | first non-loopback IPv4 | LAN IP reported in snapshots. |
| `LLM_PORTS` | `8080` | Comma-separated LLM server ports to probe for live versions/requests. |
| `NODE_COMFY_PORT` | `8188` | ComfyUI port; `0` disables the probe. |
| `RECIPES_PATH` | `<agent>/config/recipes.json` | Path to the recipe file (see below). |

### Recipe file resolution

- `RECIPES_PATH` set → used **as-is**; if that file is missing, the catalog is
  empty (it is *not* papered over with the example).
- `RECIPES_PATH` unset → `<agent>/config/recipes.json`; if *that* is missing, it
  falls back to `<agent>/config/recipes.example.json` so the agent still boots.

An unreadable or schema-invalid recipe file logs a warning and yields an empty
catalog — the agent keeps running and telemetry keeps flowing (graceful
degradation, mirroring the dashboard's registry).

---

## API

All endpoints are JSON. With `NODE_AGENT_TOKEN` set, send
`Authorization: Bearer <token>`.

| Endpoint | Method | Returns |
|---|---|---|
| `/telemetry` | GET | A full `NodeAgentSnapshot` (the primary data structure the dashboard polls). |
| `/versions` | GET | Live `VersionInfo[]` — the *actual* running config (image tag/digest + LLM `server_info` + process env), not a recipe. |
| `/containers` | GET | `ContainerInfo[]` — running (and, when requested, stopped) Docker containers. |
| `/services` | GET | `ServiceInstance[]` — recipes joined with live state. |
| `/memory` | GET | `MemoryBudget` — total/used/free + make-room plan. |
| `/requests` | GET | `RequestStats` — queued/running/finished by model/engine/port. |
| `/topology` | GET | `TopologyInfo` — role/rank/groupId/headId + this node's RoCE links. |
| `/actions` | POST | Execute an `ActionRequest`; returns `ActionResponse`. |
| `/audit` | GET | `AuditEntry[]` — recent action history. |
| `/health` | GET | `{"ok":true, ...}` liveness probe. |

The canonical shapes are pinned in
[`shared/api.schema.json`](../shared/api.schema.json)
(`NodeAgentSnapshot`) and [`shared/types.ts`](../shared/types.ts).

### Actions

POST an `ActionRequest` to `/actions`:

```json
{
  "actionId": "switch-llm-1",
  "type": "switch",
  "serviceName": "llm-tp1",
  "port": 8080,
  "modelId": "qwen3.8-27b",
  "engine": "sglang",
  "contextLength": 262144,
  "memFraction": 0.8,
  "idempotent": true,
  "timeoutMs": 30000
}
```

`type` is `start` | `stop` | `restart` | `switch`. The agent dispatches to the
right backend:

- **Docker** (`agent/actions/docker.js`) — start/stop/restart a container named
  in the recipe (`containerName`).
- **systemd** (`agent/actions/systemd.js`) — for services managed by a unit
  (`systemdUnit` in the recipe) instead of Docker.
- **LLM switch** (`agent/actions/llm-switch.js`) — swap the model/engine served
  on a port (stop old, start new with the requested model/context/memFraction).

The response is an `ActionResponse` (`status`, `ok`, `message`, `error`,
`durationMs`, `at`). Every action is appended to the audit log, visible at
`/audit`.

---

## Recipes

A **recipe** is a declarative description of a service that *can* run on this
node: model, engine, image, ports, and expected memory footprint. The recipe
file is a JSON object validated against
[`shared/recipe.schema.json`](../shared/recipe.schema.json):

```json
{
  "version": 1,
  "nodeId": "gx10-1c2c",
  "recipes": [
    {
      "name": "llm-tp1",
      "kind": "llm",
      "engine": "sglang",
      "port": 8080,
      "image": "lmsysorg/sglang:v1.2.0",
      "modelId": "qwen3.8-27b",
      "modelPath": "RadixArk/Qwen3.8-27B-NVFP4",
      "contextLength": 262144,
      "memFraction": 0.8,
      "tpSize": 1,
      "footprintMB": 24000,
      "containerName": "llm-tp1"
    }
  ]
}
```

**To add a new recipe** (e.g. a media pipeline):

1. Copy `agent/config/recipes.example.json` to your node's `recipes.json`
   (`~/sparkdash-node-agent/config/recipes.json`).
2. Add a recipe object with the required fields `name`, `kind`, `engine`,
   `port`, `image`, `footprintMB`. Fill in the optional fields relevant to your
   service (`modelId`/`modelPath`/`contextLength`/`memFraction`/`tpSize` for LLMs,
   `containerName` or `systemdUnit` for actions, `env`/`args`/`dependsOn` as needed).
3. Restart the agent (or re-run the install script) so it reloads the catalog.

`name` must match `^[a-z0-9][a-z0-9._-]{0,63}$` and be unique per node. A
malformed recipe file degrades to an empty catalog (the agent still boots), so
a typo never takes the node offline — but it *does* mean that service won't
show up, so validate against the schema before shipping:

```bash
# from the repo root
python3 -c "import json,sys; json.load(open('agent/config/recipes.example.json'))"
```

(For full schema validation use any JSON-Schema checker against
`shared/recipe.schema.json`.)

---

## Memory budgeting

`/memory` returns a `MemoryBudget` for this node, computed by
`agent/catalog/memory.js` (`computeMemoryBudget`). Inputs: total unified memory,
currently-used memory, the running services (with their `footprintMB` from the
recipe or live `docker stats`), and a `wantMB` (how much a new service needs).

It splits usage into **services** vs. **other** (non-service processes), then:

- If `free >= want`, `needMakeRoom` is `false` and `makeRoom` is empty.
- Otherwise it produces a **make-room plan** — an ordered list of
  `MakeRoomEntry { serviceName, freesMB, reason }` describing which stoppable
  services to stop to free enough memory, and sets `needMakeRoom` to `true`.

This lets the dashboard (and a future action handler) answer "can I fit model X
on this node, and if not, what should I evict?" without guessing. The
`footprintMB` field on every recipe is what makes this budgeting tractable —
set it as close to the real steady-state unified-memory footprint as you can.

---

## Notes / invariants

- **Pure pull.** The agent never opens a connection to the dashboard; it only
  serves. A firewall can safely allow only inbound 30091.
- **Stable seam.** The agent's output shapes are pinned in
  `shared/api.schema.json`; only Batch 0 and Batch 5B may change them.
- **Zero dependencies.** Node built-ins only; the Dockerfile's install stage
  exists for forward-compatibility, not for current needs.
- **Runs as non-root** inside the container (`USER node`), so action handlers
  need host access (Docker socket / systemd) to be mounted/granted explicitly
  if you enable `/actions` against the host.
