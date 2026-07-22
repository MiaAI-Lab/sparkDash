# Changelog

All notable changes to **sparkDash** are documented here.  
The README [Latest version changelog](./README.md#latest-version-changelog) always reflects only the current release; this file keeps the full history.

Format: version sections are listed newest first.

---

## [1.2.2] — 2026-07-22

### Added
- **Benchmark debug traces** (Settings → **Enable debug traces for Benchmark runs**, default **off**)
  - When enabled, each decode-bench wave persists: full stream **prompts**, HTTP status/headers, SSE **completion IDs**, finish reason, token **usage**, content previews (first/last chars — not full output), and ~1 Hz **GPU** samples (util, temp, power, VRAM)
  - Local Sparks sample fresh GPU metrics during the run; remotes use the live snapshot cache (avoids SSH spam)
  - `config.debug: true` is recorded on jobs that ran with traces on

### Changed
- **Decode benchmark dialog UI**
  - Tighter, more consistent padding on the sheet (header / body / footer)
  - Results shown as denser comparison rows: load/TTFT on the left; **Server** and **Decode** tok/s **right-aligned**
  - Column headers on wider screens; clearer status/progress chrome and legend
  - **Max tokens / stream** stacked like Concurrency (label + hint above a compact input) so the field no longer wraps into a crushed column
  - Max-tokens input value **left-aligned**

### Fixed
- **Worker role flipping to Standalone**
  - API fallback tab snapshots no longer hardcode `role: "standalone"` — they copy role / workerLabel / workerHeadId / llmMonitoring from the registry
  - After Edit/save refresh, live WS metrics are kept but role fields are refreshed from the API
  - PATCH with `role: null` / invalid role no longer clobbers a persisted Worker (normalize would otherwise fall through to Standalone)
  - `workerNode: true` without an explicit role promotes to **Worker**; role strings are trimmed/lowercased
  - Unit tests cover coerce/patch edge cases (`server/sparks/__tests__/role-normalize.test.js`)

### Docs
- README hero screenshot: **`assets/screenshot.jpg`** replaces `screenshot.png` (PNG removed from the tree)
- Screenshot `<img>` no longer forces a fixed width (natural size in the GitHub README)
- README “Latest version changelog” retitled to **Version 1.2.2**

---

## [1.2.0] — 2026-07-21

### Added
- **Spark roles** (Edit Spark → **Role**): **Head**, **Worker**, **Standalone** (replaces the Worker-node checkbox)
  - **Head** — cluster head; local LLM always monitored; overview/header show a **Head** badge; MiniStat still shows live **vLLM / model id**
  - **Worker** — no local LLM API (card hidden, ports not probed); optional **Worker label** (cluster/model name) and **Head Spark** picker; overview MiniStat shows **Worker** / label; header shows **Worker** + label badges
  - **Standalone** — normal single-node Spark; optional **LLM monitoring** toggle (default on)
- **Standalone LLM monitoring** — when Role is Standalone, enable/disable probing and the LLM card without making the Spark a worker
- Role badges on Overview cards and Spark header (Head / Worker / Standalone)
- Shared `resolveSparkRole` / `isLlmMonitoringEnabled` helpers (`src/api/sparkRole.ts`)

### Fixed
- **Shutdown “Failed to fetch”** — remote shutdown verifies script/`sudo -n`, then backgrounds so SSH returns before the host dies; only mid-session connection drops count as success; local Sparks acknowledge HTTP **before** power-off; Shutdown All does remotes first, local last
- **Docker image build** — drop flaky second-stage `npm ci --omit=dev`; prune in builder and copy `node_modules`; retry on first `npm ci`
- **Worker → Standalone** — switching role back to Standalone re-enables LLM monitoring (worker had forced it off)

### Notes
- `workerNode` remains derived (`role === "worker"`) for existing probe/card checks; prefer `role` in new code.
- Legacy configs with only `workerNode: true` migrate to role **Worker**.
- Thin alternative to contributor PR #9 (`llmCluster` topology) — same overview/worker UX via `workerLabel` + `workerHeadId`.

---

## [1.1.7] — 2026-07-21

### Added
- **vLLM inference tiles** on the LLM panel (shown only when `backend === "vllm"`):
  - **KV Cache** — usage % from Prometheus (`kv_cache_usage_perc`), colour-coded (green / amber / red)
  - **Requests** — running / waiting counts
  - **TTFT p95** — time-to-first-token 95th percentile from histogram quantiles
  - **Preempts** — cumulative preemption counter
- **Info tooltips** (small “i”) next to each of those four metrics
- Histogram parse/quantile helpers in `LlmProbe` with unit tests (`npm test` → `server/collectors/__tests__`)

### Notes
- Metrics use the same single `/metrics` fetch already used for tok/s (no extra HTTP call).
- ITL p95 was considered and omitted to keep the panel readable; TTFT p95 is the latency signal kept.
- Supersedes contributor PR #11 without personal `docker-compose` SSH mounts or `host.docker.internal`.

---

## [1.1.5] — 2026-07-21

### Added
- **LLM decode benchmark**
  - **Run decode benchmark** on each LLM panel (when a model is available)
  - Multi-select **concurrency** levels (`1, 2, 3, 4, 6, 8, 16, 32`); default selection **1, 2**
  - Levels run **one after another**; within a level, N streams fire together
  - Each concurrent stream uses a **distinct JSON/HTML write-style prompt** (higher decode tok/s workloads)
  - Configurable **max tokens per stream** (default **500**, range 64–2048); input allows clearing digits while typing
  - Async jobs: `POST` starts → poll status; one active bench per Spark; cancel supported
  - Results show **Server tok/s** (live-style engine counter samples, same idea as Generation tok/s) and **Per-stream** decode after first token, plus TTFT and stream OK counts
  - Last run **persisted** (`config/bench-history.json`) and restored when reopening the dialog (survives refresh / restart)
  - Mobile-friendly solid sheet (portaled to `document.body`, scrollable body, sticky footer)
- **Remove additional LLM ports** — only non-primary ports show **Remove**; server rejects deleting the first port

### Fixed
- **GB10 GPU used / process list** (unified memory + Docker)
  - Host helper `config/gpu-memory.sh` writes safe JSON: used sum, **MemTotal** as pool size, process list (Python JSON; env-configurable path)
  - `SystemCollector` hydrates process cache from `gpu-memory.json` when in-container `compute-apps` is empty
  - Generated `config/gpu-memory.json` gitignored and no longer tracked
  - Supersedes contributor PR #10 (no machine-specific SSH mounts in compose)
- **Mobile Edit / Add Spark dialogs** — solid max-height sheet, scrollable form, sticky actions, body scroll lock (can reach all fields on phone)

### Notes
- Decode bench hits the real LLM endpoint over LAN; use off-peak for high concurrency.
- Host cron for GPU file (example): `* * * * * /path/to/sparkDash/config/gpu-memory.sh` with `./config` bind-mounted into Docker.

---

## [1.1.0] — 2026-07-20

### Added
- **Power management**
  - Per-Spark **Shutdown** and **Wake** controls in the Spark header
  - Overview **Shutdown All** (online Sparks only) and **Wake All**
  - Shutdown runs over SSH: `sudo -n /usr/local/bin/spark-shutdown` (install that script on each host with passwordless sudo for it)
  - Shared Wake-on-LAN helper (`server/wol.js`): MAC validation, `/24` broadcast from LAN IP (fallback `255.255.255.255`), single-settlement UDP send
- **Wake-on-LAN MAC**
  - Auto-detect MAC of the **enP7s7** interface during network polls (local + remote)
  - Persist as `detectedMacAddress` for use when the node is offline
  - Optional **MAC override** in Edit Spark (`macAddress`); Wake uses override → detected → request body
- **Worker node**
  - Edit Spark checkbox **Worker node** (with info tooltip)
  - When set: LLM panels and “Add LLM port” are hidden; LLM ports are not probed
  - **Worker node** badge in the Spark header
- README notes for power controls and LAN trust model for power APIs

### Notes
- Power APIs are unauthenticated like the rest of the dashboard — keep port **5555** on a trusted network only.

---

## [1.0.5] — 2026-07-20

### Added
- **Multiple LLM ports** — monitor several LLM servers on different ports simultaneously (each port gets its own panel and backend detection)
- **GPU processes** — top GPU processes by VRAM usage (name, PID, memory) in the GPU panel
- **Spark uptime** — system uptime badge inline on each Spark header

### Backend (summary)
- `SparkRegistry`: `llmPorts` array with migration from legacy `llmPort`
- `SparkMonitor`: `Map<port, LlmProbe>` for parallel multi-port polling
- `SystemCollector`: process list via `nvidia-smi`
- API: `PUT` / `POST` / `DELETE` LLM port endpoints

---

## Earlier releases

Versions before **1.0.5** were not recorded in a dedicated changelog. See git history for prior commits (e.g. themes, Docker layout, multi-Spark UI, encrypted SSH secrets).
