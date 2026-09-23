# Multi-Spark Dashboard — Test Plan

**Date:** 2026-09-22
**Author:** Jarvis (orchestrator)
**Supersedes:** —
**Companion to:** `IMPLEMENTATION_PLAN.md` (master plan + register)

This plan defines the gate requirements per batch. Every batch has:
- **Determinism** — injectable seeds for stochastic components; tests reproducible.
- **Known-answer test** — at least one independently derivable ground truth per numeric batch.
- **Seed-and-diff** — for state-mutation batches, a polluted, sentinel-seeded fixture with
  three invariants: idempotency, content preservation, append-not-overwrite.
- **Seam invariant** — for batches that cross a format boundary, a machine-checkable
  invariant on the producing batch's real output.

---

## 0. Test families

| Family | Purpose | Used by |
|---|---|---|
| **Unit** | Single function/class | All batches |
| **Collector** | Mock nvidia-smi/proc/docker/systemctl/HTTP → expected metrics | Batch 1A |
| **Catalog** | Mock recipes + live state → expected services/memory | Batch 1B, 5A |
| **Action** | Mock docker/systemd/LLM → expected action + audit | Batch 2A, 2B |
| **Aggregate** | Mock node-agent snapshots → expected aggregation | Batch 3A, 3B |
| **UI** | Mock snapshots → expected render | Batch 4A, 4B |
| **E2E** | Dashboard + node-agent wired → expected flow | Batch 5B, 6 |
| **Live** | Real 3-Spark fleet → expected telemetry | Batch 6 |

---

## 1. Batch 0 — Scaffolding & seam contract (neither)

**Gate:** files exist, valid JSON/TS, committed.

| Test | Type | Known-answer / Invariant |
|---|---|---|
| shared/types.ts parses | TS | tsc --noEmit passes |
| shared/api.schema.json valid | JSON | JSON.parse + ajv validate |
| shared/recipe.schema.json valid | JSON | JSON.parse + ajv validate |
| agent/package.json valid | JSON | JSON.parse; node -e "require('./agent/package.json')" |
| agent/main.js loads | JS | node -e "import('./agent/main.js')" (stub) |
| .gitignore updated | shell | git check-ignore agent/config/recipes.json |

**Seam invariant:** all three shared/ files validate; types.ts exports all canonical types
(NodeAgentSnapshot, VersionInfo, ServiceInstance, MemoryBudget, RequestStats, TopologyInfo,
ContainerInfo, ActionResponse, Recipe).

---

## 2. Batch 1 — Node-agent telemetry (numeric)

### 2A — collectors + telemetry + http + versions

**Gate:** known-answer per collector; seam invariant (NodeAgentSnapshot validates).

| Test | Type | Known-answer |
|---|---|---|
| gpu.js | Collector | Mock nvidia-smi output → expected {temp, usage, power, vram, processes, throttle} |
| cpu.js | Collector | Mock /proc/stat + /sys/class/thermal → expected {usage, temp, draw, tdp} |
| mem.js | Collector | Mock /proc/meminfo → expected {used, total, available} |
| disk.js | Collector | Mock df + iostat → expected storage metrics |
| net.js | Collector | Mock /proc/net/dev → expected {interfaces, rx/tx} |
| docker.js | Collector | Mock docker ps + stats + inspect → expected ContainerInfo[] |
| systemd.js | Collector | Mock systemctl list-units → expected units |
| llm.js | Collector | Mock HTTP /get_server_info + /v1/models + /health → expected LlmMetrics |
| comfy.js | Collector | Mock HTTP /system_stats + /queue → expected ComfyMetrics |
| telemetry.js | Aggregate | Mock all collectors → expected NodeAgentSnapshot (validates api.schema.json) |
| http.js | E2E | Mock telemetry → GET /telemetry returns NodeAgentSnapshot |
| versions.js | Collector | Mock docker inspect + /get_server_info → expected VersionInfo[] |

**Known-answer test (ground truth):**
- GPU: nvidia-smi `--query-gpu=temperature.gpu,utilization.gpu,power.draw,memory.used,memory.total`
  → parse → expected {temp: 45, usage: 80, power: {draw: 50, limit: 100}, vram: {used: 40, total: 128, percentage: 31}}
- Mem: /proc/meminfo `MemTotal: 125829120 kB` → expected {total: 122880 MB, used: ..., available: ...}
- Docker: `docker ps --format json` → expected ContainerInfo[] with {name, image, status, ports}
- LLM: /get_server_info `{context_len: 262144, mem_fraction_static: 0.76, tp_size: 1}` → expected
  LlmMetrics {contextLength: 262144, gpuMemoryUtilization: 0.76, slotsTotal: 1}

**Seam invariant:** NodeAgentSnapshot validates against api.schema.json.

