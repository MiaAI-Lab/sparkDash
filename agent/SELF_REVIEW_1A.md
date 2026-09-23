# Batch 1A — Node-Agent Telemetry: Pre-Gate Self-Review

Scope delivered: `agent/collectors/{util,gpu,cpu,mem,disk,net,docker,systemd,llm,comfy}.js`,
`agent/telemetry.js`, `agent/http.js`, integrated `agent/main.js`, 11 test files
(`node --test`: 101 pass / 0 fail), plus a 2-edit fix to `shared/api.schema.json`.

Expected inputs: env identity (`NODE_ID/NODE_NAME/NODE_LAN_IP/NODE_AGENT_PORT/
NODE_AGENT_BIND/NODE_AGENT_TOKEN/LLM_PORTS/NODE_COMFY_PORT`), local sysfs/proc
reads, `nvidia-smi` / `df` / `docker` / `systemctl` / `ip` CLIs, LLM + ComfyUI
HTTP probes. Expected outputs: `NodeAgentSnapshot` at `/telemetry` (and
`/versions`, `/containers`, `/health`, `/`) that validates against
`shared/api.schema.json`, with graceful null/[] degradation when any source is
absent. Why it matters: this is the seam the dashboard server polls — invalid
or crashing telemetry breaks every downstream consumer.

## 1. Inputs that endanger PROJECT goal — handled?
- **Schema defect found upstream:** `shared/api.schema.json` required a literal
  `""` property (and `TopologyInfo.required` had `""` instead of `"links"`),
  which made EVERY snapshot fail validation — blocking the batch acceptance
  test. Fixed with a red→green witness:
  - RED (before fix): `telemetry.test.js` → `AssertionError: schema violations:
    "$: missing required ''"`
  - GREEN (after 2-edit fix): `node --test` → 101 pass / 0 fail.
- **Concurrent-write collision:** Batch 1B committed `7258098` on `main`
  mid-run and its `main.test.js` expected catalog exports from `agent/main.js`.
  My first overwrite of `main.js` had clobbered their version — detected via
  their test failing on import. Fixed by restoring their file from
  `git show 7258098:agent/main.js` as the base and re-applying my 1A wiring
  (telemetry + HTTP) on top of their catalog seam. Their `main.test.js` is
  green in the final suite.
- **Spec defect:** task specified `nvidia-smi --query-compute-apps=...,utilities.gpu.memory.usage`
  — that field does not exist in nvidia-smi. Used `used_gpu_memory` (the field
  sparkDash `SystemCollector` uses). Documented in `gpu.js` header.

## 2. Inputs that break THIS code — handled?
Per-collector negative tests (all assert the documented null/[] degradation):
- gpu: nvidia-smi missing → `null`; `[N/A]` temperature → `null`; empty/garbage
  CSV → `null` (`gpu.test.js`).
- mem: unreadable /proc/meminfo → `null`; missing or zero `MemTotal` → `null`
  (`mem.test.js`).
- cpu: unreadable /proc/stat → `null`; all-zero counters → `null`; counters
  going backwards → no negative delta (usage 0) (`cpu.test.js`).
- disk: df failure → `[]`; no data rows → `[]` (`disk.test.js`).
- net: unreadable /proc/net/dev → `[]`; `ip` missing → `ip: null` (soft);
  counters decreasing → speeds clamped ≥ 0 via `Math.max(0, …)` (`net.test.js`).
- docker: docker CLI missing → `[]`; empty ps → `[]`; stats/inspect failure →
  containers with null live fields (still listed) (`docker.test.js`).
- systemd: systemctl missing → `[]`; no running units → `[]` (`systemd.test.js`).
- llm: unreachable port → `{backend: null}` entry (one per port); empty/invalid
  port list → `[]` (`llm.test.js`).
- comfy: unreachable /system_stats → `null`; invalid port (null/0/70000/
  "8188x"/"81.5") → `null` without ever calling fetch (`comfy.test.js`).
- http: snapshotFn rejecting → 500 JSON, no hang/crash (`http.test.js`).

## 3. Outputs detrimental to PROJECT — prevented?
- All percentage fields clamped 0–100 (schema min/max): gpu `usage`,
  `vramPercentage`; cpu `usage`; mem/disk `percentage`.
- `GpuMetrics.processes` sliced to 5 (schema maxItems) — `gpu.test.js`
  "keeps only top 5".
- `versions` only from live probes that actually detected a backend
  (`telemetry.test.js` "unreachable LLM ports do not enter versions") —
  no fake "running" services. `requests`/`memory`/`services`/`topology` are
  null/[] (later-batch ownership; contract allows null).
- Snapshot validates against the real `api.schema.json` in two tests
  (full mock + all-failing) — `telemetry.test.js`.

## 4. Outputs that break NEXT package — prevented?
- `agent/main.js` re-exports Batch 1B's catalog API unchanged
  (`loadCatalog`, `resetCatalog`, `resolveRecipesPath`, `loadRecipes`,
  `getRecipe`, `listRecipes`, `validateRecipe`, `validateRecipeFile`,
  `computeMemoryBudget`, `listServices`); their `main.test.js` passes.
