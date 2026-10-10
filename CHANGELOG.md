# Changelog

All notable changes to **sparkDash** are documented here.  
The README [Latest version changelog](./README.md#latest-version-changelog) always reflects only the current release; this file keeps the full history.

Format: version sections are listed newest first.

---

## [Unreleased]

---

## [2.30.0] — 2026-10-10

The version number is 2.0.0 plus 0.01 for each of the 30 issues and pull requests closed since 2.0.0 shipped.

### Added
- **RoCE / RDMA monitoring.** Spark units with RDMA devices get a **RoCE / RDMA** panel: link state and rate, MTU, RX/TX traffic, errors and drops, PFC priorities, QoS trust mode and DSCP map, pause settings, and the RDMA / ethtool counters with their change since the last sample. Read from sysfs, `ethtool` and `mlnx_qos` on each Spark, without root or switch integration (about every 5 s, the slower ethtool and QoS facts every 30 s; units without RDMA are re-checked every 10 minutes). Two new health findings: *a RoCE link went down* and *RoCE is dropping packets*. The panel is collapsed by default (a one-line summary: links up, speed, PFC, loss) and remembers being opened. Exposed as `metrics.roce` in the unit's metrics. Requested by a user; switch telemetry could follow as an optional extra.
- **Time zone setting.** **Settings → Time zone** (`timeZone`, an IANA name such as `Europe/Paris`; empty follows each browser, as before) sets the hour and day boundaries and the labels on the Tokens, Energy and Activity charts, so the 24 h charts line up with your local time whatever the viewing device. Half-hour zones (India, Nepal) show correct `:30` / `:45` hour labels on the Tokens page. Daily token buckets and the monthly energy totals are stored per UTC day/month and stay UTC.
- **Install sparkDash as a mobile app (PWA).** Over HTTPS (for example Tailscale Serve) the dashboard installs to the home screen and runs fullscreen, with its own icon and an in-app install banner (iPhone gets the manual *Add to Home Screen* hint). A small service worker caches only the app shell; `/api`, `/ws` and `/metrics` always come from the network. README: *Tailscale Serve (HTTPS)* and *Mobile PWA*. Thanks @HassanEmam ([#188](https://github.com/MiaAI-Lab/sparkDash/pull/188)).
- **Windows PCs as units.** A Windows PC with an NVIDIA GPU can be added over the built-in OpenSSH Server: choose *Windows PC with an NVIDIA GPU* as the unit type. Two PowerShell scripts per poll supply GPU (`nvidia-smi`), RAM, uptime, CPU load, disks and network adapters; shutdown works. No CPU temperature, automatic Wake-on-LAN MAC detection, Hermes/Tailnet checks or kernel-error events on Windows. The connection test also checks that `nvidia-smi` answers. See *Windows PCs* in the README. Needs a real Windows host to confirm; reports welcome.
- **Prometheus export.** **Settings → Prometheus metrics** (`prometheusExport`, off by default) serves `GET /metrics` in the Prometheus text format, so the fleet can be scraped into Prometheus, VictoriaMetrics or Grafana and kept beyond the dashboard's own history. It renders the snapshot sparkDash already holds — no extra SSH or nvidia-smi calls per scrape — with node_exporter / DCGM-style names in base units: `sparkdash_up`, per-card GPU utilization, temperature, power, memory and throttle state (`gpu` label, so multi-GPU hosts get a series per card), `sparkdash_memory_available_bytes` (unified-pool `MemAvailable` on a GB10, free VRAM on a discrete GPU), CPU, RAM, network, disk, and per LLM endpoint `sparkdash_llm_up`, tok/s, KV cache fill, running requests and the engine's lifetime token counters. Every series is labelled with the unit's id, name, kind and role. An unreachable unit exports only `sparkdash_up 0`, and values the collectors could not read are omitted rather than reported as zero. The endpoint uses the existing auth (a bearer token on a token-protected remote bind); while the setting is off it answers 404. See the README's Prometheus section for a `scrape_config`.
- **Per-Spark `llmHost`.** A Spark's config can name the host the LLM probes and benchmarks talk to, separate from `lanIp` and `ssh.host`. This is for a serving cluster whose SSH or display name does not reach the API (for example, the head of a multi-Spark model that serves on another address). Empty keeps today's behavior: `127.0.0.1` for the local Spark, otherwise `lanIp`. The value is checked like the other target hosts, and `POST /api/sparks/:id/refresh/llm` re-probes the LLM after a change.
- **Restart sparkDash from the UI.** When the fleet changes and Energy needs a restart, the notice now has a "Restart sparkDash" button (with a confirm). Only offered when running in Docker with the compose restart policy; the page reloads itself when the server is back.
- **Monthly energy history.** Fleet energy now keeps a small permanent roll-up per UTC month (`config/fleet-energy-monthly.json`, `GET /api/fleet-energy/monthly`): watt-hours and coverage per node, the fleet total, output tokens and Wh per output token, and which Sparks were measured that month. Finished minutes are added once (a stored watermark prevents double counting across restarts), the first start backfills from the existing 31-day file, and when the fleet changes the previous scope's minutes are rolled up before its file is set aside. **Reset…** only empties the 31-day window; the archive is removed only by `DELETE /api/fleet-energy/monthly?month=YYYY-MM` or `?all=true&confirm=delete-all-history`. The Energy page has a new **Monthly history** panel with a month picker (per-node table, cost, efficiency, open or closed) and a year view of twelve monthly bars. A clock-jump guard never folds or advances the watermark past now + 1 day (a stored watermark beyond that is clamped back, totals kept), the panel refetches right after **Reset…**, months are UTC (the panel says so, as they will not match a local-time electricity bill), and old-scope minutes pass the same plausibility checks as the live file before they are rolled up.

### Fixed
- **Settings → Time zone is a stable row.** The title and help sit above the field, the field and "Use browser" are left-aligned under them, and one line is reserved for the message, so showing it never moves anything (it used to widen the control and crush the label). The "unknown time zone" message appears only after you leave the field, not while a name is half typed.
- **The GPU history chart fills its panel.** It stayed at about half the panel width on wide screens (and on any layout change after the first paint): the width observer was attached to the "collecting history" box, which is replaced by the chart once data arrives, so the chart kept its first width. The observer now follows whichever element is shown.
- **Review fixes for RoCE, the time zone setting and the tests.** A single dropped frame no longer raises a RoCE warning (port discards need two consecutive readings, RDMA counters three); a failed or empty read keeps the last good RoCE sample for a few reads instead of flapping, and RoCE can no longer hold up the network update; ports are listed in a stable order; the RoCE panel sorts after Network on narrow screens; its script forks about half as often. The Settings dialog refuses an unknown time zone instead of silently saving the browser default, and the Overview activity feed and the Token tables' tooltips follow the zone too. Test servers now override every config file path (a shared helper plus a test that fails when the server starts using a new one), so running the tests can no longer touch the real `bench-active.json` and friends.
- **Spark page: Unified memory, CPU and Models in one row.** The Models list is now the third column next to Unified memory and CPU (RAM and CPU on dedicated hosts) instead of a separate full-width row below them; it wraps to a second row when the column is narrow. The three cards in the row share one height.
- **The monthly energy archive could be moved aside by a server that merely could not read it.** A server run as another user (for example the test suite on the host, with the container's root-owned file) treated a permission error as a corrupt archive and renamed the file to `fleet-energy-monthly.unreadable-*.json`, once per restart. A file that cannot be *read* is now left alone and not overwritten (only content that is not valid JSON is set aside), and the test servers no longer touch the real `config/` archive.
- **The Fleet energy card says why coverage is partial.** "Partial coverage: 4/5 nodes currently fresh" now has an ⓘ tooltip that names the nodes without a fresh power reading and explains the cause (offline or not reporting); the Fleet energy data gains `staleNodeIds`.
- **CPU and RAM sit side by side on dedicated GPU hosts** (Windows PCs included), like unified memory and CPU on a Spark; they stack on narrow screens.
- **A token-protected remote bind no longer shows a blank page.** The built frontend (shell and assets) now loads without a token so the app can ask for it; `/api`, `/ws` and `/metrics` stay token-gated. Thanks @HassanEmam ([#183](https://github.com/MiaAI-Lab/sparkDash/pull/183)).
- **The SSH tunnel fallback for benchmarks and Showcase works again** ([#176](https://github.com/MiaAI-Lab/sparkDash/issues/176)): opening the tunnel threw `Unknown encoding: text`, so every remote unit whose LLM listens only on loopback failed. An unreachable `llmHost` no longer tunnels to the SSH host's loopback either.
- **`npm run dev` listens on loopback only**, so nobody on the LAN can reach the whole API through Vite's proxy. Thanks @danielkuykendall23-boop ([#168](https://github.com/MiaAI-Lab/sparkDash/pull/168)).
- **Windows units, first real-hardware pass.** Found on a Windows PC with an RTX 5090: the memory card no longer adds VRAM on top of RAM (it showed 100%), graphics processes with no memory figure (`dwm.exe`, `explorer.exe`) no longer fill the GPU process list, CPU temperature shows a dash instead of 0 °C, and model start/stop is not offered for Windows PCs (the Models panel and the Overview launcher are hidden, and the launcher API answers 400).
- **Model launchers no longer inherit the dashboard's environment** ([#186](https://github.com/MiaAI-Lab/sparkDash/issues/186)). A start script run on the local Spark saw the container's `PORT=5555` and tried to bind sparkDash's own port. Launcher and Hermes scripts now get a clean environment without `PORT`, `LLM_PORT`, `BIND_HOST`, `NODE_ENV`, `SPARKDASH_*` (the access token included) and the host-path variables.
- **A short first row of units stretches to the full width.** With two units on a wide screen the Overview's first row now fills the width of the row below instead of leaving empty columns. A single unit keeps its card size.
- **A Windows host added as a Linux unit now gets a clear SSH error** instead of cmd.exe's "'true' is not recognized…", pointing at the *Windows PC with an NVIDIA GPU* unit type.
- **"Frontend not built" after upgrading with Docker.** Compose mounts the host's `./dist` over the image's build, so a checkout that was never built with `npm run build` (or a fresh clone) showed an empty mount and a 503. The image now keeps a second copy (`dist-baked`) and the server uses it whenever `./dist` has no `index.html`; a host build takes over again without a restart. Rebuild the image once (`docker compose up --build -d`) to get the fallback. The message also now says how to fix it.
- **FreeToken on the LLM panel.** The KV cache, Running, E2E p95 and a new **TTFT mean** tile now show for FreeToken servers, and a protected `/v1/stats` is reported as needing a key instead of as missing data (both found with the tests from [#144](https://github.com/MiaAI-Lab/sparkDash/pull/144), thanks @oscarlius).
- **Decode benchmark: pick the model on a multi-model server.** When `/v1/models` lists several IDs (a router), the decode dialog shows a **Model** picker with the exact served IDs instead of silently benchmarking the first one, and the probe keeps reporting a real model id (`contextLength` is `null` for routers). Thanks @kesslerio ([#130](https://github.com/MiaAI-Lab/sparkDash/pull/130)).
- **FreeToken servers are no longer re-probed on `/slots`** — found by running the tests from [#144](https://github.com/MiaAI-Lab/sparkDash/pull/144) (thanks @oscarlius) against `main`.
- **Settings → Poll interval now sets how often units are polled.** The 1s / 2s / 5s / 10s choice only changed how often the dashboard was pushed a snapshot; the collectors kept their own env-only timers, so every unit was still polled over SSH every 2 s at 10 s (no load saved) and 1 s showed no fresher data. GPU, CPU/RAM, network, memory bandwidth, LLM and ComfyUI polling now follow the setting for every unit, and changing it re-arms the running monitors' timers in place — no restart, no duplicate polls, and an unreachable unit's paused polls and SSH backoff are kept. Memory bandwidth stays at 2 s or slower because `nvidia-smi dmon` blocks for about a second. Storage, liveness, Tailnet, Hermes and the `NV_ERR` journal scan keep their own cadences. An explicitly set `POLL_INTERVAL_GPU` / `_CPU` / `_NETWORK` / `_LLM` / `_COMFY` / `_BANDWIDTH` still pins its domain. The dialog now says what the setting does and that 1 s costs the most on remote units.
- **Add / Edit dialog wording follows the unit type.** Choosing *Dedicated GPU host* now makes the final button read **Add GPU Host** (it always said *Add Spark*), and the Edit dialog title and the remove confirmation name the host the same way.
- **GPU history on hosts with several GPUs.** The main graph only ever showed the combined line (busiest card, hottest card, summed power), so a second card was invisible. The server now also keeps a history per card (`gpus[]` in `GET /api/sparks/:id/gpu-history`, existing fields unchanged), and with more than one GPU a toggle above the graph switches between **Combined**, **All GPUs** (one coloured line per card for utilization, power or temperature) and a single card. The choice is remembered. Single-GPU hosts look exactly as before.
- **Fleet energy efficiency keeps its digits.** The Overview card printed Wh/token with four fixed decimals, so a fleet-scale figure of ~0.001 Wh/token kept only one or two significant digits (0.0010537 read `0.0011`, and a busier day a single digit). It now shows three significant digits (`0.00105 Wh/token`).

---

## [2.0.0] — 2026-10-09

A major release: a redesigned application shell, a rebuilt Overview, a Benchmarks section with a new Tool Eval Bench, in-app Showcase, launchers for your own models, fleet-wide Token totals / Energy / Activity pages, a rewritten Quality bench, and a long list of correctness and security fixes. Everything under **Added**, **Changed** and **Fixed** below ships in 2.0.0.

### Highlights
- New shell: sidebar + command palette, four themes, smooth Apple-style page transitions, real links everywhere.
- Overview rebuilt around per-Spark cards that show the model, head/worker relations, a memory breakdown and a launcher.
- Benchmarks section: Decode, Prefill, Quality and **Tool Eval Bench** (new), with side-by-side compare.
- Showcase is now an in-app page with much smoother token streaming.
- Start and stop your own LLMs from the dashboard.
- Token totals, Fleet energy and Activity pages.
- Live prefill tok/s that no longer drops to 0 during a long prefill.

### Added
- **Health findings per Spark.** The server now runs a small set of explainable rules over metrics it already collects and reports them as `health[]` on each Spark snapshot (`server/health/HealthEvaluator.js`). Overview cards show the active findings as chips (details and what to try in the tooltip) and the Spark page lists them in full: **GPU running hot** (85 °C warn, 90 °C critical), **GPU stuck in a low-power state** (≥ 90 % utilisation but under 15 W for 5 samples in a row; normal decode draw does not trigger it), **unified memory running low** (under 3 GB available warns, under 1.5 GB is critical), **several models loaded while memory is busy**, and **network link slower than 1 Gb/s**.
- **Kernel errors become Activity events.** The GPU collector now reads NVIDIA **Xid errors** and kernel **OOM-killer kills** from the journal (one cached scan per minute; `gpu.kernelErrors` = `{ xid, oomKills, lastXid }`). When a counter rises, Activity records an event (new **Health** category) and the node shows a critical finding for the next hour. The first reading after a restart is only a baseline, so old errors since boot do not raise an alert.
- **Clear Activity history.** A **Clear history…** button on the Activity page deletes events older than 7 days, older than 24 hours, or everything, after an in-place confirmation (new `DELETE /api/events?olderThanMs=`; omit the parameter to delete all). Event ids keep counting up, so nothing already on screen is reused.
- **Reset Token totals and Fleet energy.** A **Reset…** button on each page. Fleet energy can delete minutes older than 7 days, older than 24 hours, or everything (`DELETE /api/fleet-energy?olderThanMs=`; power keeps being recorded afterwards). Token totals can reset all Sparks or just one (`DELETE /api/llm-token-totals?sparkId=`): counted totals and the daily/hourly history are zeroed while each engine's counter baseline is kept, so counting restarts from now instead of re-adding what the engine already served. Each asks for confirmation first.
- **Mobile: "Shut down all" lives in the Sparks sheet.** On phones the button moved from the Overview header into the Sparks menu (new "Fleet" section), with the same confirmation. Desktop is unchanged. The flow is now one shared component.
- **Mobile: Stats tab.** The bottom bar's Search tab became **Stats**, which opens Token totals, Fleet energy and Activity (search stays one tap away in the top bar). Those pages left the Sparks menu, and Showcase now sits under Benchmarks, right after Prefill.
- **Mobile navigation feels like iOS.** The active-tab highlight is one pill that slides between tabs on a spring curve, tabs shrink slightly under your finger and the active icon pops, and the Sparks / Stats sheets slide up from the bottom with a fading backdrop and slide back down when closed. All of it is off with reduced motion.
- Health findings also write Activity events when they appear and when they clear (`health.*`).
- **New application shell.** A collapsible sidebar (Overview, Sparks, Benchmarks, Token totals, Fleet energy, Activity, Showcase, Settings) replaces the top tab bar, with a bottom tab bar on phones and a **command palette** (Ctrl/⌘ K) to jump to any Spark, page, action or setting. Ctrl/⌘ B toggles the sidebar, which now slides in and out. The access-token state lives in a small, gentle chip at the bottom of the sidebar instead of a banner. Header links to the sparkDash website ([mia-ai.net](https://mia-ai.net/)) and the [GitHub repository](https://github.com/MiaAI-Lab/sparkDash) are in Settings and the sidebar.
- **Four themes: White, Light, Dark and OLED**, cycled from the theme switch; all colours are design tokens, so every page, chart and card follows the theme.
- **Smooth, Apple-like motion.** Navigating between pages and sections cross-fades through the View Transitions API (with a plain fallback), the sidebar hide/show is animated, and mouse-wheel notches glide instead of jumping (touchpads, Ctrl/Shift scrolling, text selection and number inputs are left alone). Everything respects `prefers-reduced-motion`.
- **Real links throughout.** The logo, every sidebar entry, tab, Spark card and Overview card is a genuine `<a href>`: right-click → Open in new tab / Copy link, middle-click and Ctrl/⌘-click work as in any website, while a plain click still navigates in-app without a reload. Pages have stable URLs (`/tokens`, `/energy`, `/activity`, `/showcase`, `/bench/<type>`, `/spark/<id>`).
- **Overview cards rebuilt.**
  - Each card leads with a model row (name, backend, live decode/prefill tok/s, slots); the decode/prefill graphs were removed because the numbers say it all.
  - **Idle cards offer a launcher**: load or add a model from the card itself, choosing from the models registered on that Spark. While anything on the fleet is still loading, starting another one is blocked with an explanation, so a second launch can't be started by mistake.
  - **Worker cards show their head** (a link to the head Spark) and the model the cluster is serving; the HEAD and WORKER role badges are uppercase.
  - GPU and CPU temperature bars turn red above 80 °C; all cards in a row have equal height.
  - While a prompt is being processed with no rate yet, the card shows a "prefilling" indicator instead of 0.
- **Memory breakdown that reads the same on every card.** The VRAM bar shows two colours only — **Model** (weights plus the KV cache that belongs to the serving engine) and **System** (everything else) — with identical colours on head and worker cards, and no "Free" or "KV" legend items. A worker's bar mirrors its head's model.
- **Tool Eval Bench.**
  - **Trials**: a Trials control (`--trials`) in Simple and Advanced mode.
  - **Compare two results side by side** from the history.
  - **Check for updates** asks GitHub (from the Spark) whether a newer commit exists; the button is **Upgrade now**, and a reinstall is offered when you're already current.
  - A clear green **Upgrade complete / Installation complete** banner shows the version change (old → new).
  - Upgrades work for installs not made by `uv` (falls back to `uv tool install --force`) and the panel closes itself when the job finishes.
  - The page is renamed from "Tool Eval" to **Tool Eval Bench** everywhere.
- **Showcase is a page in the app.** It opens inside the dashboard (sidebar stays), fills the available area, can be run on any Spark with chips, shows a proper empty state with a one-click "Run on <other Spark>" when the chosen Spark has no model, and offers **Open in new window ↗** if you still want a separate window. The look was redone (animated aurora, glass tiles, glowing terminal cards, aggregate sparkline).
- **Much smoother token streaming and auto-opening reasoning.** Streamed text is revealed with a frame-rate catch-up animation (no bursty chunks, no cut surrogate pairs), the caret follows the text, and the reasoning block opens by itself while the model is thinking, then folds when the answer starts.
- **Live prefill tok/s during a long prefill.** Engines that publish prompt totals only when a request finishes (TensorFold) used to show 0 for the whole prefill. The probe now flags `prefillActive`, holds the last measured rate for 20 s so the card doesn't flicker to 0, and the LLM panel and Overview card show "Prefilling…" while it runs. New `prefillActive` field on `metrics.llm[]`.
- **Access-token dialog** — the dashboard asks for the token itself (see below).
- **Quality bench: GSM8K, MMLU and Instruction following replace the JavaScript Code category.** GSM8K (200 problems) and MMLU (285 questions, 5 per subject) are fixed seeded samples of the public test sets (both MIT, bundled under `server/collectors/data/`), so scores track published numbers closely. Instruction following (40 prompts, rules checked by code) is opt-in so existing overall scores stay comparable. Model code is no longer executed, so the Node sandbox runner was removed. Runs saved with a Code score keep their stored data but the category no longer appears.
- **Dedicated pages: Token totals, Fleet energy, Activity** (sidebar). Token totals shows generated / prompt / cached tokens by type, model and Spark over 24 h – all time, with cache-hit rate, period-over-period change, insights and sortable tables (new `/api/llm-token-totals/history`; hourly buckets are kept for 72 h from now on). Fleet energy shows per-node kWh by hour/day, average power, peak, efficiency (Wh per 1,000 tokens), coverage and estimated cost (new Settings fields for electricity price and currency; `/api/fleet-energy/history`). Activity is the full filterable event history with paging (`/api/events?beforeId=`, 2,000 events kept). The Overview cards link to them.
- **Benchmarks section** with one page per benchmark: Decode, Prefill, Quality, and — new — **Tool Eval Bench**, powered by [tool-eval-bench](https://github.com/SeraphimSerapis/tool-eval-bench) run on the Spark. The Tool Eval Bench UI exposes every option of the tool, installs it on request, streams live progress, keeps results and history, and compares runs. Its other modes (throughput, speculative decoding, context pressure, needle, decision model) are under Advanced > all options. The Simple view offers ready runs: regular, regular + Hard mode, short, Hard mode only.
- **Models panel: start and stop your own LLMs from the Spark page.** Register a folder that holds a `start.sh` and a `stop.sh` (per Spark), then Start / Stop it and watch the script's output stream live in the UI (optionally in an expanded view; auto-open is a preference). The start script runs detached on the Spark and logs to `~/.cache/sparkdash/llm/<id>.log`, so closing the browser or restarting sparkDash never stops a model, and the output can be re-attached later. "Running" tracks the script's whole process group. Starting a model while another runs offers "Stop it, then start". Only the registered start/stop script names inside the registered directory are ever executed. Registrations live in `config/llm-launchers.json`.
- **FreeToken LLM backend** — detected from `/v1/models` (`owned_by: FreeToken`), with a `/v1/stats` schema check when the owner is missing. Decode and prefill tok/s are FreeToken's 5-second window (they read 0 when idle). TTFT is the reported mean. `requests.p95_ms` is end-to-end latency, not TTFT p95. KV occupancy is shown when `kv.total_pages` is present. Queue length, slot capacity, and preemptions stay unset.
- **Glance** — README points at the community [`sparkdash-dgx-cluster`](https://github.com/glanceapp/community-widgets/tree/main/widgets/sparkdash-dgx-cluster) widget.
- **The dashboard asks for the access token.** On a server with `SPARKDASH_TOKEN` set, the only way to give the UI the token was typing `localStorage.sparkdashToken = "…"` in devtools and reloading, and a refused WebSocket left the page on "Connecting to live telemetry…" forever. Now any 401, or a live connection that closes before its first snapshot while the server reports the token missing or wrong, opens an **Access token** dialog; the token is checked against the server before it is saved, and the WebSocket reconnects with it immediately. **Settings → Access token** shows Set / Not set with Change and Clear. A new `GET /api/auth/status` (served ahead of the auth middleware) returns `{ tokenRequired, authenticated }` and never the token itself. Installs without a token see no change.
- **KV cache fill for SGLang and TensorFold, and SGLang's memory split.** Each `metrics.llm[]` entry's `kvCacheUsage` (0–1, the share of the engine's KV pool held by requests) was filled only for vLLM and q27. SGLang now reports it from `sglang:token_usage` (or `kv_used_tokens / max_total_num_tokens` on builds without it) and TensorFold 0.6.0 CUDA from `/health` as `1 − pool_free_tokens / pool_tokens` (spark-1: 5%); older vLLM builds that name the gauge `gpu_cache_usage_perc` are read too. Two new fields say where an SGLang engine's memory went: `weightsGb` and `kvCacheGb` from `/server_info` `internal_states[].memory_usage` (RTX PRO 6000: 71.1 GB of weights, 10.7 GB of KV pool), with `sglang:kv_cache_memory_usage_gb` as the pool-size fallback. Both are null on every other backend. The probe reads these from the payloads it already fetches — no extra requests per poll.
- **The VRAM bar shows what holds the memory and how close it is to the limit.** It was one fill coloured by percentage, which misread both kinds of unit: on a GB10 it drew only the GPU's share of the unified pool (spark-1: 98.6 of 121.7 GB, calm) while the CPU side held another 15.8 GB and only 7.2 GB were left, and on the RTX PRO 6000 an idle SGLang engine's pre-allocated KV pool kept it permanently red with 3.2 GB still free. The bar on the Overview cards and the GPU panel is now split by category — **LLM engine** (the largest GPU process while the unit, or a worker's head, has an endpoint online), **System/CPU** (GB10 only), **Other GPU** — over a free track, in category colours that are neither the amber accent nor a warning. Severity moved to the headroom figure in the bar's header ("7.2 GB free"): amber under 8 GB and red under 4 GB of `unifiedMemory.available` on a GB10, amber under 2 GB and red under 1 GB of free VRAM on a discrete GPU; the Available figure next to it follows the same rule. The GPU panel adds a legend line ("Engine 98.6 · System 15.8 · Free 7.2 GB · KV 5%", KV amber from 90%), and hovering or focusing the bar (keyboard included; Escape closes) opens a breakdown with the engine's process and pid, its weights and KV pool size and KV fill where the backend reports them, and a one-line verdict. Multi-GPU hosts get the same bar per card, from that card's processes. On by default — **Settings → Detailed VRAM breakdown** (`showVramBreakdown`) turns it off and restores the previous bar exactly.
- **The LLM panel says when an idle endpoint last served** — while generation and prefill are both zero, a small muted note under Generation tok/s reads "Idle · last served 12m ago" (or just "Idle" when sparkDash has not seen the endpoint serve since it started). The server tracks the last poll with generation or prefill above zero per LLM port and exposes it as `lastActiveAt` (epoch ms, in memory only — null after a restart) on each `metrics.llm[]` entry. The Overview card footer keeps its live `tok/s` / `prefill` figures, zeros included.

### Changed
- **License: Apache 2.0 from this version on.** sparkDash 2.0.0 and later are released under the Apache License 2.0 (`LICENSE`, plus a `NOTICE`). Versions up to 1.9.0 stay under the MIT License, whose text is kept in `LICENSE-MIT`.
- **Credits.** The README Acknowledgements now name the contributors and the projects and data sparkDash builds on (tool-eval-bench and its sources, GSM8K, MMLU, IFEval, Hermes Agent, Geist, Feather), and a new `THIRD_PARTY_NOTICES.md` carries the copyright notices and the SIL OFL text for the fonts that ship in the UI.
- **Settings: the Density option was removed.** Compact is the only layout.
- **Access-token row** in Settings restyled (the "Not set" state is readable, with clear actions).
- **Role badges** (HEAD / WORKER) are uppercase and larger; worker blocks on Overview cards are intentionally quieter than the head's.
- **Local launchers and Tool Eval Bench need a resolvable SSH user.** On a *This host* unit they refuse to run when no valid SSH user can be determined (shared spawn code), instead of guessing.
- **Quality scoring is stricter (scoring version 2).** Runs saved with the previous scorer remain viewable but are not comparable with new runs.
- **Prefill and Showcase fit the context window.** Prompt sizes are clamped to what the model's context can hold (shared `contextFit` helper), and the prefill route passes the context length.
- **Documentation** (README, CODEBASE.md) updated for all of the above.

### Fixed
- **Spark page on phones.** The name sits on its own line with the role / engine / uptime tags underneath, Edit and Shut down are two equal thumb-sized buttons, panels use less side padding, the GPU ring is smaller so the temperature / power / clock stats get room, and the daily-peak axis shows `M tok/s` instead of an unreadable `44552k tok/s`.
- **Mobile tab bar is docked to the bottom edge** instead of floating above it, with a solid background so content no longer shows through.
- **Prefill tok/s showed 0 most of the time.** See *Live prefill tok/s* above; the displayed rate is also now clamped to physically plausible values.
- **Tool Eval Bench: failed or stuck upgrades.** `uv tool upgrade` failed with "not installed" for tools not installed by uv, the "Force reinstall" checkbox had no effect, and the panel sat on "Done. Checking the install…" after success. All three are fixed; results from older runs with omitted-option placeholders reload correctly.
- **Review of the 2.0 features.** A multi-agent review found and fixed issues across the WebSocket error path (a socket error could escape), GPU-history guards on bad input, launcher routes (editing or removing a launcher that is running now answers 409 instead of corrupting state), Showcase/Prefill streaming edge cases, atomic file writes, and several accessibility problems in the Tool Eval Bench tabs and dialogs (focus handling, inert background behind modals, labelled controls).
- **Quality scorers tightened across categories (review of every category).** Arithmetic chain, state tracking, Reasoning and GSM8K now require the last `Answer:` line to be only the answer (`1200.9`, `1200 or 1201`, `1,23` and `3, 77, 4` no longer pass); MMLU needs the letter at the end of a line and case-sensitive (`Answer: a cat`, `A or B` no longer score) and also reads `The answer is (B)` / `**C**`, with a 1,024-token budget; Instruction following fails an empty reply and no longer counts `*`/`***` as words or `-` as `* `; Long-context recall reads `otter: 90471 (was 48213)`, `a: 1, b: 2` on one line, and a closing 'was originally' note correctly, and skips sizes without 20% token headroom. The GSM8K/MMLU samples now ship a `data/NOTICE.md` with their MIT notices. Scores from earlier runs used the old rules and are not directly comparable.
- **Quality · QA scoring no longer passes hedges and look-alikes.** A reply passed if it merely *contained* the accepted answer, so `1391` passed for 391, `391 or 5` passed, `11, 2, 4, 7, 9` passed a sort, `Australia` passed `Au`, and a sign error passed an add/subtract. Each item now has a mode: numbers must end on the answer, dates on the date, sorted lists must end with the list in order, and words must match as a whole word in a short reply. Generated binary prompts are also unique now. The suite seed is unchanged, but QA scores from earlier runs were scored more leniently, so don't compare them directly.
- **DGX Spark Wake button.** GB10 does not wake from a magic packet. Wake and Wake All are only offered for dedicated GPU hosts. A wake request for a Spark unit is rejected.
- **Free VRAM on an idle GPU host.** On a `host` unit with discrete cards, free VRAM was only recomputed as total − used when used was above 0, so a fully idle card reported the machine's free system RAM as free VRAM. Free VRAM is now total − used whenever nvidia-smi reports a total. Spark units (shared pool) are unchanged.
- **A broken remote unit no longer hammers SSH forever** — collectors kept polling a unit the monitor already knew was unreachable, so every domain interval opened another connection that failed authentication: one unit with no key attempted ~233,000 logins a day, indefinitely. Collector polls now pause while a remote unit is offline (local units are exempt — their reads are /proc and /sys), and a credential failure gets four quick retries (5s → 15s → 30s → 60s) before effectively stopping at one attempt every 15 minutes (~96 a day), with the offline snapshot reading "SSH authentication failed — check the key or user for this unit (paused after N attempts — edit the unit to retry now)" so the unit page says what to fix instead of going quiet. Network failures still widen gradually, since a rebooting host comes back on its own; editing the unit resets the retries immediately.
- **CPU temperature stops pretending to be the CPU ([#142](https://github.com/MiaAI-Lab/sparkDash/issues/142))** — both readers took the first plausible sensor they found, without looking at what it was, so on a GB10 (no CPU package sensor at all: seven `acpitz` zones and nothing else) the tile labelled an ACPI/board zone as the CPU, ~15 °C above the GPU die. A real CPU sensor now wins wherever it appears in the list; when there is none the reading is kept but named for what it is — the panel shows `Temperature (ACPI)` with the sensor name in the tooltip, and the metrics carry `temperatureLabel` / `temperatureSource` for anyone reading the API.
- **Editing a This host unit with no LAN IP.** Saving any change from the Edit dialog failed with "lanIp or ssh.host is required", because the edit was checked as if the unit were remote.
- **The SSH user is checked on local units too.** A **This host** unit with no LAN IP skipped the SSH user check (letters, digits, `.`, `_`, `-`), although local Hermes checks put that name in shell commands.
- **Hermes refuses an unsafe SSH user from an older config.** The new check guards the API, but a `sparks.json` saved before it could still hold an SSH user that Hermes splices into its scripts (`/home/<user>/…`), which a local unit runs as root in the host namespace. Hermes now refuses to run anything for such a user and reports `Invalid SSH user` on the unit instead.
- **Saved secrets stay with their host.** Pointing a unit at another host kept its saved SSH password and LLM API keys and sent them there. Changing the SSH host, user or **This host** now drops the password unless the same edit enters it again, and changing the LAN IP, SSH host or **This host** drops the LLM API keys (the benches can reach the LLM through an SSH tunnel).
- **A loopback dashboard refuses other sites and DNS rebinding.** A page from another site open in the same browser could press Wake All or open the live-telemetry socket, and a rebound name could read and change everything. On a loopback bind, `Origin` must now match the request's own `Host`, and `Host` must be one of this machine's names: `localhost`, `*.localhost`, any IP address, its hostname or `<hostname>.local`, or its Tailscale name. Tailscale Serve and the Vite dev server on a LAN IP keep working with no setup; only a custom proxy domain goes in the new `SPARKDASH_ALLOWED_HOSTS`, and a refused browser gets a page naming the host to add. A valid `SPARKDASH_TOKEN` skips the check; non-loopback binds are unchanged.
- **Closing the tab cancels a running Showcase on token-protected installs.** The cancel request sent on `pagehide` / `beforeunload` carried no `Authorization` header, so a server with `SPARKDASH_TOKEN` set rejected it with 401 and the session kept generating after the tab was gone. It now sends the same bearer token as every other API call.
- **Live telemetry with an access token.** The browser's WebSocket passes the token as `?token=` (it cannot set headers), but the upgrade check read it from `req.query`, which a raw upgrade request does not have — so on any install with `SPARKDASH_TOKEN` set, the dashboard's socket was refused even with the right token. The token is now read from the upgrade URL; an `Authorization: Bearer` header keeps working as before.
- **Say plainly when a remote bind is open.** A non-loopback bind without `SPARKDASH_TOKEN` is open by default (`SPARKDASH_ALLOW_OPEN_REMOTE` unset or `1`), but `/api/health` reported it as `authMode: "required-missing"`, the startup log warned that mutations "will fail closed", and the README said the same. None of that was true. Health and preflight now report `authMode: "open-remote"` (keeping `required-missing` for `SPARKDASH_ALLOW_OPEN_REMOTE=0`, which really fails closed), the startup warning says the port is open, the README describes the actual default, and the header shows a dismissible **Open access** chip on such installs explaining that anyone who can reach the address can change settings and power units off until `SPARKDASH_TOKEN` is set. Loopback and token installs see no change.
- **Overview bars say what they measure.** The card's bar labelled `GPU` (or `Temperature` on a unit without a CPU sensor) was the GPU temperature, `CPU` was the CPU temperature, and `Usage` was GPU utilisation; they now read **GPU temp**, **CPU temp** and **GPU util**. The Storage mini-stat on a 1.8 TB disk was cut to `816.4 / 1831.7 …`; each side now carries its own compact unit (`816 GB / 1.8 TB`, `674 GB / 3.7 TB` on a GB10), with the exact figures and percentage on hover. SGLang is spelled **SGLang** (was `sgLang`) on the Overview, the LLM panel badge and the benchmark share card. The LLM panel's **Engine** tile reads a muted `n/a` — hover: "This backend does not report engine sleep state" — on backends such as TensorFold that publish no sleep state, instead of a bare `—` that looked like a failed probe.
- **Fleet Energy history when a Spark joins or leaves.** A membership change still starts a fresh scope (the old totals are not the new fleet's), but the previous `fleet-energy.json` is renamed to `fleet-energy.scope-<savedAt>.json` before the next flush, so up to 31 days of per-minute history is no longer overwritten.
- **Fleet Energy efficiency on fleets with more than one serving node.** Wh/token counted output tokens only when the fleet had exactly one head with one available endpoint, so two clusters, or a cluster plus a standalone node, recorded no tokens and the card read `— Wh/token`. Every available endpoint on a head or standalone node is now its own counter (workers are skipped, so a cluster counts once), and the figure divides only energy recorded since a token source was first seen, so the first day after upgrading does not read high.
- **Byte rates and memory sizes.** A transfer of 1023.95 KiB/s was labeled `1024.0 KB/s`, and 1023.5 MiB of RAM or VRAM was labeled `1024 MB` on the device panels and the Overview card. Both roll into the next unit: `1.0 MB/s` and `1.0 GB`. A 512 MB reading stays `512 MB`.
- **Benchmark duration.** A run of 119.5 seconds was labeled `1m 60s` on the decode dialog, the prefill dialog, and the share card. It now reads `2m 0s`. 59.95 seconds was `60.0 s` and is now `1m 0s`. A 27.8 second run is unchanged.
- **TensorFold slots on CUDA.** A TensorFold 0.6.0 CUDA server with 3 of its 4 streams busy showed `1 / 1` on the LLM card's Slots tile. The tile now reads `streams.max` and `requests_running` from `/health` (or `streams.decoding` + `streams.prefilling` when `requests_running` is missing) and shows `3 / 4`. MLX servers still size it from `max_batch_size`, and a `/health` without these fields keeps the previous `1 / 1`.
- **Two token totals, explained.** The LLM panel's `Total Generated` tile is the engine's own counter and restarts at zero with the engine, while **Total tokens by model** below it is sparkDash's durable ledger — so on spark-1 the tile read 51,950 next to a table saying 200k. The tile is now **Generated (engine)** (hover: "Reported by the engine since it last started"), and the node and fleet tables say they are *Counted by sparkDash since tracking began*. The **Daily peak tok/s** chart drew decode and prefill on one scale, so next to spark-1's ~50k tok/s prefill peaks its ~200 tok/s decode bars were under 0.2 px tall; each series now has its own 14-day scale, and a y-axis names both tops in the series' colours (decode `205 tok/s`, prefill `50k tok/s`). It also gains a tooltip with the date, decode peak and prefill peak of the hovered day, in real tok/s; the chart is focusable and the arrow keys, Home and End step through the 14 days.
- **`npm run dev` listens on loopback.** Vite listened on `0.0.0.0`, so anyone on the LAN could use the whole API through its proxy; it now listens on `127.0.0.1` (use an SSH tunnel from another machine).

---

## [1.8.9] — 2026-09-28

### Added
- **Multi-GPU hosts** — a dedicated GPU host with several NVIDIA cards now reports every card: the header names them all (`NVIDIA GeForce RTX 5080 + RTX 5060 Ti`), the GPU panel adds a block per card, and the API exposes `gpu.gpus[]`. `metrics.gpu` keeps its shape as the all-cards aggregate, so single-GPU units, including every DGX Spark, are unchanged.
- **TensorFold LLM backend** — detected from `/v1/models` (`owned_by: tensorfold`), labeled on the LLM card and Overview. Live tok/s reads cumulative token totals from `/health` when the server publishes them (TensorFold 0.5.0 CUDA does; older or MLX builds show 0 tok/s). Prefill tok/s uses `prefill_seconds_total` when the server sends it. Benches and showcase work as on any OpenAI-compatible server.
- **KV cache pool** — the vLLM tile shows free tokens left in the allocated pool (`cache_config_info` size × usage), with the pool size and memory underneath. Older servers that only expose the usage gauge still show the percent.
- **Cached vs computed prefill in token totals** — the per-model token tables (node LLM panel + fleet Overview card) now split the prompt bucket into three columns: **Cached** (prefix-cache served), **Prefill** (computed = prompt − cached) and **Generated**. The probe exposes a new lifetime `totalCachedTokens` counter: vLLM `vllm:prefix_cache_hits_total` (token-granular), SGLang `total_cached_tokens` from `/server_info` or `sglang:cached_tokens_total{cache_source="device"}` from Prometheus, llama.cpp `n_prompt_tokens_cache` summed across slots, TensorFold `cached_tokens_total` from the CUDA server's `/health` (0.5.0+), and ds4/q27 computed+cached prefill counters (their raw prefill counter is computed-only, so the reported prompt is now the full prompt: computed + cached). EXL3 exposes no split — its cached column stays "—" and prefill equals prompt. The ledger clamps cached ≤ prompt on every credit, so backend backfills never inflate the cached share, and older ledger files upgrade transparently (cached starts at 0; the split begins at deployment, no retroactive history).
- **LLM token totals per model** — sparkDash now keeps a durable ledger of cumulative prompt (prefill) and generated (completion) tokens, attributed to the model the server reported when the tokens were produced, across all supported LLM backends (vLLM, SGLang, ds4-server, q27, EXL3, llama.cpp). The node LLM panel gains a **Total tokens by model** block and Overview can show a fleet-wide **LLM Token Totals** card (Settings → *Show LLM Token Totals*, off by default), each with a time-range picker: All time, Today, Last 7 / 14 days, Last month (per-UTC-day buckets, 35-day retention; ranged views start at deployment — no retroactive history). Probes report the new lifetime `totalPromptTokens` counter alongside `totalOutputTokens` (null when a backend does not expose it). SGLang servers need `--enable-metrics` (or a build whose `/server_info` carries `total_input_tokens` / `total_output_tokens`) for SGLang-side counting to work. Counters accumulate saturatingly at `Number.MAX_SAFE_INTEGER` and survive engine restarts without double counting.
- **Custom prefill size** — type any token count from 256–300k in the prefill benchmark (plus the preset chips).
- **q27 LLM backend** — detect signalnine/q27 via `/v1/models` ownership or `q27_*` Prometheus series; report backend-aware decode/prefill rates and inference-health telemetry.
- **Hide worker nodes** — Settings toggle. Worker-role Sparks drop off Overview cards and the tab bar (the open worker tab stays). Direct URLs and batch Wake / Shutdown / Hermes still include them.
- **On-demand Remote bench** — a **Remote** button next to decode/prefill opens a host + port (HTTPS) field. Paste a Tailscale URL such as `https://name.ts.net/v1/models`; nothing is probed until you run Decode or Prefill against it.
- **Decode / prefill benches on remote Sparks** — if the remote LLM is not reachable on its LAN IP (loopback-only bind), sparkDash opens an SSH local-forward to `127.0.0.1:<port>` for the job. Bench buttons stay on the LLM card even when the live probe shows no model.
- **Benchmark share image** — the decode/prefill **Copy results** button is now a split button: the label copies the text summary as before, and the caret on its right offers **Copy as text** / **Copy as image** on hover or click. The image is a 1200×675-or-taller card drawn in the app's dark palette with the sparkDash mark, the unit, the model, the engine and exposure badges the LLM panel shows (TensorFold, sgLang, vLLM, … plus Open · Local), one row per level and the same legend the dialog shows. On by default (Settings → **Benchmark share image** turns it off, restoring the plain text button); it copies where the page has an image clipboard — HTTPS or localhost — and otherwise downloads the PNG, and says so in the menu rather than pretending.

### Fixed
- **GPU process VRAM on multi-GPU hosts** — the compute-apps cache was keyed by PID, so a process holding memory on two cards (llama.cpp with a layer split) showed only the last card's share. Entries are keyed by PID + GPU uuid and the process list sums a PID across cards.
- **Decode bench “Too many benchmark requests”** — start quota was 6/min stacked with a 2/min cooldown, and failed retries still burned the quota. Starts are now 20/min, cooldown is 3s (double-click only), and 400/409 responses do not count.
- **Decode bench 24×/32× work budget ([#93](https://github.com/MiaAI-Lab/sparkDash/issues/93))** — the post-1.8.6 security cap (131k total tokens) rejected a full concurrency sweep at 2048 max tokens. The cap is 262k so every advertised level fits.
- **Prefill bench still dying at ~5 min** — Node undici aborts streams with no headers/body after 300s. Long prefills now use an Agent with those idle timeouts disabled; the per-size AbortSignal remains the bound.
- **SGLang live Prefill tok/s latching ([#99](https://github.com/MiaAI-Lab/sparkDash/issues/99))** — the poll picked its Prometheus applier from the *displayed* rates, so a non-zero prefill kept selecting the cache-split path (which by design never writes `prefillTps`) and the value could not return to 0. Which applier runs now depends on whether `/server_info` carries `total_*` counters on that poll. The token baseline is also seeded outside the rate window, so the first poll after a restart no longer turns the engine's lifetime prompt counter into a rate.
- **SGLang prefill tok/s split** — with `--enable-metrics` the cached/uncached rows differenced `prompt_tokens_total` as the computed side, so “uncached” double-counted the prefix-cache hits and the hit rate read ~49% where the device truth was ~98%. The tile now reports the prompt tokens taken in during the poll window — cache-served + computed — and the rows below split that total, all from `realtime_tokens_total{mode="prefill_compute"|"prefill_cache"}` (`prefill_effective_tokens_total{mode="input"}` / `cached_tokens_total{cache_source="device"}`, then prompt − cached, as fallbacks). A window that prefilled nothing reads 0 even while unrelated requests are still decoding, instead of holding the previous value.
- **`SPARKDASH_TOKEN` never reached the container ([#86](https://github.com/MiaAI-Lab/sparkDash/pull/86))** — the compose file did not pass it through, so a `BIND_HOST=0.0.0.0` install failed closed no matter what `.env` said. The empty default still reads as "no token".
- **Tailscale addresses classified as public ([#89](https://github.com/MiaAI-Lab/sparkDash/pull/89))** — `100.64.0.0/10`, where a tailnet lives, now reads as LAN on the endpoint-exposure indicator.
- **SGLang served model ID ([#95](https://github.com/MiaAI-Lab/sparkDash/pull/95))** — the panel and the bench requests use the id from `/v1/models` (what the server accepts), keeping the native storage path on `modelPath`.
- **Remote SSH session churn** — collectors reuse an authenticated SSH transport instead of creating a full SSH/PAM login for every metric poll. `SSH_CONTROL_PERSIST_SECONDS=0` restores one connection per command if needed.
- **Shutdown controls ([#90](https://github.com/MiaAI-Lab/sparkDash/issues/90))** — three separate failures on the shutdown path: a local unit in Docker called the host helper from inside the container (no sudo there) instead of entering the host mount namespace; the remote command joined its lines with `;`, so the backgrounded line ended in `&;` and the shell rejected the whole script before running anything; and the authorization probe was `sudo -n true`, which a sudoers rule scoped to the helper does not authorize. The probe is now the helper's own `--check` (see the README contract), with `sudo -n true` kept as a fallback for broader sudo setups. A local unit whose helper or `nsenter` is missing now reports the error instead of logging success.

---

## [1.9.0] — 2026-10-03

### Added
- **Quality bench** — a **Quality** button on the LLM card (and in the **Remote** panel) runs a fixed, deterministic quality suite against whatever the port is serving, so models, quantizations and KV-cache formats can be compared over time. Six categories, all at temperature 0 with a fixed seed and stable item ids: **QA** (150: 30 fixed + 120 generated), **Reasoning** (40 word problems, thinking on), **Arithmetic chain** (40 ten-step chains, thinking on), **State tracking** (40 token-transfer stories, thinking on), **Code** (25 JavaScript functions with hidden tests) and optional **Long-context recall** (8k–256k needle recall with late corrections; stale answers counted). Per-category score, overall score (mean of category %), mean completion tokens and `max_tokens` hits for the thinking categories, and a collapsible per-item table. Model code runs in a separate Node process with an empty environment, a 128 MB heap and a 10 s kill, never in the server.
- **Quality compare** — the last 30 runs per unit are kept with label, model id, settings and per-item pass/fail + reply hash. **Compare with** pairs two runs item by item: both scores, identical replies, only-this / only-other counts and an exact two-sided McNemar p-value, with *difference within noise* when p ≥ 0.05. **Copy results** copies a plain-text summary.
- One quality run per unit at a time; it is mutually exclusive with the decode / prefill benches and the showcase, counts toward the global bench cap, and is finalized as *interrupted* on restart like the other benches. Model id and context length come from the live probe, falling back to `/v1/models`.

Quality bench by Mia's AI Lab.

---

## [1.8.8] — 2026-09-22

### Fixed
- **SGLang overview tok/s stuck at 0** — `generation_tokens_total` on current SGLang builds only moves when a request finishes, so the live rate was 0 for the whole decode and then one spiked poll. Overview now uses `gen_throughput` while a request is running.

---

## [1.8.7] — 2026-09-22

### Changed
- **Decode bench code concurrency** — each concurrent code stream is a different Python task (binary search, LRU, …), starting with its own name so the prompts do not share a prefix. The code warmup is a separate `warmup_noop` prompt, so stream 1 is not a cache hit of the warmup. Concurrency 1 is `binary_search`.

---

## [1.8.6] — 2026-09-01

### Added
- **Prefill benchmark** — sequential context-size sweep (1k–300k) measuring prefill tok/s (`prompt_tokens` ÷ TTFT) and TTFT. Unique prefix per size so prefix-cache does not inflate later runs. Button on the LLM card; persisted last run. Per-size timeout scales with context (90s floor, ~8 ms/token, 45 min cap).
- **DGX Spark CPU temperature** — remote Sparks collect CPU temp over SSH with the same hwmon allowlist as hosts (`acpitz` / `coretemp` / `k10temp` / `zenpower`; NVMe / CX7 filtered out). Overview shows a CPU bar and Spark pages show a CPU row on the GPU panel when the reading is above 0°C.

### Fixed
- **Prefill bench 256k timeout** — per-size cap was 12 minutes (`~3 ms/token`); slow prefills aborted before first token. Now ~8 ms/token with a 45 minute cap, and the error names the limit.
- **Copy results tok/s** — clipboard text now uses one decimal like the decode-bench table (`31.5` not `31`), and TTFT uses the same mean as the table. ([#57](https://github.com/MiaAI-Lab/sparkDash/issues/57))
- **SGLang log spam** — probe current `/server_info` and `/model_info` first; keep the deprecated `/get_*` aliases as fallback so old servers still work. ([#52](https://github.com/MiaAI-Lab/sparkDash/issues/52))

---

## [1.8.5] — 2026-08-28

### Fixed
- **Decode type picker defaults to Structured** — opening the sheet (or loading a previous run) no longer leaves Prose/Code/JSON selected. A still-running job still shows its type.
- **Code workload was prose-speed** — the LRU + "thorough comments" prompt is English with `def` sprinkled in, so DFlash2 accept matched Prose. Code is now `clamp_00`…`clamp_49` identical-shape Python helpers, no comments.

---

## [1.8.4] — 2026-08-28

### Added
- **Decode benchmark type picker** — choose **Structured** (default, count 1→200), **Prose** (lab hash-map explanation), **Code** (fixed LRU-cache Python prompt), or **JSON** (GPU-metrics catalog) before Run. Labels are output types only — no `response_format`, grammars, or guided JSON. Same lab protocol for every type: temp 0, `top_p` 1, thinking off, 32-token warmup, default 400 tokens. The selected type is shown on results and in copied summaries.

---

## [1.8.3] — 2026-08-28

### Changed
- **Decode benchmark uses the lab structured protocol** — count 1→200 (numbers only) instead of the Showcase JSON/YAML catalog + fill-to-max. Temperature **0**, `top_p` **1**, thinking **off**, 32-token warmup, default max tokens **400**. Concurrency 1 is the same prompt as glm-5.3-flash-sm120 `tests/bench_decode.py --structured`; concurrent streams get a unique suffix so they do not share a prefix-cache block.
- **Thinking flags default off** — GLM / Qwen / MiniMax think unless the request disables it. `applyThinkingFlags` now defaults to off and always sends `enable_thinking`, `thinking`, and `thinking_mode`. HTTP 400 retries keep an explicit off payload instead of stripping flags (stripping lets hybrid models think by default). Showcase treats a missing thinking flag as off.

---

## [1.8.2] — 2026-08-23

### Added
- **EXL3 live tok/s** — detect ExLlamaV3 `tools/serve_openai.py` (`owned_by: exl3` or `/health` `{ok, busy}`) instead of mislabeling it as vLLM. Generation and prefill tok/s come from `/health` cumulative token counters (no Prometheus `/metrics`).
- **Tailnet monitoring** — opt-in per unit (`tailscaleMonitoring`, default **off**); `tailscale status --json` on the host and a Tailnet card under Resources. Flags a unit that is healthy on the LAN but off its tailnet. ([#43](https://github.com/MiaAI-Lab/sparkDash/pull/43))
- **NV_ERR_NO_MEMORY on the GPU panel** — count of NVRM `NV_ERR_NO_MEMORY` kernel log lines since boot (shown when > 0). Journal is scanned at most once a minute, not on the 2s poll. Replaces the approach in [#40](https://github.com/MiaAI-Lab/sparkDash/pull/40).

### Security
- **`BIND_HOST` now defaults to `127.0.0.1` (loopback) instead of `0.0.0.0`** — the dashboard is unauthenticated and can SSH into and power off Sparks, so it is no longer reachable on the LAN by default. Set `BIND_HOST` to the host's LAN IP (or `0.0.0.0`) to opt in to remote access. **Migration:** if you access sparkDash from another machine via bare-metal `npm start`, set `BIND_HOST` explicitly. Production and dev Compose both set `BIND_HOST=0.0.0.0` (`network_mode: host`). Startup now also warns when bound to a non-loopback address. ([#35](https://github.com/MiaAI-Lab/sparkDash/pull/35))

### Fixed
- Decode bench `POST /api/sparks/:id/llm/bench` rejects LLM ports that are not in the Spark's configured list (same allowlist as showcase). ([#45](https://github.com/MiaAI-Lab/sparkDash/pull/45))
- **Host CPU temperature** — dedicated GPU hosts (`kind: host`) show CPU temp on the RAM panel and Overview (hidden at 0°C / no sensor). Remote hosts now read hwmon/thermal over SSH. DGX Sparks still do not display CPU temp (remote Sparks still skip the extra sensor SSH). ([#34](https://github.com/MiaAI-Lab/sparkDash/pull/34))

### Changed
- Docker Node base image pulls from `public.ecr.aws/docker/library/node` so Spark builds do not fail on Docker Hub IPv6 `auth.docker.io` / “network is unreachable”. `deploy.sh` prints that workaround if a build still fails.
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
