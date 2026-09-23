# Multi-Spark Dashboard — Implementation Plan

**Date:** 2026-09-22
**Revised:** 2026-09-22
**Author:** Jarvis (orchestrator)
**Supersedes:** Phase 0 research notes (2026-09-22, in-conversation)
**Base:** Fork of `MiaAI-Lab/sparkDash` @ `airhamer/sparkDash` (upstream 1.8.8, commit `754f40a`)
**Goal:** A multi-Spark dashboard (up to 8 units) that monitors, and via a per-node agent
starts/stops/switches LLMs and media services, with live model+engine versions, request
aggregation by model/engine/machine, memory budgeting, and role/RoCE topology.

---

## 0. How to read this file

This file is the **master plan AND the open register**. Read it top-to-bottom for the
design; read §3a for what is open. §6 (running log) is newest-first. Companion docs:
- `TEST_PLAN.md` — gate requirements per batch (determinism, known-answer, seed-and-diff, seams)
- `DELEGATION_AUDIT.md` — per-capability DELEGATE/KEEP-DIRECT/CONSOLIDATE verdicts
- `shared/` — the seam contracts (types.ts, api.schema.json, recipe.schema.json) that
  every worker builds to. **Workers read shared/; only Batch 0 and Batch 5B write it.**
- `ORCHESTRATION.md` — dispatch log, gate findings, tool policy (created at first dispatch)

Nothing is open work unless it is a row in §3a. This file is committed at creation
(Batch 0) and stays tracked.

---

## 1. Where We Are (verified 2026-09-22)

### 1.1 Live fleet (read-only SSH probe, 2026-09-22 ~11:00 EDT)

| Node | Hostname | LAN IP | Tailscale | Docker (running) | Ports | Mem | Disk |
|---|---|---|---|---|---|---|---|
| Node 1 | gx10-1c2c | 192.168.50.226 | 100.72.165.103 | qwen38-sglang (lmsysorg/sglang) Up 2d | SGLang :8080, cockpit :30090, embed :8081, SearXNG :8888, Redis :6379 | 71/121 GiB | 691/916 G (80%) |
| Node 2a | gx10-102c | 192.168.50.118 / 10.200.0.1 | — | tp2-node0 (aeon-vllm-ultimate:2026-09-18-v0.29.0-omni) Up 37h | :8000 | 96/121 GiB (8.1 free) | 680/916 G (79%) |
| Node 2b | gx10-25ed | 192.168.50.46 / 10.200.0.2 | — | tp2-node1 (aeon-vllm-ultimate:2026-09-18-v0.29.0-omni) Up 38h | :8000 | 93/121 GiB (11 free) | 486/916 G (56%) |
| Gateway | Narthex | 192.168.50.150 | 100.122.55.39 | (gateway host) | Qdrant :6333/:6334, Redis :6379, Crawl4AI :8084 | — | — |

- All 3 Sparks reachable from Narthex (ping 0 loss).
- RoCE 200GbE link UP between 102c↔25ed (enp1s0f1np1, 10.200.0.x/10.201.0.x, MTU 9000,
  RoCE GIDs present, passwordless sudo on both).
- qwen38 endpoint (worker model): `http://gx10-1c2c:8081/v1` (keepalive proxy fronting
  :8080), model `qwen3.8-27b`, max_model_len 262144, 32-char key at `~/.config/qwen38/api-key`.
- Node 1 runs the hasso5703/dgx-spark-qwen38 cockpit on :30090 (single-instance, stdlib
  Python) — the control pattern we generalize.
- Nodes 2a/2b currently run aeon-vllm-ultimate v0.29.0-omni TP2 (Qwen38-27B 1M context).

### 1.2 Base repo (sparkDash fork, @ 1.8.8)