### 2B — recipe catalog + memory budgeting

**Gate:** known-answer per catalog function; seam invariant (Recipe validates).

| Test | Type | Known-answer |
|---|---|---|
| recipes.js | Catalog | Mock recipes.json → expected Recipe[] (validates recipe.schema.json) |
| memory.js | Catalog | Mock footprints + free → expected MemoryBudget {free, services, makeRoom} |
| services.js | Catalog | Mock recipes + live state → expected ServiceInstance[] |
| config/recipes.example.json | Fixture | Valid recipe file (LLM tp1, LLM tp2, ComfyUI) |

**Known-answer test (ground truth):**
- Memory: free = 100 GB, services = [{name: "llm-tp1", footprint: 50}, {name: "comfy", footprint: 30}]
  → expected MemoryBudget {free: 100, used: 80, available: 20, makeRoom: []}
- Memory (make-room): free = 100 GB, services = [{name: "llm-tp1", footprint: 50},
  {name: "comfy", footprint: 30}, {name: "tts", footprint: 10}], want = 40 GB
  → expected makeRoom = [{name: "tts", footprint: 10}, {name: "comfy", footprint: 30}]
  (stop tts + comfy to free 40 GB)
- Services: recipes = [{name: "llm-tp1", engine: "sglang", port: 8080}], live = {8080: "up"}
  → expected ServiceInstance[] = [{name: "llm-tp1", status: "running", port: 8080}]

**Seam invariant:** Recipe validates against recipe.schema.json.

---

## 3. Batch 2 — Node-agent actions (state-mutation)

### 2A — docker actions + audit

**Gate:** seed-and-diff (idempotent, content preserved, append-not-overwrite); audit log.

| Test | Type | Invariant |
|---|---|---|
| docker.js | Action | Mock docker ps → start/stop/restart/rm → expected docker commands |
| audit.js | Action | Mock audit log → append → expected append-only (seed-and-diff) |
| docker.test.js | Unit | Seed-and-diff: run twice → empty diff (idempotent) |
| audit.test.js | Unit | Seed-and-diff: append → content preserved, append-not-overwrite |

**Seed-and-diff fixture (sentinel-seeded):**
- Docker: mock `docker ps` with sentinel containers [{name: "sentinel-1", image: "x", status: "up"}]
  → start "sentinel-1" → expected `docker start sentinel-1` (idempotent: run twice, second empty diff)
- Audit: mock audit log with sentinel entries [{ts: 1, action: "start", target: "sentinel-1"}]
  → append {ts: 2, action: "stop", target: "sentinel-1"} → expected log = [sentinel-1, sentinel-2]
  (content preserved, append-not-overwrite)

### 2B — systemd actions + LLM switch

**Gate:** seed-and-diff; LLM switch canary.

| Test | Type | Invariant |
|---|---|---|
| systemd.js | Action | Mock systemctl → start/stop → expected systemctl commands |
| llm-switch.js | Action | Mock LLM /health + /v1/models → switch → expected state (ready/loading/wedged/stopped) |
| systemd.test.js | Unit | Seed-and-diff: run twice → empty diff |
| llm-switch.test.js | Unit | Canary: mock /health 200 + /v1/models 200 → "ready"; /health 200 + /v1/models 404 → "loading"; /health 200 + /v1/models 200 + canary fail → "wedged"; /health 200 + /v1/models 200 + canary pass → "ready" |

**Seed-and-diff fixture (sentinel-seeded):**
- Systemd: mock `systemctl list-units` with sentinel units [{name: "sentinel.service", status: "active"}]
  → start "sentinel.service" → expected `systemctl start sentinel.service` (idempotent)
- LLM switch: mock old LLM {port: 8080, model: "qwen3.8-27b"}, new LLM {port: 8081, model: "glm-5.3"}
  → switch → expected: stop 8080, start 8081, canary 8081 → "ready"

---

## 4. Batch 3 — Dashboard aggregation (numeric)

### 3A — node registry + fleet connection

**Gate:** known-answer per function; seam invariant (NodeAgentSnapshot validates).

| Test | Type | Known-answer |
|---|---|---|
| registry.js | Aggregate | Mock node records → expected registry (extend sparks.json) |
| connection.js | Aggregate | Mock node-agent snapshots → expected fleet cache + WS fan-out |
| registry.test.js | Unit | Known-answer: 3 nodes → expected registry with {id, name, endpoint, role, rank, roce} |
| connection.test.js | Unit | Known-answer: 3 snapshots → expected fleet cache; WS fan-out → 3 messages |

**Known-answer test (ground truth):**
- Registry: nodes = [{id: "n1", endpoint: "192.168.50.226:30091", role: "head", rank: 0},
  {id: "n2", endpoint: "192.168.50.118:30091", role: "worker", rank: 1},
  {id: "n3", endpoint: "192.168.50.46:30091", role: "worker", rank: 2}]
  → expected registry with 3 nodes, roles, ranks, RoCE peers