- `createNodeAgent` keeps 1B's `{identity, catalog, start, stop}` shape;
  `start` now returns the listen address (superset of their
  `Promise<void>` contract, still awaitable the same way).
- Collector shapes mirror `shared/types.ts` JSDoc exactly; the three
  Batch-1A working types without a snapshot field yet (`LlmMetrics`,
  `ComfyMetrics`, `SystemdUnit[]`) are attached as additive properties
  `llm`/`comfy`/`systemd` — permitted by the schema (no
  `additionalProperties` restriction), documented in `telemetry.js` header
  for Batch 5B to formalize.
- `http.js` exposes `{start, stop}` with the spec'd signature
  `(snapshotFn, port, bind, opts?)`; `/telemetry` returns the full snapshot
  for 1B/2A wiring; bearer-token knob (`NODE_AGENT_TOKEN`) proven by a
  non-default-value test.

## 5. Optimal input → optimal output — confirmed?
Ground-truth numeric tests (hand-computed expected values):
- mem: 131072000 kB / 31457280 kB → used 97280 MB, percentage 76.
- cpu: counter delta 150/1000 → usage 15%, draw 14.2 W (5.2 + 59.8×0.15),
  tdp 65, temp 45 °C.
- net: +104857600 B rx / +52428800 B tx over 10 s → 10 / 5 MB/s, link 25000.
- disk: 104857600 used / 62914560 avail bytes → 100/60 MB, 63 %.
- docker: 8.00GiB/128GiB → 8192/131072 MB, uptime 7200 s, "8080:8080".
- llm (vllm): kv 0.42, p95 TTFT of {0.5:40, 1.0:95, +Inf:100, n=100} → 1.0 s;
  prefix 100/200 → 0.5.
- systemd: 500 s uptime − monotonic enter → 400 s / 100 s.
- Live smoke on Narthex (sample in verification report): real mem/disk/net,
  45 systemd units, `br0` IP 192.168.50.150, live 17 W power from hwmon,
  crawl4ai container with 8084:11235, gpu null (no nvidia-smi) — correct.

## 6. Degenerate input — prevents bad output?
Covered in §2. Additionally: docker `Names` with leading `/` or comma lists is
normalized to the first name; `docker ps` "Ports" text is parsed defensively;
`[N/A]` nvidia-smi fields never become NaN (`parseSmiNumber`); `docker stats`
MEM "0B" limits become `null` (unlimited), not 0.

## 7. Out-of-bounds input — reasonable error BEFORE crashing?
Port validation 1–65535 in `normalizeLlmPorts` / `parsePortList` /
`collectComfy` (invalid → `[]` / `null` / ignored). All divisions guarded:
`totalMB > 0`, `denom > 0`, `queries > 0`, `drafted > 0`, `dtSec > 0`,
`count !== prevCount`. NaN inputs killed at the parse layer
(`parseSmiNumber`, `numOrNull`, `parseSizeToMB`, `parseUptimeSeconds`).
No unhandled rejection path: every collector body is wrapped in try/catch
returning the documented null/[]; `http.js` routes snapshotFn rejection to
500 JSON.

## Fix cycles (each closed with red→green witness)
| # | Defect | Red witness | Fix | Green |
|---|--------|-------------|-----|-------|
| F1 | `shared/api.schema.json` stray `""` required entries | `telemetry.test.js`: `"$: missing required ''"` | 2-edit schema fix | 101/101 |
| F2 | `net.js` stored `rxBytes/txBytes`, read `last.rx/last.tx` → NaN | net tests: `rxSpeed: NaN` | store/read same keys | net tests green |
| F3 | `http.test.js` elided arrow param `(base, , getCalls)` → SyntaxError | file-level SyntaxError at line 59 | named param `_calls` | http tests green |
| F4 | net test fixture static counters → delta 0, not the ground truth | expected 10/5, got 0 | stateful reader (counters advance) | ground truth holds |
| F5 | my `main.js` rewrite clobbered Batch 1B's catalog main.js | `main.test.js`: "does not provide an export named 'loadCatalog'" | restored `7258098:agent/main.js` as base, re-integrated 1A wiring | `main.test.js` green |

## Notes (latent / for later batches)
- `SystemdUnit[]` has no `NodeAgentSnapshot` field; exposed as extra `systemd`
  property (schema-permitted). Batch 5B should decide: fold into `services`
  or add a seam field.
- `requests` (RequestStats) intentionally null in 1A — LlmMetrics carries
  queued/running but not a cumulative `finished` counter; Batch 1B owns
  `/requests` derivation.
- `vramAvailableMB` uses `MemAvailable` (GB10 unified-pool semantics, mirrors
  `SystemCollector`).
- CPU TDP defaults to 65 W (GB10) per spec even on x86 hosts lacking a
  powercap "CPU" entry; agent targets Sparks.
- `/telemetry` re-collects per request (no cache) — dashboard server owns
  poll pacing; add a TTL cache in 1B if polling tightens.
- Uncommitted working-tree changes from the 1B worker
  (`IMPLEMENTATION_PLAN.md`, `ORCHESTRATION.md`, `TEST_PLAN.md`) were NOT
  touched or committed by this batch.