- Frontend: React 19, TypeScript, Vite 8, Tailwind v4. 71 files under src/.
- Server: Node.js ESM (plain JS), Express 5, ws. ~30 modules under server/.
- Architecture: "one Spark model, N instances" — `config/sparks.json` registry,
  `SparkMonitor` per Spark, `SystemCollector` (local sysfs/proc or remote SSH),
  `LlmProbe` (HTTP, backend autodetect: llama.cpp/vLLM/sglang/ds4/EXL3/q27).
- REST `/api/*` + WebSocket `/ws` snapshot stream.
- Existing tabs: Overview (fleet), per-Spark detail, ComfyUI, Hermes Agent, Tailnet,
  decode/prefill bench, prompt showcase, power controls, themes.
- Existing roles: head/worker/standalone (config field `role`, `workerNode`, `workerLabel`,
  `workerHeadId`). **No RoCE topology, no service start/stop/switch, no memory budgeting,
  no request aggregation by model/engine/machine, no live model+engine versions.**
- Loopback-only by default; single bearer token for LAN bind (SPARKDASH_TOKEN).

### 1.3 Gap analysis (requirement → base → plan)

| Requirement | sparkDash | qwen38 cockpit | Plan |
|---|---|---|---|
| Multi-spark (up to 8) | ✅ | ❌ | Keep sparkDash model |
| ComfyUI monitoring | ✅ | ❌ | Keep |
| Head/Worker/Standalone roles | ✅ | ❌ | Keep + add RoCE links |
| Start/stop/switch LLMs + containers | ❌ | ✅ (single) | **Add** (per-node agent) |
| Requests queued/running/finished by model/engine/machine | partial | ✅ | **Add** (aggregate) |
| Machine stats | ✅ | ✅ | Keep |
| Live model + engine versions (not "last tested") | ❌ | ✅ (recipes/drift) | **Add** (docker inspect + server_info) |
| RoCE connections between head/worker | ❌ | ❌ | **Add** (manual designation v1) |
| TP2 large models (Qwen38-27B 1M ↔ GLM 5.3 ↔ others) | ❌ | ❌ | **Add** (recipe catalog) |
| TP1 per-node options | ❌ | ❌ | **Add** |
| Video/image/audio-tts/stt/conversation services | partial (Comfy) | ❌ | **Add** (AEON catalog) |
| Auto-switch services on demand + resize memory | ❌ | ❌ | **Add** (memory budgeting) |
| Run from any LAN machine, view from any browser | ✅ (loopback+token) | ✅ (tailnet) | Keep + generalize |

---

## 2. Target Design

### 2.1 Two tiers: node agent + dashboard server

**Decision (5.b.4/5.b.5):** per-node agent/daemon for all actions + telemetry (not SSH).
The node agent runs on each Spark (and on Narthex so it is a first-class node). The
dashboard server polls node agents over HTTP and fans out over WebSocket.