- Connection: snapshots = {n1: {gpu: {...}, mem: {...}}, n2: {gpu: {...}, mem: {...}}, n3: {gpu: {...}, mem: {...}}
  → expected fleet cache {n1: snapshot, n2: snapshot, n3: snapshot}; WS fan-out → 3 messages

**Seam invariant:** NodeAgentSnapshot validates against api.schema.json.

### 3B — requests aggregation + topology

**Gate:** known-answer per function; topology known-answer.

| Test | Type | Known-answer |
|---|---|---|
| aggregate.js | Aggregate | Mock node-agent /requests → expected requests by model/engine/machine |
| topology.js | Aggregate | Mock roles/RoCE → expected topology diagram |
| aggregate.test.js | Unit | Known-answer: 3 nodes with requests → expected aggregation |
| topology.test.js | Unit | Known-answer: 3 nodes (head + 2 workers) → expected topology (head linked to 2 workers) |

**Known-answer test (ground truth):**
- Aggregate: requests = {n1: {model: "qwen3.8-27b", engine: "sglang", queued: 2, running: 1, finished: 10},
  n2: {model: "glm-5.3", engine: "vllm", queued: 0, running: 2, finished: 5}}
  → expected: byModel = {qwen3.8-27b: {queued: 2, running: 1, finished: 10}, glm-5.3: {queued: 0, running: 2, finished: 5}}
- Topology: nodes = [{id: "n1", role: "head", rank: 0}, {id: "n2", role: "worker", rank: 1, headId: "n1"},
  {id: "n3", role: "worker", rank: 2, headId: "n1"}]
  → expected: head = n1, workers = [n2, n3], roce = [{from: n2, to: n3}]

---

## 5. Batch 4 — Frontend (state-mutation)

### 4A — Overview/fleet + per-node + topology

**Gate:** seed-and-diff (idempotent render, content preserved); dead-wiring.

| Test | Type | Invariant |
|---|---|---|
| OverviewPage | UI | Mock snapshots → expected fleet cards (idempotent render) |
| SparkPage | UI | Mock snapshot → expected per-node detail (idempotent render) |
| Topology | UI | Mock topology → expected diagram (idempotent render) |
| dead-wiring | UI | Every knob (role, RoCE, memory) changes output |

**Seed-and-diff fixture (sentinel-seeded):**
- Overview: mock snapshots with sentinel nodes → render → expected cards (idempotent: render twice, same DOM)
- Topology: mock topology with sentinel head + 2 workers → render → expected diagram (idempotent)

### 4B — Service Manager + requests + memory UI

**Gate:** seed-and-diff; memory budgeting UI.

| Test | Type | Invariant |
|---|---|---|
| ServiceManager | UI | Mock services + memory → expected start/stop/switch UI (idempotent render) |
| Requests | UI | Mock requests → expected queued/running/finished viz (idempotent render) |
| dead-wiring | UI | Every knob (service, memory, request) changes output |

**Seed-and-diff fixture (sentinel-seeded):**
- ServiceManager: mock services with sentinel LLM + memory budget → render → expected UI (idempotent)
- Requests: mock requests with sentinel model/engine → render → expected viz (idempotent)

---

## 6. Batch 5 — Media services + deploy (both)

### 5A — media catalog

**Gate:** known-answer (media recipes validate); seed-and-diff.

| Test | Type | Known-answer / Invariant |
|---|---|---|
| media.js | Catalog | Mock media recipes → expected ServiceInstance[] (validates recipe.schema.json) |
| media-recipes.json | Fixture | Valid media recipe file (video, image, TTS, STT, voice) |
| media.test.js | Unit | Known-answer: 5 media services → expected ServiceInstance[] |

**Known-answer test (ground truth):**
- Media: recipes = [{name: "video", engine: "comfyui", port: 8188, footprint: 40},
  {name: "tts", engine: "qwen3-tts", port: 3000, footprint: 5}]
  → expected ServiceInstance[] = [{name: "video", status: "stopped", port: 8188}, {name: "tts", status: "stopped", port: 3000}]

### 5B — e2e wiring + deploy + docs + PR prep

**Gate:** known-answer (e2e); seed-and-diff (deploy scripts); PR description.

| Test | Type | Known-answer / Invariant |
|---|---|---|
| docker-compose.yml | E2E | Mock compose → expected dashboard + node-agent services |
| install-node-agent.sh | E2E | Mock install → expected node-agent installed (idempotent) |
| NODE-AGENT.md | Docs | Valid markdown |
| DEPLOYMENT.md | Docs | Valid markdown |
| PR description | Docs | Complete (target, branch, changes, tests) |

**Known-answer test (ground truth):**
- E2E: dashboard + node-agent wired → expected: dashboard polls node-agent, WS fan-out, UI renders
- Deploy: install-node-agent.sh → expected: node-agent Docker container running on :30091

---

## 7. Batch 6 — Test + verify + PR (both)

**Gate:** all gates green (≥3× each); live verification; PR submitted.

| Test | Type | Known-answer / Invariant |
|---|---|---|
| All unit tests | Unit | All pass (≥3×) |
| All collector tests | Collector | All pass (≥3×) |
| All catalog tests | Catalog | All pass (≥3×) |
| All action tests | Action | All pass (≥3×) |
| All aggregate tests | Aggregate | All pass (≥3×) |
| All UI tests | UI | All pass (≥3×) |
| All e2e tests | E2E | All pass (≥3×) |
| Live verification | Live | 3-Spark fleet → expected telemetry (gpu, mem, docker, llm, comfy) |
| PR | Docs | Submitted to MiaAI-Lab/sparkDash |

**Live verification (ground truth):**
- gx10-1c2c: node-agent on :30091 → expected: GPU (nvidia-smi), Mem (/proc/meminfo), Docker (qwen38-sglang), LLM (qwen3.8-27b), ComfyUI (if running)
- gx10-102c: node-agent on :30091 → expected: GPU, Mem, Docker (tp2-node0), LLM (aeon-vllm-ultimate)
- gx10-25ed: node-agent on :30091 → expected: GPU, Mem, Docker (tp2-node1), LLM (aeon-vllm-ultimate)

---

## 8. Determinism

All tests use injectable seeds for stochastic components:
- **GPU/CPU/Mem/Disk/Net collectors:** mock nvidia-smi/proc output (deterministic).
- **Docker/Systemd collectors:** mock docker/systemctl output (deterministic).
- **LLM/ComfyUI collectors:** mock HTTP responses (deterministic).
- **Memory budgeting:** mock footprints + free (deterministic).
- **Actions:** mock docker/systemd/LLM (deterministic).
- **Aggregate:** mock node-agent snapshots (deterministic).
- **UI:** mock snapshots (deterministic).
- **E2E:** mock dashboard + node-agent (deterministic).

**Seed-and-diff:** all state-mutation tests use sentinel-seeded fixtures; run twice → empty diff.

---

## 9. Gate requirements (per batch)

| Batch | Gate | Requirements |
|---|---|---|
| 0 | Files exist | Valid JSON/TS, committed |
| 1A | Known-answer | Per collector (mock → expected) |
| 1B | Known-answer | Per catalog function (mock → expected) |
| 2A | Seed-and-diff | Idempotent, content preserved, append-not-overwrite |
| 2B | Seed-and-diff | Idempotent; LLM switch canary |
| 3A | Known-answer | Per aggregate function (mock → expected) |
| 3B | Known-answer | Per aggregate function (mock → expected) |
| 4A | Seed-and-diff | Idempotent render; dead-wiring |
| 4B | Seed-and-diff | Idempotent render; dead-wiring |
| 5A | Known-answer | Media recipes validate |
| 5B | E2E | Dashboard + node-agent wired; deploy scripts idempotent |
| 6 | All gates | All pass (≥3×); live verification; PR submitted |

---

## 10. Seam invariants (cross-batch format boundaries)

| Seam | Producer | Consumer | Invariant |
|---|---|---|---|
| NodeAgentSnapshot | Batch 1A (telemetry.js) | Batch 3A (connection.js), Batch 4A (UI) | Validates api.schema.json |
| Recipe | Batch 1B (recipes.js) | Batch 5A (media.js), Batch 2A/2B (actions) | Validates recipe.schema.json |
| MemoryBudget | Batch 1B (memory.js) | Batch 4B (UI), Batch 2A/2B (actions) | Validates api.schema.json |
| ServiceInstance | Batch 1B (services.js) | Batch 4B (UI), Batch 2A/2B (actions) | Validates api.schema.json |
| RequestStats | Batch  1A (llm.js) | Batch 3B (aggregate.js), Batch 4B (UI) | Validates api.schema.json |
| TopologyInfo | Batch 3B (topology.js) | Batch 4A (UI) | Validates api.schema.json |
| ContainerInfo | Batch 1A (docker.js) | Batch 4A (UI) | Validates api.schema.json |
| VersionInfo | Batch 1A (versions.js) | Batch 4A (UI) | Validates api.schema.json |
| ActionResponse | Batch 2A/2B (actions) | Batch 4B (UI) | Validates api.schema.json |

**Rule:** every batch that produces or consumes a seam validates against the schema.
**Trusted vs suspect:** Batch 0 produces the schemas (trusted); all other batches consume (trusted).
If a batch changes a schema, enumerate every consumer (production + tests) and update them.
