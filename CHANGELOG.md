# Changelog

All notable changes to **sparkDash** are documented here.  
The README [Latest version changelog](./README.md#latest-version-changelog) always reflects only the current release; this file keeps the full history.

Format: version sections are listed newest first.

---

## [Unreleased]

### Added
- **Tailnet monitoring** — opt-in per unit (`tailscaleMonitoring`, default **off**); `tailscale status --json` on the host and a Tailnet card under Resources. Flags a unit that is healthy on the LAN but off its tailnet. ([#43](https://github.com/MiaAI-Lab/sparkDash/pull/43))
- **NV_ERR_NO_MEMORY on the GPU panel** — count of NVRM `NV_ERR_NO_MEMORY` kernel log lines since boot (shown when > 0). Journal is scanned at most once a minute, not on the 2s poll. Replaces the approach in [#40](https://github.com/MiaAI-Lab/sparkDash/pull/40).

### Security
- **`BIND_HOST` now defaults to `127.0.0.1` (loopback) instead of `0.0.0.0`** — the dashboard is unauthenticated and can SSH into and power off Sparks, so it is no longer reachable on the LAN by default. Set `BIND_HOST` to the host's LAN IP (or `0.0.0.0`) to opt in to remote access. **Migration:** if you access sparkDash from another machine via bare-metal `npm start`, set `BIND_HOST` explicitly. Production and dev Compose both set `BIND_HOST=0.0.0.0` (`network_mode: host`). Startup now also warns when bound to a non-loopback address. ([#35](https://github.com/MiaAI-Lab/sparkDash/pull/35))

### Fixed
- Decode bench `POST /api/sparks/:id/llm/bench` rejects LLM ports that are not in the Spark's configured list (same allowlist as showcase). ([#45](https://github.com/MiaAI-Lab/sparkDash/pull/45))
- **Host CPU temperature** — dedicated GPU hosts (`kind: host`) show CPU temp on the RAM panel and Overview (hidden at 0°C / no sensor). Remote hosts now read hwmon/thermal over SSH. DGX Sparks still do not display CPU temp (remote Sparks still skip the extra sensor SSH). ([#34](https://github.com/MiaAI-Lab/sparkDash/pull/34))

### Changed
- README architecture diagram top border aligned with the box. ([#39](https://github.com/MiaAI-Lab/sparkDash/pull/39))

---

## [1.8.1] — 2026-08-16

### Added
- **Daily LLM tok/s history** — busy-sample rollups (peak + mean) for decode and prefill, persisted in `config/llm-daily.json` (30 UTC days). 14-day peak chart on the LLM card; `GET /api/sparks/:id/llm/daily`.
- **Cached vs uncached prefill tok/s** — live rows when the backend splits kinds: ds4 labeled prefill counters, llama.cpp `/slots` `n_prompt_tokens_cache`, SGLang `sglang:cached_tokens_total` (L1 `cache_source="device"`). Combined Prefill stays computed/uncached. vLLM is unchanged (combined prefill + prefix-cache hit rate).

### Changed
- **Docker SSH key auth** — compose comments + README: key auth runs inside the container (`/root/.ssh`), not the host user’s `~/.ssh`. Custom-named keys must be mounted as `id_ed25519` (or set `SSH_IDENTITY_FILE`). LAN IPs are from the sparkDash host. Add/Edit Spark hint when auth is Key.

### Fixed
- SGLang `/metrics` no longer overwrites `/get_server_info` tok/s when both are present.
- llama.cpp `n_prompt_tokens_processed: 0` is not treated as missing (fully cached prompts).

---

## [1.8.0] — 2026-08-15

### Added
- **Non-Spark unit support** (`kind: "host"`) — dedicated GPU hosts (any Linux box with an NVIDIA GPU, e.g. a workstation with an RTX card) are first-class units: added from the **+** button (choose **Dedicated GPU host**), monitored via SSH + `nvidia-smi` exactly like a Spark, but never labeled as a DGX Spark.
- **Detected host hardware** — for `kind: "host"`, the header shows real hardware detected once when online (GPU model, CUDA driver, CPU model/cores, system RAM) instead of fixed GB10 specs.
- **Separate system RAM vs discrete VRAM** — for host units, VRAM comes straight from `nvidia-smi` (`memory.used` / `memory.total`, free = total − used) while system RAM is read from `/proc/meminfo`. Spark behavior is unchanged (GB10 unified HBM pool).
- **RAM panel + Overview RAM bar** — host unit pages get a dedicated RAM panel, and Overview cards show a RAM bar under VRAM for hosts.
- **Host Resources layout** — host unit pages stack **RAM → Network → Storage** in the right column with **GPU** filling the left column (Sparks keep the original layout). CX7 IP is hidden for hosts (Spark-specific NIC).
- **Prefill tok/s** (moved from Unreleased) — live LLM panel sparkline, Overview cards as two columns (**tok/s** | **prefill**), decode-bench **Prefill** column (`prompt_tokens` ÷ TTFT).
- **Live prefill measurement** — vLLM uses engine-step `iteration_tokens_total` surplus over generation (so a short/cached prefill that lands in the same poll as the first decode tokens still counts); prompt/TTFT counters are the fallback because they often only move at first token. ds4 uses computed (not cached) prefill token diffs. Idle returns to 0. Opening a saved chat in the UI does not hit the GPU; prefill is the prompt/KV pass when you send or regenerate.

### Changed
- **Decode benchmark matches Showcase structural** — same prompt catalog and fill-to-max shaping (`min_tokens` / `ignore_eos` / fill suffix); no 4k unique prefill prefix. Temperature **0**, thinking **off** (Showcase defaults are temp 0.7 and thinking off). Default max tokens 512.
- **Update Hermes button is now a permanent, neutral control** — no more toast notifications for Hermes updates. It turns warning-yellow and shows a commit-count badge **only when an update is actually available**; clicking it opens the update dialog (status / pending commits / release notes) as before.
- **Overview "Update Hermes" button** (formerly "Update All") follows the same rule — neutral by default, warning-yellow with a pending-count badge only when ≥1 monitored Spark has an update available. Pressing it now shows a **live progress bar** (x/y Sparks settled, driven by WS per-Spark update status) until every started update finishes.

### Fixed
- **Decode benchmark "Benchmark not found" mid-run** — running jobs lived only in memory, so a `node --watch` / SIGTERM reload dropped them and the dialog poll hit 404. Active benches are now checkpointed to `config/bench-active.json`, finalized on shutdown, and recovered as interrupted on boot; the dialog also recovers via the list endpoint instead of showing a bare 404.

### Removed
- **Toast system** (`useToasts.ts`, `useHermesAlerts.ts`, `components/ui/Toaster.tsx`) — Hermes notifications now live entirely on the header button instead of pop-up toasts.

---

## [1.7.0] — 2026-08-08

### Added
- **Hermes Agent service per Spark** — opt-in `hermesMonitoring` toggle in Edit Spark; when on, sparkDash treats the Hermes Agent CLI (nousresearch/hermes-agent) as installed on that machine
- **Update notifications** — background `hermes update --check` poll (10 min) per monitored Spark; a toast alerts when an update is available
- **One-click update** — `Update Hermes` button in the Spark header and in the update alert toast; runs `hermes update` over SSH (non-interactive), with running/success/error state streamed over WS
- **Hermes status in snapshot** — installed / version / updateAvailable / behindCommits / checkedAt / job status per Spark (`snapshot.hermes`)
- **Toast system** — minimal built-in toast store + Toaster component (no new dependency), reused for Hermes alerts
- **Update confirmation dialog with real content** — clicking Update Hermes (header button or alert toast) opens a modal with **Update now** / **Cancel**. When the update is only commits on `main` (no newer tagged release than what is installed), it shows the **actual pending commits** from git (`HEAD..origin/main`) instead of the latest-release changelog — the full release changelog is shown only when a real version bump exists
- **`GET /api/sparks/:id/hermes/updates`** — update preview: latest release (cached) + installed version + **real pending commits** from git on the Spark + a resolved view; the old `/api/hermes/releases/latest` is superseded
- **Update All** — `POST /api/sparks/hermes/update-all` + Overview button runs `hermes update` on every Spark with Hermes Agent enabled (per-spark start/skip/fail summary; per-spark progress still streamed over WS)
- **`POST /api/sparks/:id/hermes/check`** (force check now) and **`POST /api/sparks/:id/hermes/update`** (background job, 202)

### Changed
- `hermesMonitoring` normalized in Spark config; server boots HermesProbe only when enabled (all roles, local + remote)
- Toast stack renders above modals at `z-index: 10000`

### Fixed
- **Local Spark Hermes runs as the wrong user (root), corrupting the install** — hermes + its git repo belong to the host user, but the local path executed hermes as the container root. That produced git "dubious ownership" failures and, once worked around, wrote root-owned files into the user's tree (tools/*.py, uv.lock, …) and ran `uv pip install` as root — which failed and left `venv/bin/hermes` missing, breaking the `hermes` CLI entirely. The local path now resolves the host user from the host passwd bind mount and drops to that user via `setpriv` (`nsenter` + host mount ns so host git is visible), with a self-healing root-owned-file repair step. Remote SSH already ran as the real user.
- **Broken launcher detection + auto-repair** — when the `hermes` launcher exists but cannot execute (e.g. missing venv entry point), sparkDash now reports "broken install" instead of a false "no update" and the one-click update automatically rebuilds the venv entry point (`uv pip install -e .`), then retries.
- **Stale git lock bricks later updates** — an interrupted `hermes update` can leave `.git/shallow.lock` (or any `*.lock`) behind, making every later fetch fail; leftover `*.lock` files are cleared before each check/update.

---

## [1.6.0] — 2026-08-07

### Added
- **ComfyUI monitoring** — opt-in per Spark (`comfyMonitoring`, default port **8188**); Edit Spark checkbox + inline port field; connectivity Test includes ComfyUI when enabled
- **ComfyUI probe** — `GET /system_stats` + `GET /queue` (job-centric card; no host RAM/VRAM duplicate of GPU/CPU panels)
- **Active / queued jobs** — workflow title, model weight names from the graph, footprint (resolution · steps · sampler · batch · node count)
- **Live progress** — Comfy WebSocket when events are available; elapsed/avg-duration estimate otherwise; progress bar on the running job
- **Last finished job** — status + duration from `/api/jobs` (with `/history` fallback)
- **Cancel / remove** — `POST /api/sparks/:id/comfy/cancel` to interrupt a running job or dequeue a pending one from the card
- **Open ComfyUI** — deep link to `http://{lanIp}:{comfyPort}` (LAN IP preferred over localhost for remote browsers)
- **Overview Comfy chip** — `Comfy · idle` / `run` / `Nq` / muted when unreachable (only when monitoring is on)
- **Model inventory** — checkpoints + LoRAs from `/models/*` (section hidden when both lists are empty)
- **Queue ETA** — estimate from recent job durations × pending (+ progress remainder when known)
- **Collapsible sections** — **Resources** (GPU / CPU / Storage / Network) and **Services** (LLM / ComfyUI); open state persisted in `localStorage`
- **Services layout** — primary LLM + ComfyUI side-by-side when both enabled; +1 extra LLM full-width; +2 extras as a pair; odd leftover full-width

### Changed
- **Compact UI is the default** layout density (`density: "compact"` in settings + CSS/`data-density`); comfortable remains available via Settings
- Spark snapshot includes **`lanIp`** / **`isLocal`** for client deep-links

### Fixed
- Comfy progress WebSocket soft-reconnects on host/port change (no longer permanently closed after `setTarget`)

---

## [1.5.0] — 2026-08-03

### Added
- **GPU thermal throttle meter** — collect NVIDIA `clocks_throttle_reasons` (HW/SW thermal, HW slowdown, SW power cap) plus SM current/max clocks via `nvidia-smi` (local and remote)
- **GPU panel Throttle row** — status chip (`OK` / `Thermal` / `Power` / `HW`) with SM clock bar and tooltip of active reasons
- **Overview thermal hint** — compact red “Thermal throttle” banner when any Spark reports thermal slowdown

---

## [1.4.7] — 2026-08-02

### Added
- **SGLang and DwarfStar (ds4-server) properly supported in LLM probes** — correct backend detection, model/context, and live tok/s for both engines alongside vLLM and llama.cpp
- **ds4-server / DwarfStar LLM probe** — auto-detect Entrpi/ds4-on-spark via `owned_by: ds4.c` or Prometheus `ds4_*` series; model/`context_length` from `/v1/models`; live tok/s from `ds4_tokens_*` counter diffs
- **`llmProbeHost`** — local Sparks probe `127.0.0.1` so loopback-bound servers (ds4 `start.sh` default `--host 127.0.0.1`) are reachable; Showcase / Decode bench / connectivity test use the same host
- **Docker host networking** — compose uses `network_mode: host` so the container can reach host loopback LLM ports

### Fixed
- **SGLang tok/s stuck at 0** — modern SGLang without `total_*_tokens` / `--enable-metrics` now reads `internal_states[].last_gen_throughput`
- **SGLang sticky ~30 tok/s when idle** — only treat `last_gen_throughput` as live after it changes between polls; expire to 0 when it stops moving
- **ds4 window-gauge idle bleed** — do not use `ds4_decode_tok_s` / `ds4_prefill_tok_s` (~60s averages) for the live panel

### Changed
- Backend badge / types include **ds4**; overview labels distinguish ds4 / sgLang / vLLM

---

## [1.4.5] — 2026-07-31

### Fixed
- **SGLang detection** — OpenAI-compatible servers are no longer always labeled vLLM; SGLang is identified via `owned_by` / `/get_server_info`, and HF hub cache model paths are shortened to `org/name` ([#29](https://github.com/MiaAI-Lab/sparkDash/pull/29))
- **Overview model name trim** — long LLM / worker labels wrap instead of ellipsis-truncating in the stats grid

### Changed
- **Decode benchmark concurrencies** — added 5, 10, 12, and 24 ([#27](https://github.com/MiaAI-Lab/sparkDash/pull/27))
- **LLM API key port renames** — keys migrate/prune when ports change; rejected keys show “Bad API key” ([#26](https://github.com/MiaAI-Lab/sparkDash/pull/26))

---

## [1.4.4] — 2026-07-30

### Added
- **Optional per-port LLM API key** — set a Bearer token in LLM panel Settings for OpenAI-compatible gateways (e.g. LiteLLM); stored encrypted like SSH passwords; used by probe, Showcase, and Decode bench ([#21](https://github.com/MiaAI-Lab/sparkDash/issues/21))

### Changed
- **Settings version label** — reads `package.json` version instead of a hardcoded string

---

## [1.4.3] — 2026-07-30

### Added
- **Shutdown confirmation dialog** — Shutdown / Shutdown All open a danger-zone modal requiring a checkbox and typing `poweroff` before powering off ([#22](https://github.com/MiaAI-Lab/sparkDash/issues/22), [#24](https://github.com/MiaAI-Lab/sparkDash/pull/24))

### Changed
- **Decode benchmark results** — dropped Server column; show Aggregate + per-stream tok/s

### Fixed
- **Storage tile height jump** — always show disk ↑/↓ I/O rates (`0 B/s` when idle) so multi-disk panels keep a stable height ([#20](https://github.com/MiaAI-Lab/sparkDash/issues/20), [#23](https://github.com/MiaAI-Lab/sparkDash/pull/23))

---

## [1.4.0] — 2026-07-29

### Added
- **Free storage** — each disk row in the Storage panel now shows available free space (GB) right-aligned next to used/total, and I/O speeds moved to their own row below

---

## [1.3.9] — 2026-07-28

### Added
- **Prompt Showcase prompt types** — **Text** / **Structural** / **Mixed** catalogs (mixed interleaves structural and text) so tok/s can be compared by workload shape; type is stored on runs and shown in History
- **Endpoint security posture badge** — per-LLM-panel green / amber / red hint from unauthenticated `/v1/models` (or `/slots`) reachability plus configured probe-host scope (loopback / LAN / public); tooltip does not claim process bind address ([#17](https://github.com/MiaAI-Lab/sparkDash/issues/17), [#19](https://github.com/MiaAI-Lab/sparkDash/pull/19))
- **Configurable `BIND_HOST`** — HTTP and WebSocket listen address via env (default `0.0.0.0`); documented for Docker bridge vs host-network / reverse-proxy setups ([#18](https://github.com/MiaAI-Lab/sparkDash/pull/18))

### Changed
- **Showcase fills max tokens** — each stream requests a full-length generation (`min_tokens` = `max_tokens`, `ignore_eos`, empty `stop`) plus a hard “do not stop early” prompt suffix; retries once without those fields if the backend returns HTTP 400; per-stream timeout raised to 360s for long fills

### Fixed
- **Live showcase tok/s under-count** — live/peak rates counted SSE deltas (often multi-token chunks on vLLM), so terminals showed ~6 tok/s while streaming then jumped to the real ~25 at completion; now estimate from streamed text (~4 chars/token) using the same first→last token window as final decode tok/s

---

## [1.3.4] — 2026-07-27

### Changed
- **Prompt Showcase model header** — model id shown as a prominent centered banner above the metrics strip (removed from the compact title stack under the spark name)
- **Prompt Showcase density** — tighter config fields/inputs/buttons and ~1px smaller base type for more room for the terminal grid

---

## [1.3.3] — 2026-07-25

### Added
- **Prompt Showcase history** — finished runs are archived to disk (`config/showcase-history.json`, last 20 per Spark); History panel to browse, open a past run (read-only terminals), reuse prompts/settings, or clear history
- **Showcase sampling temperature** — **Temp** control (0–2, default 0.7) before Run; validated server-side and applied to chat completions
- **Open Showcase when LLM is offline** — Showcase button remains available on the LLM panel when no model is loaded on the selected port (view history / stage a run)

### Changed
- **Peak tok/s** — per-terminal peak rate, always-visible aggregate and server peak in the metrics strip; peak included in copy-out

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
