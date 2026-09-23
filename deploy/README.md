# Deploy — multi-Spark dashboard

Quick-start for deploying the dashboard server and the per-node agents.

| File | Purpose |
|---|---|
| `deploy/docker-compose.yml` | Compose for both services (`sparkdash` + `node-agent`) |
| `deploy/Dockerfile.node-agent` | Multi-stage Dockerfile for the node agent |
| `deploy/install-node-agent.sh` | Idempotent per-node installer |
| `docs/NODE-AGENT.md` | Node-agent deep-dive |
| `docs/DEPLOYMENT.md` | Full deployment + configuration guide |
| `deploy/PR-DESCRIPTION.md` | PR body for `MiaAI-Lab/sparkDash` |

---

## Quick start

### 1. Install the node agent on each Spark

On each DGX Spark (from a checkout of the repo):

```bash
./deploy/install-node-agent.sh
```

- Builds `airhamer/sparkdash-node-agent:latest`
- Writes `~/sparkdash-node-agent/config/recipes.json` (from `recipes.example.json`;
  never overwrites an existing file)
- Starts the `sparkdash-node-agent` container on host networking
- Verifies `curl http://127.0.0.1:30091/health` → `{"ok":true,...}`

**Idempotent** — re-running removes and re-creates the container.

Alternative:

```bash
docker compose -f deploy/docker-compose.yml up -d node-agent
```

### 2. Start the dashboard on one host (Narthex)

```bash
docker build -t airhamer/sparkdash:latest .
docker compose -f deploy/docker-compose.yml up -d sparkdash
```

Or use the repo-root [`docker-compose.yml`](../docker-compose.yml), which mounts
live `./server` code with `node --watch` (dev mode).

Dashboard listens on `:5555`.

### 3. Register the nodes

Edit `config/nodes.json` on the dashboard host (mounted at
`/app/config/nodes.json`):

```json
{
  "nodes": [
    { "id": "gx10-1c2c", "name": "Node 1", "endpoint": "192.168.50.226:30091",
      "lanIp": "192.168.50.226", "role": "head", "agentPort": 30091 },
    { "id": "gx10-27c1", "name": "Node 2", "endpoint": "192.168.50.44:30091",
      "lanIp": "192.168.50.44", "role": "worker", "agentPort": 30091 }
  ]
}
```

`id` must match the agent's `NODE_ID` on that host. The dashboard picks up new
nodes on the next poll cycle; removed nodes disappear from the fleet view.
Roles/ranks/RoCE links are manual (v1) — see `docs/DEPLOYMENT.md` → *Node
registry*.

### 4. Verify

```bash
curl -s http://<dashboard-host>:5555/api/fleet | python3 -m json.tool | head
```

---

## Config

| What | Where |
|---|---|
| Node registry (dashboard) | `config/nodes.json` ← `NODES_JSON_PATH` (in-container `/app/config/nodes.json`) |
| Recipe catalog (node agent) | `config/recipes.json` per node ← `RECIPES_PATH` (in-container `/app/agent/config/recipes.json`) |
| Auth tokens | `SPARKDASH_TOKEN` (dashboard), `NODE_AGENT_TOKEN` (agent) — see `.env.example` |

Full env-var reference: `docs/DEPLOYMENT.md` → *Configuration*.

## Docs

- [`docs/NODE-AGENT.md`](../docs/NODE-AGENT.md) — what the agent does, API,
  recipes, memory budgeting, actions
- [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) — architecture, deployment,
  registry, fleet connection, frontend build, PR prep
- [`deploy/PR-DESCRIPTION.md`](PR-DESCRIPTION.md) — PR body for
  `MiaAI-Lab/sparkDash`
