# Changelog

All notable changes to **sparkDash** are documented here.  
The README [Latest version changelog](./README.md#latest-version-changelog) always reflects only the current release; this file keeps the full history.

Format: version sections are listed newest first.

---

## [1.3.1] — 2026-07-24

### Fixed
- **LLM probe `/slots` 404 spam** — once a backend is known to be vLLM or SGLang, skip the llama.cpp `/slots` re-probe on each detect cycle (still probes on first contact / unknown / llama.cpp). Thanks [@kesslerio](https://github.com/kesslerio) ([#16](https://github.com/MiaAI-Lab/sparkDash/pull/16), fixes [#15](https://github.com/MiaAI-Lab/sparkDash/issues/15))

---

## [1.3.0] — 2026-07-23

Major feature release.

### Added
- **LLM Prompt Showcase** — full-page multi-terminal streaming demo (`/showcase/:sparkId`) opened from the LLM panel
  - Up to **32** concurrent chat streams with curated default prompts; optional prompt editor (“Show prompts”)
  - Dense auto-fit terminal grid, brand chrome in the config bar, Hide/Show controls with peek strip (Stop + aggregate tok/s)
  - Aggregate **tok/s** hero from server `/metrics` during the run (peak, tokens, streams)
  - Copy one terminal or copy all as plain text; collapsible reasoning vs answer styling
  - Thinking-flag adapter (`enable_thinking` vs MiniMax `thinking_mode`, with 400 retry)
  - Ephemeral sessions with heartbeat cancel; mutual exclusion vs DecodeBench (409 both ways)
  - Shared streaming helper extracted for DecodeBench + Showcase (`LlmStreaming.js`)

### Changed
- Mid-run: Port / Terminals / Max tokens / Run locked; Stop stays available
- Changing terminal count after a run clears stale streams and rebuilds the grid

---

## [1.23.2] — 2026-07-23

### Added
- **Copy results** on the decode benchmark dialog — clipboard plain-text summary (`model | decode tok/s results:` plus per-concurrency decode/server tok/s, optional peak, TTFT; failed rows included)

---

## [1.23.1] — 2026-07-22

### Fixed
- **Local Spark VRAM lag** — Docker Compose sets `pid: host` so `nvidia-smi` compute-apps sees host GPU processes on each poll (parity with remote SSH Sparks)
- **Stale `gpu-memory.json` override** — a successful live compute-apps result (including cleared **0**) is trusted; the host cron file is backup only when live query is unavailable
- **Unified Memory GPU used** — prefer live compute-apps cache over the cron file; fix cache sum using `vramMB`

---

## [1.23.0] — 2026-07-22

### Added
- **Centralized metrics history store** (`src/hooks/metricsStore.ts`)
  - Single writer from the WebSocket snapshot path; series keyed by `${sparkId}:${metric}`
  - Caps each series at 1800 samples (~1 h at the default 2 s poll); sparklines read a 30-sample tail
  - Survives Spark tab switches (history no longer lives in per-panel `useState`)
  - Offline Sparks skip ingest so frozen hosts do not drag charts to zero
  - Series: `gpu.usage`, `gpu.temp`, `cpu.usage`, `llm:${port}.tps` (multi-port aware)
  - `useSpark` / `getSpark` selective-subscription seam; orphan series pruned when a Spark leaves the WS list

### Changed
- **GPU/CPU sparklines** — Usage and Temperature charts widened (180px)
- **Spark tab pills** — memoize label + online dot only; drag handle stays outside memo so reorder listeners stay fresh

---

## [1.22.6] — 2026-07-22

### Added
- **Compact UI** (Settings toggle; persisted as `density: "comfortable" | "compact"`, default comfortable)
  - Applies `data-density` on `<html>` with CSS tokens for shell/header/page/panel/card spacing, root font size, and tighter radius
  - Overview cards, Spark page grid, Panel padding/title margin, and dashboard header gap all follow density tokens
  - Compact mode pins panel/overview `.text-sm` metric text to 14px

---

## [1.22.5] — 2026-07-22

### Added
- **vLLM LLM panel row 3** (when `backend === "vllm"`)
  - **Prefix Cache** — lifetime hit rate (`prefix_cache_hits_total` ÷ `prefix_cache_queries_total`)
  - **E2E p95** — end-to-end request latency from `e2e_request_latency_seconds`
  - **ITL p95** — inter-token latency from `inter_token_latency_seconds`
  - **MTP Accept** — speculative decode acceptance (`spec_decode_num_accepted_tokens_total` ÷ `spec_decode_num_draft_tokens_total`)
  - Parsed from the same `/metrics` body as existing tiles; tooltips match the row-2 pattern; missing series show **—**

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