```
┌──────────────────────────── Node Agent (each Spark) ─────────────────────────────┐
│  agent/main.js  (Node.js ESM, plain JS, no build step)                            │
│  ├─ collectors/  gpu cpu mem disk net docker systemd llm comfy  (local, no SSH)   │
│  ├─ catalog/     recipes.js memory.js services.js media.js                        │
│  ├─ actions/     docker.js systemd.js llm-switch.js audit.js                      │
│  └─ http.js      local HTTP server :30091                                         │
│       GET  /telemetry   → NodeAgentSnapshot (metrics+containers+services+versions)│
│       GET  /versions    → VersionInfo[] (live model+engine versions)              │
│       GET  /services    → ServiceInstance[] (running services)                    │
│       GET  /memory      → MemoryBudget (free + make-room plan)                    │
│       GET  /requests    → RequestStats (queued/running/finished by model/engine)  │
│       GET  /topology    → TopologyInfo (role, rank, RoCE peers, tp group)         │
│       GET  /containers  → ContainerInfo[] (docker ps)                             │
│       POST /actions     → ActionResponse (start/stop/restart/switch)              │
│       GET  /audit       → audit log tail                                          │
└────────────────────────────────────────────────────────────────────────────────────┘
                    ▲ HTTP (LAN, per-node :30091)
                    │
┌──────────────────────────── Dashboard Server (Narthex or any LAN machine) ───────┐
│  server/  (extend sparkDash Express+WS)                                          │
│  ├─ fleet/     registry.js (node registry)  connection.js (poll+WS fan-out)      │
│  │            aggregate.js (requests by model/engine/machine)  topology.js       │
│  ├─ sparks/    SparkRegistry, SparkMonitor  (existing)                           │
│  ├─ collectors/ SystemCollector, LlmProbe, ComfyProbe ...  (existing)            │
│  └─ index.js   REST /api/* + WS /ws                                              │
└────────────────────────────────────────────────────────────────────────────────────┘
                    ▲ WebSocket /ws + REST /api/*
                    │
┌──────────────────────────── Frontend (React, extend sparkDash) ──────────────────┐
│  src/                                                                    │
│  ├─ OverviewPage/   fleet: all nodes, roles, RoCE links, memory, requests │
│  ├─ SparkPage/      per-node: GPU/CPU/mem/disk, containers, services, versions│
│  ├─ Topology/       standalone/head/worker + RoCE connections diagram       │
│  ├─ ServiceManager/ start/stop/switch LLMs + media services, memory budgeting│
│  ├─ Requests/       queued/running/finished by model/engine/machine         │
│  ├─ api/            client.ts, types.ts (extend)                            │
│  └─ hooks/          useSnapshot.ts (extend)                                 │
└────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Node agent (agent/)

- **Runtime:** Node.js ESM, plain JS (JSDoc types), no build step. Mirrors sparkDash
  server style. Runs as a Docker container on each Spark (default; decision A2/5B) on
  port **30091** (next to the cockpit's 30090).
- **Telemetry (local, no SSH):**
  - GPU: `nvidia-smi` (temp, usage, power, vram, processes, throttle).
  - CPU/mem/disk/net: sysfs/proc (reuse sparkDash SystemCollector patterns).
  - Containers: `docker ps` + `docker stats` + `docker inspect` (live image tag → engine version).
  - LLM: HTTP to local LLM servers (`/get_server_info`, `/v1/models`, `/health`, `/metrics`).
  - ComfyUI: HTTP to local ComfyUI (`/system_stats`, `/queue`, `/history`).
- **Versions (live, not "last tested"):** `docker inspect` image tag → engine version;
  LLM `/get_server_info` + `/v1/models` → model name, context len, mem-fraction, tp_size.
- **Service catalog + recipes:** declarative per-node recipe file (`config/recipes.json`),
  one entry per service (model/checkpoint/revision/quant, engine, image tag, context,
  mem-fraction, tp-size, port, container/systemd unit, memory footprint).
- **Actions:** docker start/stop/restart/rm; systemctl start/stop; LLM switch = stop old →
  start new → canary probe → report `ready/loading/wedged/stopped`. Audited exact-argv log.
- **Memory budgeting:** track per-service footprint (recipe + live `docker stats`), compute
  free unified memory, produce "make-room" plan (which services to stop to free X GB).
- **Topology:** role (standalone/head/worker), rank, RoCE peer (manual designation v1).
- **Local HTTP API:** read-only GETs + one POST /actions (start/stop/restart/switch).
  Bearer token optional (loopback trust by default, matching sparkDash).

### 2.4 Dashboard server (server/fleet/)

- **Node registry:** extend sparkDash's `sparks.json` with node-agent endpoint
  (IP:port), role, rank, RoCE peers. One record per node.
- **Fleet connection manager:** poll each node agent (configurable interval, default 2s),
  cache snapshots, fan out over WebSocket. Graceful degradation (offline node = stale/empty).
- **Aggregation:** requests by model/engine/machine (from node agents' /requests),
  fleet memory, roles/RoCE diagram.
- **REST `/api/*` + WS `/ws`:** single bearer token (SPARKDASH_TOKEN).

### 2.5 Frontend (src/)

- **Overview (fleet):** all nodes, roles, RoCE links, memory, requests. Reuse sparkDash
  OverviewPage patterns; add node-agent-backed cards.
- **Per-node detail:** GPU/CPU/mem/disk, containers, services, versions, requests.
- **Service Manager tab:** start/stop/switch LLMs + media services, memory budgeting/auto-switch.
- **Requests viz:** queued/running/finished by model/engine/machine.
- **Topology:** standalone/head/worker + RoCE connections.

### 2.6 Media services (v1 catalog)

| Service | Type | Engine | Image/Recipe | Port | Memory (approx) |
|---|---|---|---|---|---|
| LLM tp1 | llm | sglang | hasso5703/dgx-spark-qwen38 (qwen38-sglang) | 8080 | 50-70 GB |
| LLM tp2 | llm | vllm | aeon-vllm-ultimate v0.29.0-omni (Qwen38-27B 1M) | 8000 | 90-110 GB |
| LLM tp2 GLM | llm | vllm | tonyd2wild/vllm-glm53-flash:sm121-v11-dflash2 | 8000 | 90-110 GB |
| Image | image | comfyui | AEON-7/comfyui-aeon-spark | 8188 | 30-50 GB |
| Video | video | comfyui | AEON-7/aeon-movie-maker (LTX 2.3 22B) | 8188 | 40-60 GB |
| TTS | tts | qwen3-tts | AEON-7/qwen3-tts-server | 3000 | 5-10 GB |
| STT | stt | qwen3-asr | AEON-7/qwen3-asr-server | 3001 | 5-10 GB |
| Voice | voice | matrix-voip | AEON-7/matrix-voip-agent | 3002 | 3-5 GB |

(Music/radio-drama = v2. Exact images/recipes to be confirmed in Batch 5A.)

---

## 3. Implementation Phases (batch plan)

**Parallel safety:** within each batch, the two workers own **disjoint directories**
(stated per batch). Batch 0 commits the `shared/` seam contracts both build to.
Workers read `shared/`; only Batch 0 and Batch 5B write it.

**Hazard class tags:** numeric | state-mutation | both | neither.

| Batch | Worker 1 | Worker 2 | Hazard | Disjoint sets |
|---|---|---|---|---|
| **0 — Scaffolding & seam contract** | (in-house) | (in-house) | neither | — |
| **1 — Node-agent telemetry** | 1A: collectors (gpu/cpu/mem/disk/net/docker/systemd/llm/comfy) + telemetry.js + http.js + version detection | 1B: recipe catalog engine + memory budgeting model + /services /memory | numeric | 1A: agent/collectors/, agent/telemetry.js, agent/http.js · 1B: agent/catalog/, agent/config/ |
| **2 — Node-agent actions** | 2A: docker actions + action handlers + audit log | 2B: systemd actions + LLM switch (stop/start/canary/state) | state-mutation | 2A: agent/actions/docker.js, agent/actions/audit.js · 2B: agent/actions/systemd.js, agent/actions/llm-switch.js |
| **3 — Dashboard aggregation** | 3A: node registry + fleet connection manager + WS fan-out | 3B: requests aggregation (queued/run/finish by model/engine/machine) + roles/RoCE model | numeric | 3A: server/fleet/registry.js, server/fleet/connection.js · 3B: server/fleet/aggregate.js, server/fleet/topology.js |
| **4 — Frontend** | 4A: Overview/fleet + per-node detail + roles/RoCE diagram | 4B: Service Manager tab + requests viz + memory budgeting/auto-switch UI | state-mutation | 4A: src/components/OverviewPage/, src/components/SparkPage/, src/components/Topology/ · 4B: src/components/ServiceManager/, src/components/Requests/ |
| **5 — Media services + deploy** | 5A: media catalog (video LTX, image ComfyUI, TTS, STT, voice matrix-voip) recipes + integration | 5B: end-to-end wiring, docker-compose (dashboard + per-node agent), docs, PR prep | both | 5A: agent/catalog/media.js, agent/config/media-recipes.json · 5B: deploy/, docs/, docker-compose.yml |
| **6 — Test + verify + PR** | Run TEST_PLAN, verify on live 3-Spark fleet, submit PR to MiaAI-Lab | — | both | — |

### 3.1 Batch 0 — Scaffolding & seam contract (in-house, sequential)

**Scope:** planning docs + shared/ seam contracts + repo scaffolding. No worker.
**Deliverables:**
- `IMPLEMENTATION_PLAN.md` (this file)
- `TEST_PLAN.md`
- `DELEGATION_AUDIT.md`
- `shared/types.ts` — canonical TS types (telemetry, versions, recipes, memory, services, topology, actions)
- `shared/api.schema.json` — JSON Schema for node-agent HTTP responses
- `shared/recipe.schema.json` — JSON Schema for recipe files
- `shared/README.md` — how to read the seam contract
- `agent/package.json` — node-agent package manifest
- `agent/main.js` — stub entry (wired in Batch 1/2)
- `.gitignore` update (agent/, config/recipes.json)
**Gate:** files exist, valid JSON/TS, committed.

### 3.2 Batch 1 — Node-agent telemetry (2 parallel workers)

**1A — collectors + telemetry + http + versions**
- `agent/collectors/gpu.js` — nvidia-smi (temp, usage, power, vram, processes, throttle)
- `agent/collectors/cpu.js` — sysfs/proc (usage, temp, draw, tdp)
- `agent/collectors/mem.js` — /proc/meminfo (used, total, available)
- `agent/collectors/disk.js` — df + iostat (storage metrics)
- `agent/collectors/net.js` — /proc/net/dev (interfaces, rx/tx)
- `agent/collectors/docker.js` — docker ps + stats + inspect (containers)
- `agent/collectors/systemd.js` — systemctl list-units (systemd units)
- `agent/collectors/llm.js` — HTTP to local LLM servers (server_info, models, health, metrics)
- `agent/collectors/comfy.js` — HTTP to local ComfyUI (system_stats, queue, history)
- `agent/telemetry.js` — aggregate collectors into NodeAgentSnapshot
- `agent/http.js` — local HTTP server :30091 (GET /telemetry /versions /containers)
- Tests: `agent/collectors/__tests__/*.test.js`, `agent/telemetry.test.js`
- **Read-list:** shared/types.ts, shared/api.schema.json, agent/package.json, agent/main.js,
  sparkDash server/collectors/SystemCollector.js (patterns), sparkDash server/collectors/LlmProbe.js (patterns)

**1B — recipe catalog + memory budgeting**
- `agent/catalog/recipes.js` — load/validate recipes (JSON Schema), recipe registry
- `agent/catalog/memory.js` — memory budgeting model (free, per-service footprint, make-room plan)
- `agent/catalog/services.js` — service registry (running services from recipes + live state)
- `agent/config/recipes.example.json` — example recipe file (LLM tp1, LLM tp2, ComfyUI)
- Tests: `agent/catalog/__tests__/*.test.js`
- **Read-list:** shared/types.ts, shared/recipe.schema.json, agent/package.json, agent/main.js,
  sparkDash server/sparks/SparkRegistry.js (patterns)

**Gate (numeric):** known-answer test per collector (mock nvidia-smi/proc/docker output →
expected metrics); seam invariant (NodeAgentSnapshot validates against api.schema.json);
recipe validates against recipe.schema.json; memory budgeting known-answer (mock footprints
→ expected free + make-room plan).

### 3.3 Batch 2 — Node-agent actions (2 parallel workers)

**2A — docker actions + audit**
- `agent/actions/docker.js` — docker start/stop/restart/rm (exact-argv)
- `agent/actions/audit.js` — audit log (append, read tail)
- Tests: `agent/actions/__tests__/docker.test.js`, `audit.test.js`
- **Read-list:** shared/types.ts, agent/package.json, agent/main.js, agent/telemetry.js (1A),
  agent/catalog/services.js (1B)

**2B — systemd actions + LLM switch**
- `agent/actions/systemd.js` — systemctl start/stop (exact-argv)
- `agent/actions/llm-switch.js` — LLM switch (stop old → start new → canary probe → state)
- Tests: `agent/actions/__tests__/systemd.test.js`, `llm-switch.test.js`
- **Read-list:** shared/types.ts, agent/package.json, agent/main.js, agent/telemetry.js (1A),
  agent/catalog/services.js (1B)

**Gate (state-mutation):** seed-and-diff (mock docker/systemd state → action → verify
idempotent, content preserved, append-not-overwrite); audit log append-only; LLM switch
canary (mock LLM /health + /v1/models → ready/loading/wedged/stopped).

### 3.4 Batch 3 — Dashboard aggregation (2 parallel workers)

**3A — node registry + fleet connection**
- `server/fleet/registry.js` — node registry (extend sparks.json with node-agent endpoint, role, rank, RoCE)
- `server/fleet/connection.js` — fleet connection manager (poll node agents, cache, WS fan-out)
- Tests: `server/fleet/__tests__/registry.test.js`, `connection.test.js`
- **Read-list:** shared/types.ts, shared/api.schema.json, server/sparks/SparkRegistry.js,
  server/index.js, src/api/types.ts

**3B — requests aggregation + topology**
- `server/fleet/aggregate.js` — requests by model/engine/machine (from node agents' /requests)
- `server/fleet/topology.js` — roles/RoCE model (standalone/head/worker, RoCE peers, tp groups)
- Tests: `server/fleet/__tests__/aggregate.test.js`, `topology.test.js`
- **Read-list:** shared/types.ts, shared/api.schema.json, server/sparks/SparkRegistry.js,
  src/api/types.ts

**Gate (numeric):** known-answer (mock node-agent snapshots → expected aggregation);
seam invariant (NodeAgentSnapshot validates against api.schema.json); topology known-answer
(mock roles/RoCE → expected diagram).

### 3.5 Batch 4 — Frontend (2 parallel workers)

**4A — Overview/fleet + per-node + topology**
- `src/components/OverviewPage/` — fleet cards (nodes, roles, RoCE, memory, requests)
- `src/components/SparkPage/` — per-node detail (GPU/CPU/mem/disk, containers, services, versions)
- `src/components/Topology/` — standalone/head/worker + RoCE connections diagram
- Tests: `src/components/OverviewPage/*.test.tsx`, `src/components/Topology/*.test.tsx`
- **Read-list:** shared/types.ts, src/api/types.ts, src/api/client.ts, src/hooks/useSnapshot.ts,
  src/components/OverviewPage/ (existing), src/components/SparkPage/ (existing)

**4B — Service Manager + requests + memory UI**
- `src/components/ServiceManager/` — start/stop/switch LLMs + media services, memory budgeting/auto-switch
- `src/components/Requests/` — queued/running/finished by model/engine/machine
- Tests: `src/components/ServiceManager/*.test.tsx`, `src/components/Requests/*.test.tsx`
- **Read-list:** shared/types.ts, src/api/types.ts, src/api/client.ts, src/hooks/useSnapshot.ts,
  src/components/SparkPage/ (existing)

**Gate (state-mutation):** seed-and-diff (mock snapshots → UI state → verify idempotent
render, content preserved); dead-wiring (every knob changes output); memory budgeting UI
(make-room plan renders correctly).

### 3.6 Batch 5 — Media services + deploy (2 parallel workers)

**5A — media catalog**
- `agent/catalog/media.js` — media service recipes (video LTX, image ComfyUI, TTS, STT, voice)
- `agent/config/media-recipes.json` — media recipe file
- Tests: `agent/catalog/__tests__/media.test.js`
- **Read-list:** shared/types.ts, shared/recipe.schema.json, agent/catalog/recipes.js (1B),
  agent/catalog/memory.js (1B)

**5B — e2e wiring + deploy + docs + PR prep**
- `deploy/docker-compose.yml` — dashboard + per-node agent compose
- `deploy/install-node-agent.sh` — per-node agent install script
- `docs/NODE-AGENT.md` — node-agent docs
- `docs/DEPLOYMENT.md` — deployment docs
- `docker-compose.yml` — extend (dashboard)
- `.env.example` — extend (node-agent env)
- PR prep: branch, commit, PR description
- **Read-list:** shared/types.ts, shared/api.schema.json, shared/recipe.schema.json,
  agent/main.js, server/fleet/registry.js (3A), server/fleet/connection.js (3A)

**Gate (both):** known-answer (media recipes validate against recipe.schema.json);
seed-and-diff (deploy scripts idempotent); e2e (dashboard + node-agent wired, PR description complete).

### 3.7 Batch 6 — Test + verify + PR

- Run full TEST_PLAN (all batches, all gates, ≥3× each)
- Verify on live 3-Spark fleet (gx10-1c2c, gx10-102c, gx10-25ed)
- Submit PR to MiaAI-Lab/sparkDash
- **Gate (both):** all gates green, live verification, PR submitted.

---

## 3a. Open register

**THE action list.** Grouped by what blocks each item. Ids keep historical prefixes.

### Needs-a-decision (blocked on human)
| Id | Item | Blocker |
|---|---|---|
| D1 | Confirm media service images/recipes (Batch 5A) | Need exact AEON-7 image tags + ports for video/image/TTS/STT/voice |
| D2 | Node-agent Docker image (Batch 5B) | Need to confirm node-agent runs as Docker container on each Spark (vs bare systemd) |
| D3 | PR to MiaAI-Lab (Batch 6) | Need to confirm PR target + branch name |

### Ready (unblocked)
| Id | Item | Batch |
|---|---|---|
| R1 | Batch 0 scaffolding + seam contracts | 0 |
| R2 | Batch 1A collectors + telemetry + http + versions | 1 |
| R3 | Batch 1B recipe catalog + memory budgeting | 1 |
| R4 | Batch 2A docker actions + audit | 2 |
| R5 | Batch 2B systemd actions + LLM switch | 2 |
| R6 | Batch 3A node registry + fleet connection | 3 |
| R7 | Batch 3B requests aggregation + topology | 3 |
| R8 | Batch 4A Overview/fleet + per-node + topology UI | 4 |
| R9 | Batch 4B Service Manager + requests + memory UI | 4 |
| R10 | Batch 5A media catalog | 5 |
| R11 | Batch 5B e2e wiring + deploy + docs + PR prep | 5 |
| R12 | Batch 6 test + verify + PR | 6 |

### Follow-on (after v1)
| Id | Item |
|---|---|
| F1 | Music/radio-drama services (v2) |
| F2 | Auto-detect RoCE topology (vs manual designation) |
| F3 | Node-agent on Narthex (gateway as first-class node) |
| F4 | Fleet energy (extend sparkDash /api/fleet-energy to node agents) |
| F5 | Power controls (shutdown/WoL) via node agent |

---

## 4. Orchestration Plan

- **Orchestrator:** Jarvis (this session, agent:main, Narthex).
- **Workers:** 2 parallel per batch, both on gx10-1c2c 256k qwen38 endpoint.
  - Model: `vllm/qwen3.8-27b` (baseUrl `http://gx10-1c2c:8081/v1`, ctx 262144, maxTok 65536, reasoning).
  - Spawn: `sessions_spawn(mode:"run")`, no agentId, no context (isolated).
  - Each worker loads `orchestrated-worker` skill.
- **Dispatch:** sequential batches; within a batch, 2 parallel workers (disjoint file sets).
- **Gate:** orchestrator runs gates (≥3×), verifies commits, marks DONE.
- **Poll:** cron poll (agentTurn, sessionTarget = orchestrator sessionKey) to check worker status.
- **Report:** to human on escalation, halt, phase completion, or long silence.

---

## 5. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Node-agent Docker image not built (Batch 5B) | Medium | High | Confirm image build in Batch 5B; fallback to bare systemd |
| Media service recipes wrong (Batch 5A) | Medium | Medium | Confirm exact images/ports with Steve (D1) |
| Memory budgeting inaccurate (Batch 1B) | Low | Medium | Use live docker stats + recipe footprints; known-answer test |
| LLM switch canary false-positive (Batch 2B) | Low | Medium | Mock /health + /v1/models; seed-and-diff |
| Frontend state-mutation bugs (Batch 4) | Medium | Medium | Seed-and-diff; dead-wiring check |
| PR to MiaAI-Lab rejected (Batch 6) | Low | Low | Confirm PR target + branch (D3); keep fork |
| Worker context blowout | Low | Medium | Read-lists ≤2k lines/10 files; split if needed |
| Parallel workers share files | Low | Medium | Disjoint file sets per batch (stated) |

---

## 6. Running log

**2026-09-23 ~07:45 EDT** — Batch 2 DONE (commits 0cfc831 + a5a97f8). Worker 2A
delivered agent/actions/{docker,audit,index}.js + tests (126 tests). Worker 2B
delivered agent/actions/{systemd,llm-switch}.js + tests (57 tests). Gate: 183/183
full agent suite pass, 3× runs, index.js merged (22 exports, no collisions).
Ruling on 2B's F1: canary states map to ActionResponse.status per shared/types.ts
(ready→success, loading→running, wedged/stopped→failure) — no types.ts change
needed; Batch 5B will formalize if UI needs "loading" verbatim. Batch 3 dispatched
(node registry + fleet connection, requests aggregation + topology).

**2026-09-22 ~21:35 EDT** — Batch 1B DONE (commit 7258098). Worker 1B delivered
agent/catalog/{recipes,memory,services}.js + config/recipes.example.json + tests
(40/40 pass). Ruling on worker's `ruling-needed:`: TEST_PLAN known-answer #2 expected
makeRoom=[{tts,5000}] was infeasible for its own inputs (deficit=17120; tts frees 5000
→ 27880 < 40000). Worker correctly implemented greedy largest-first over stoppable
services → [{llm,50000,"stoppable"}]. TEST_PLAN updated with corrected expected value
+ two additional known-answers (infeasible, needed-excluded). Latent note: active=true
for every running LLM recipe — with two LLMs on different ports both report active;
kept as-is (per-port active) until Batch 4B UI needs a single-active view.
Batch 1A still running (collectors).

**2026-09-22 ~11:16 EDT** — Batch 0 in progress. Planning docs written. Seam contracts
(shared/types.ts, api.schema.json, recipe.schema.json) written. Repo scaffolding
(agent/package.json, agent/main.js) written. Committing Batch 0.

**2026-09-22 ~11:00 EDT** — Phase 0 complete. Decisions locked (A1-A3, B4/B5, C6, E11, F13).
Architecture: per-node agent + dashboard server. Fork: airhamer/sparkDash @ 1.8.8.
Worker model: vllm/qwen3.8-27b @ gx10-1c2c:8081 (262144 ctx).

**2026-09-22 ~09:52 EDT** — Research complete. Landscape: sparkDash (base), hasso5703 cockpit
(control pattern), AEON-7 (media catalog), tonyd2wild GLM-5.3 (TP2 recipe). Live fleet verified
(3 Sparks + Narthex). Gap analysis complete.

**2026-09-22 ~03:00 EDT** — Initial request. Multi-Spark dashboard, start/stop/switch LLMs +
media services, live versions, request aggregation, memory budgeting, RoCE topology.
