# sparkDash ⚡ — Multi-unit monitoring dashboard for NVIDIA DGX Spark

<p align="center">
  <img src="https://img.shields.io/badge/platform-arm64-2d9d78?style=flat-square" alt="Platform: ARM64">
  <img src="https://img.shields.io/badge/React-19-58c4dc?style=flat-square&logo=react" alt="React 19">
  <img src="https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express" alt="Express 5">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2d9d78?style=flat-square" alt="Apache License 2.0">
  <br>
  <sub>by <a href="https://x.com/MiaAI_lab">Mia'a AI Lab</a></sub>
  <br><br>
  <a href="https://x.com/MiaAI_lab" target="_blank" style="display:inline-block;margin:0 8px;vertical-align:middle;"><img src="https://img.shields.io/badge/Follow%20me%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow Mia on X" height="28" style="height:28px;width:auto;vertical-align:middle;border:0;" /></a>
</p>

<p align="center"><sub>macOS (darwin) SSH collectors authored by <a href="https://github.com/MikeGibbsOnyx">C. Michael Gibbs</a> and <a href="https://x.com/nyxvoss_ai">Nyx Voss</a> (Onyx AI Labs) — <a href="https://github.com/MikeGibbsOnyx/sparkDash/commits?author=MikeGibbsOnyx">commits</a>. sparkDash by <a href="https://github.com/MiaAI-Lab">Mia's AI Lab</a>.</sub></p>

sparkDash is a real-time web dashboard for one or more **NVIDIA DGX Spark (GB10)** machines in a single browser window. It streams GPU, CPU, unified memory, storage, network, and local LLM metrics — and lets you add, edit, reorder, or remove Sparks from the UI without restarts or code changes.

It also supports **non-Spark units**: any Linux machine with an NVIDIA GPU (e.g. a workstation with a dedicated RTX/L-series card) can be added as a **dedicated GPU host** and monitored the same way via SSH and `nvidia-smi`. For these units the dashboard correctly separates **RAM** (system memory) from **VRAM** (discrete GPU memory).

Monitored units run **Linux**, **macOS**, or **Windows** (a Windows PC with an NVIDIA GPU — or an AMD-iGPU Windows host like a Strix Halo, whose GPU usage comes from Windows' GPU engine counters; see [Windows PCs](#windows-pcs)).

<img src="./.github/screenshot.png" alt="sparkDash Overview page with multiple DGX Spark units, GPU metrics, and LLM status">

### LLM Prompt Showcase

<a href="./.github/llm-showcase.mp4">
  <img src="./.github/llm-showcase.gif" alt="LLM Prompt Showcase — multi-terminal streaming demo (click for MP4)" width="100%">
</a>

<p align="center"><sub><a href="./.github/llm-showcase.mp4">Watch the MP4</a></sub></p>

---

## Table of contents

- [Latest version changelog](#latest-version-changelog)
- [Features](#features)
- [LLM server presets & backend auto-detection](#llm-server-presets--backend-auto-detection)
- [ComfyUI monitoring](#comfyui-monitoring)
- [Hermes Agent monitoring](#hermes-agent-monitoring)
- [Tailnet monitoring](#tailnet-monitoring)
- [Tailscale Serve (HTTPS)](#tailscale-serve-https)
- [Mobile PWA (install on a phone)](#mobile-pwa-install-on-a-phone)
- [Kiosk (wall display)](#kiosk-wall-display)
- [Glance integration](#glance-integration)
- [Quality bench](#quality-bench)
- [Prometheus](#prometheus)
- [Alert notifications](#alert-notifications)
- [RoCE / RDMA monitoring](#roce--rdma-monitoring)
- [Intel Arc GPUs](#intel-arc-gpus)
- [Windows PCs](#windows-pcs)
- [Full changelog](./CHANGELOG.md)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [REST API](#rest-api)
- [Configuration](#configuration)
- [Security](#security)
- [Scripts](#scripts)
- [How it works](#how-it-works)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## Latest version changelog

### Version 2.70.0
- **Decode benchmark**: temperature (default 0.7) and thinking on or off are selectable for every type; the copied result text and the share card show both.
- **NVIDIA Flare** is detected and its tok/s monitored from `/metrics`.
- **Tool Eval Bench**: compare a run on one Spark with a run from another, and expand the scenario list to a taller view.
- **Overview** cards show CPU temperature and power; a **Cost compare** page prices fleet usage as any hosted model; Radiance and Strata engines are recognised.

### Version 2.50.0
- **Tool Eval Bench: Show card** turns a finished result into a share image (score, rating, outcomes, safety warnings, categories) you can copy or save as a PNG.
- **Tool Eval Bench: comparison card**: tick two runs in History and get one image of the change between them.
- **GPU clock cap** can be run on the Spark yourself, or the dashboard asks for the sudo password when a unit has no passwordless sudo.

### Version 2.40.1
- **Temps page** with day and week GPU temperature graphs for every unit, backed by a minute-resolution history kept for 7 days.
- **GPU clock cap** set with `nvidia-smi -lgc` shows on each unit (read-only).
- **Mac units** come online and report CPU, GPU and RAM through macmon.
- **Fixes**: GPU and energy data on remote units whose login shell is zsh, and the TensorFold Slots tile now counts occupied lanes.

### Version 2.40.0
- **Hide any Overview panel**: Settings has switches for Recent activity and for each of the four tiles (Fleet decode, Fleet power, Memory in use, Tokens in last 24 hours), next to Fleet energy and LLM token totals.
- **LM Studio and Ollama** are detected by their own endpoints, so they are no longer labelled SGLang or vLLM; LLM panels match their port, and the Add wizard and LLM panels have LM Studio / Ollama / TensorFold port presets.
- **Windows PCs with an AMD iGPU (Strix Halo)** show GPU use and memory from Windows' GPU counters. Windows setup docs now cover the `administrators_authorized_keys` gotcha.

### Version 2.32.0
- **LLM panel**: an engine that only SSH can reach (a remote unit behind a NAT that forwards just SSH) is now monitored through an SSH forward, with a **via SSH** chip; TensorFold prefill tok/s counts only computed tokens, so prefix-cache hits no longer read as 100k+.
- **Decode benchmark**: live generation tok/s is measured from the run's own streams, so it no longer shows 0.
- **Health**: a finding is held for 90 s, so a reading sitting on a threshold does not flap and spam Activity.
- **iPhone app**: the header clears the status bar and the home-screen icon is the logo. Dropping a Spark after dragging it in the sidebar no longer opens it.

### Version 2.31.0
- **RoCE / RDMA panel** for Sparks: link state and rate, traffic, drops, PFC and QoS settings and the RDMA counters per port, with two health findings (a link went down, packets being dropped). See [RoCE / RDMA monitoring](#roce--rdma-monitoring).
- **Time zone setting** for the Tokens, Energy and Activity charts, so the 24 h charts line up with your local time.
- **`/metrics`** now shows when each collector last returned real data, so a stuck GPU poll can be alerted on while SSH liveness still passes.
- Spark page: Unified memory, CPU and Models share one row; CPU and RAM sit side by side on GPU hosts; the GPU history chart fills its panel; Windows PCs got a first real-hardware pass.

### Version 2.30.0
- **Windows PCs as units**: a Windows PC with an NVIDIA GPU can be monitored over its built-in OpenSSH server (GPU, RAM, CPU load, disks, network, shutdown). See [Windows PCs](#windows-pcs).
- **Mobile app**: sparkDash installs as a PWA over HTTPS (for example Tailscale Serve).
- **Monthly energy history** with a month/year view, **Prometheus `/metrics`** (opt-in), per-GPU graphs on multi-GPU hosts, a model picker in the decode benchmark, per-Spark `llmHost`, and **Restart sparkDash** from the UI after a fleet change.
- The Settings poll interval now really sets the polling rate; the Fleet energy card explains partial coverage.
- Fixes: "Frontend not built" after a Docker upgrade, the SSH tunnel for benchmarks, model launchers inheriting `PORT=5555`, and a token-protected remote bind showing a blank page. Everything since 2.0.0 is in the [CHANGELOG](./CHANGELOG.md).

### Version 2.0.0 — a new sparkDash
- **New shell**: sidebar, command palette (Ctrl/⌘ K), four themes (White, Light, Dark, OLED), smooth page transitions and real links everywhere (right-click, new tab).
- **Rebuilt Overview**: per-Spark cards with the model row, head/worker relations, a Model/System memory bar, and a launcher to load a model from the card.
- **Benchmarks section**: Decode, Prefill, Quality and the new **Tool Eval Bench** (trials, side-by-side compare, one-click upgrade).
- **Showcase** is now an in-app page with much smoother streaming; **Token totals**, **Fleet energy** and **Activity** get their own pages.
- Start and stop your own LLMs from the dashboard; live prefill tok/s during long prefills; Quality bench with GSM8K and MMLU.
- **Health findings** per Spark (hot GPU, low unified memory under 3 GB, Xid/OOM errors, slow links) and Activity events for them; **Clear / Reset** for Activity, Fleet energy and Token totals.
- **Mobile**: docked tab bar with iOS-style motion, a Stats tab (Token totals, Fleet energy, Activity) and a rebuilt Spark page.

Full history: [CHANGELOG.md](./CHANGELOG.md)

---

## Features

| Area | What you get |
|------|----------------|
| **Multi-unit** | Any number of units; each has a tabbed detail page plus a shared Overview |
| **Non-Spark GPU hosts** | Linux boxes with a dedicated NVIDIA GPU are first-class units: same `nvidia-smi` collectors over SSH, detected hardware summary, and separate **RAM** / **VRAM** panels. Detail page: GPU (left) + **RAM → Network → Storage** (right column); Overview cards show RAM and VRAM bars |
| **Windows hosts** | Windows machines with an AMD iGPU (Strix Halo and friends) are first-class units too: agentless PowerShell over OpenSSH, CPU/RAM/disks/network collectors, and GPU usage straight from the engine performance counters (reads like Task Manager). The Add/Edit wizard has a **Strix Halo / Windows host** unit type |
| **Live streaming** | WebSocket metrics with configurable poll intervals; central history store for sparklines across tab switches |
| **Local + remote** | Host metrics via sysfs/proc/`nvidia-smi`; remotes over SSH (key or password) |
| **LLM probe** | Auto-detects llama.cpp, vLLM, sglang, LM Studio, Ollama, ds4-server, EXL3, TensorFold, FreeToken, Strata, q27, NVIDIA Flare, Locals, or Splash; live decode/prefill tok/s from the engine's own counters where it publishes them (not LM Studio or Ollama); cached vs uncached prefill on ds4, llama.cpp, SGLang, and q27; **daily peak** history on the LLM card |
| **LLM server presets** | One-click **LM Studio :1234** / **Ollama :11434** / **TensorFold :8888** presets in the Add wizard's LLM-ports step, the "+ Add LLM port" panel, and each LLM panel's settings (they fill the port number — they install nothing) |
| **ComfyUI** | Opt-in probe: queue/jobs, progress, cancel, Open link, inventory, overview chip |
| **Hermes Agent** | Opt-in per unit: background update check (10 min), status badges, one-click or batch `hermes update` |
| **Tailnet** | Opt-in probe: flags a unit that is healthy on the LAN but off its tailnet |
| **Decode benchmark** | Multi-concurrency streaming decode tok/s; type picker (Structured / Prose / Code / JSON). Code is a different Python task per stream. Temperature (default 0.7) and thinking on/off (default on) are selectable; persisted last run. **Start context** (16k to 256k or a custom size) prefills every stream to that depth first, then measures decode from there; it needs prefix caching, and a wave whose context was recomputed is flagged instead of reported as clean. Remote units: LAN HTTP, or SSH tunnel to loopback. **Remote** button for an on-demand HTTPS/host:port target |
| **Prefill benchmark** | Context-size sweep (1k–300k) of prefill tok/s and TTFT; unique prefix per size; persisted last run. Same remote targeting as decode |
| **Quality benchmark** | Fixed, seeded quality suite (QA, reasoning, arithmetic, state tracking, GSM8K, MMLU, plus optional instruction following and long-context recall) at temperature 0; per-category and overall score; last 30 runs kept; paired compare with McNemar p-value. Same remote targeting as decode |
| **Prompt Showcase** | Full-page multi-terminal LLM streaming demo (up to 32 prompts) with live tok/s and copy-out |
| **Kiosk** | `/kiosk`: a full-screen wall display with no menus — fleet totals, a large-type card per unit with a 30-minute trace, and the active alerts, on one screen (see [Kiosk](#kiosk-wall-display)) |
| **LLM inference health** | KV cache free/pool (vLLM `cache_config_info` token and byte size; usage % when the pool size is absent), run/wait queue, TTFT/E2E/ITL p95, preemptions, prefix cache, MTP accept from Prometheus `/metrics` (vLLM and q27; q27 FIFO-queues so the Requests tile reads “N run” without a wait gauge) |
| **Multiple LLM ports** | Monitor several LLM servers on different ports simultaneously — each gets its own panel with independent backend detection and metrics |
| **GPU processes** | See the top GPU processes by VRAM usage directly in the GPU panel, including process name and memory allocation |
| **Multi-GPU hosts** | A dedicated GPU host with several NVIDIA cards reports each one: the header names every card, the GPU panel adds a block per card (throttle chip, usage and temperature sparklines, power, VRAM bar) and the API exposes `gpu.gpus[]`. The headline `gpu` numbers stay an aggregate of all cards, so Overview cards and alerts need no change |
| **Spark uptime** | System uptime displayed inline on each Spark header for at-a-glance availability |
| **Power controls** | Graceful shutdown (SSH host script). Wake-on-LAN is for dedicated GPU hosts whose NIC supports it. DGX Spark does not wake from a magic packet |
| **Spark roles** | **Head** / **Worker** / **Standalone** — worker label + head link; standalone can disable LLM monitoring; optional hide workers from Overview and tabs |
| **Unified memory** | GB10 128 GB LPDDR5X pool (~273 GB/s), GPU/CPU split, bandwidth via `nvidia-smi dmon`. Non-Spark hosts show discrete **VRAM** (nvidia-smi) and system **RAM** separately |
| **Health findings** | Small explainable rules over metrics already collected: GPU running hot (85 / 90 °C), GPU stuck in a low-power state, unified memory low (under 3 GB warns, under 1.5 GB critical), NVIDIA **Xid** errors and kernel **OOM kills**, several models loaded while memory is busy, a link slower than 1 Gb/s, and RoCE link / loss. Shown as chips on the cards and in full on the unit page; changes are logged to **Activity** |
| **Fleet pages** | **Token totals** (per model, hourly / daily history), **Fleet energy** (rolling 24 h / 31 d plus a permanent monthly archive, optional cost), and **Activity** (event log with filters). Each page can be cleared or reset from its **Clear / Reset…** menu |
| **RoCE / RDMA** | Per-port link state and rate, traffic, drops, PFC and QoS (trust mode, DSCP), and RDMA counters, read from sysfs / ethtool / `mlnx_qos` on the Spark (see [RoCE / RDMA monitoring](#roce--rdma-monitoring)) |
| **Windows PCs** | A Windows PC with an NVIDIA GPU is a first-class unit over the built-in OpenSSH server; an AMD-iGPU Windows host (Strix Halo) works too — its GPU usage comes from Windows' GPU engine counters (see [Windows PCs](#windows-pcs)) |
| **Mobile + PWA** | A phone layout with a docked tab bar (Overview, Sparks, Stats, Settings); installable to the home screen over HTTPS (see [Mobile PWA](#mobile-pwa-install-on-a-phone)) |
| **Time zone** | **Settings → Time zone** sets hour and day boundaries and labels on the Tokens, Energy and Activity charts, whatever device you view them on |
| **Prometheus** | Opt-in `GET /metrics` export (see [Prometheus](#prometheus)) |
| **Metrics history** | Opt-in (**Settings → Metrics history**): 48 h of 1-minute and 30 days of 15-minute avg/max per unit — GPU, memory headroom, CPU, RAM, network, LLM tok/s and KV fill — kept by the server across reloads and restarts and charted in a History panel on the unit page (1h–30d, shared crosshair). The 8 h GPU chart and 7-day Temps history are always on |
| **Restart from the UI** | When the fleet changes and Energy needs a restart, a **Restart sparkDash** button restarts the Docker container (only offered when it can) |
| **Themes** | Dark, light, cool white, OLED — neutral palettes, persisted in `localStorage` |
| **Secrets** | SSH passwords AES-256-GCM encrypted; never in `sparks.json` or API responses |
| **Docker-first** | Single privileged container for host metrics; prod and dev Compose files |
| **Hot config** | Add / edit / remove / reorder Sparks from the UI with no process restart |

---

## ComfyUI monitoring

sparkDash can **optionally** monitor a [ComfyUI](https://github.com/comfyanonymous/ComfyUI) instance on each Spark — the same way it probes local LLMs, but focused on **jobs and queue**, not a second copy of GPU/RAM bars (those stay on the GPU / CPU panels).

### What is supported

| Capability | Details |
|------------|---------|
| **Opt-in per Spark** | `comfyMonitoring` (default **off**) + `comfyPort` (default **8188**) |
| **Any role** | Head, worker, and standalone can enable ComfyUI independently of LLM cluster role |
| **Liveness** | `GET /system_stats` — online, ComfyUI / PyTorch version, device type (cpu/cuda) |
| **Queue / jobs** | `GET /queue` — running + pending items; workflow **title**, **model/LoRA** filenames from the graph, footprint (**resolution · steps · sampler · batch · node count**) |
| **Progress** | Progress bar on the active job — Comfy WebSocket when events are available; otherwise elapsed / average-duration **estimate** |
| **Last finished job** | Status + duration via `/api/jobs` (fallback `/history`) |
| **Queue ETA** | Estimate from recent job durations × pending (+ progress remainder when known) |
| **Cancel / remove** | From the Comfy card: interrupt a running job or dequeue a pending one (`POST /api/sparks/:id/comfy/cancel`) |
| **Open ComfyUI** | One-click link to `http://{lanIp}:{comfyPort}` (LAN IP preferred so remote browsers do not hit localhost) |
| **Model inventory** | Checkpoints + LoRAs from `/models/*` (UI section only when at least one file is listed) |
| **Overview chip** | When monitoring is on: `Comfy · idle` / `run` / `Nq` / muted if unreachable |
| **Layout** | Under **Services**: primary LLM + Comfy side-by-side when both are enabled; collapsible **Resources** / **Services** sections |

**Not claimed:** true per-job VRAM (Comfy does not expose that cleanly over HTTP). Host GPU/VRAM remains on the GPU panel. Live step progress depends on Comfy broadcasting WS events; stock Comfy often scopes detailed progress to the client that submitted the prompt.

### How to enable (per Spark)

1. Open the Spark tab → **Edit** (pencil).
2. Enable **ComfyUI monitoring**.
3. Set **port** if needed (default **8188**).
4. **Save**.

The Spark page **Services** section shows the ComfyUI card. On Overview, a small Comfy chip appears for that unit.

**Connectivity Test** (in Edit) includes ComfyUI when monitoring is enabled.

### ComfyUI side requirements

- ComfyUI must be reachable from the **sparkDash server** on the probe host:
  - **Local Spark** (`isLocal`): sparkDash probes `127.0.0.1:{port}` (use Docker `network_mode: host` if the dashboard runs in a container).
  - **Remote Spark**: probe uses the Spark **LAN IP** (same as LLM probes).
- For **Open** from another machine’s browser, Comfy should listen on a reachable interface (e.g. `--listen 0.0.0.0`), not only loopback, and the Spark’s **LAN IP** must be set correctly in Edit.

### Config fields (persisted on the Spark)

| Field | Default | Description |
|-------|---------|-------------|
| `comfyMonitoring` | `false` | Probe ComfyUI and show the card / overview chip |
| `comfyPort` | `8188` | ComfyUI HTTP port |

### Related API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/sparks/:id/comfy/cancel` | Cancel a job (`{ "promptId": "<uuid>" }`) — interrupt running and/or remove from queue |

Env (optional): `COMFY_PORT` (default `8188`), `COMFY_PROBE_TIMEOUT_MS`, `POLL_INTERVAL_COMFY`.

---

## Hermes Agent monitoring

sparkDash can **optionally** monitor [Hermes Agent](https://github.com/nousresearch/hermes-agent) (nousresearch/hermes-agent) on each unit and run one-click updates for you over SSH.

### What is supported

| Capability | Details |
|------------|---------|
| **Opt-in per Spark** | `hermesMonitoring` (default **off**) in **Edit Spark** |
| **Auto update check** | Background `hermes update --check` over SSH (default every 10 min) — returns update availability + pending commits |
| **Status badges** | In the Spark header: `Hermes` (installed version), `Hermes not found` if the binary is missing |
| **One-click update** | **Update Hermes** button opens a dialog with live status, real pending commits, and release notes; **Update now** runs `hermes update` via SSH (non-interactive go) |
| **Update state** | Running / success / error surfaced live (button turns into a “Hermes updating… / failed” state) |
| **Batch update** | **Update Hermes** on Overview runs `hermes update` on every monitored unit, with a live per-unit progress bar |

### How to enable (per Spark)

1. Open the Spark tab → **Edit** (pencil).
2. Enable **Hermes Agent**.
3. **Save** — background checks start immediately.

The **Update Hermes** button appears in the Spark header/mobile action row; it turns warning-yellow with a commit-count badge only when an update is actually available. It also appears on Overview (batch) when at least one unit has Hermes enabled.

**Connectivity check note:** local units run the check as the **host user** (via `setpriv`/`nsenter`, never as container root); remote units run it over SSH. Either way, the logged-in user needs permission to read the Hermes repo.

### Side requirements

- **Hermes Agent must be installed on the target machine** — sparkDash only checks & updates; it does not install it. The binary is looked up in `~/.local/bin` and `/usr/local/bin`.
- SSH user must be able to run `hermes update --check` / `hermes update` non-interactively (key auth recommended).
- An update can take a few minutes (repo pull + dependency reinstall); a stale `*.lock` file from a crashed run is cleared before each attempt.

### Config fields (persisted on the Spark)

| Field | Default | Description |
|-------|---------|-------------|
| `hermesMonitoring` | `false` | Check/update Hermes Agent on this machine |

### Related API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/sparks/hermes/update-all` | Batch `hermes update` on every monitored Spark (Overview button) |
| POST | `/api/sparks/:id/hermes/check` | Force `hermes update --check` now |
| POST | `/api/sparks/:id/hermes/update` | Run `hermes update` in the background (202) |
| GET | `/api/sparks/:id/hermes/updates` | Update preview: latest release + installed version + real pending commits + resolved view |

Env (optional): `POLL_INTERVAL_HERMES` (default `600000` ms), `HERMES_UPDATE_TIMEOUT_MS` (default `600000` ms).

---

## Tailnet monitoring

Opt-in per unit (default **off**). Runs `tailscale status --json` on the host and shows a **Tailnet** card under Resources.

This closes a blind spot every LAN-based check shares, including sparkDash's own SSH liveness. When `tailscaled` loses its session with the coordination server, SSH/GPU/LLM can all stay healthy while the box is unreachable from off-LAN.

### What is supported

| Capability | Details |
|------------|---------|
| **Opt-in per unit** | `tailscaleMonitoring` (default **off**) in **Edit Spark** |
| **Off-tailnet detection** | `Self.Online` — the node's *own* view of the coordination server |
| **Reason, not just state** | Tailscale `Health` messages, backend state, tailnet IP, DERP relay, version, expired-key warning |

Asked of **each node about itself**. Peer state is never the verdict. The probe is read-only (`tailscale up` / `down` / `login` are never run).

### How to enable

1. Open **Edit Spark**.
2. Tick **Tailnet monitoring**.
3. Save. The Tailnet card appears under Resources.

### Host requirements

- `tailscale` CLI on the monitored host, and `tailscaled` running.
- Remote units: existing SSH. Local Docker: `nsenter` into the host mount namespace (same as `nvidia-smi`; `/host/proc` is already bind-mounted).

### Config fields

| Field | Default | Description |
|-------|---------|-------------|
| `tailscaleMonitoring` | `false` | Run `tailscale status --json` and show the Tailnet card |

Env (optional): `POLL_INTERVAL_TAILSCALE` (default `30000`), `TAILSCALE_PROBE_TIMEOUT_MS` (default `8000`).

---

## Tailscale Serve (HTTPS)

Tailscale Serve publishes the loopback-only dashboard over HTTPS to your tailnet — no ports opened, no reverse proxy, and a real certificate (`https://<node>.<tailnet>.ts.net`). It is also the easiest way to satisfy the HTTPS requirement for the [Mobile PWA](#mobile-pwa-install-on-a-phone), which browsers refuse to install over plain HTTP.

### One-time setup

1. **Enable HTTPS certificates and Serve for the tailnet** (admin does this once):
   open the approval link Tailscale prints on first use, or in the admin console enable
   **HTTPS** (MagicDNS → HTTPS Certificates) and **Tailscale Serve**.
2. On the sparkDash host, publish the dashboard (the dashboard must be running — Docker or `npm start`):

   ```bash
   sudo tailscale serve --bg --https=443 http://127.0.0.1:5555
   ```

   If the container binds a specific address instead of loopback, proxy that address
   (check `docker logs sparkDash` for the `bind=` line), e.g.
   `sudo tailscale serve --bg --https=443 http://100.x.y.z:5555`.
3. Verify and get your URL:

   ```bash
   tailscale serve status
   # https://your-node.your-tailnet.ts.net  ->  proxy http://127.0.0.1:5555
   ```

Notes:

- The Tailscale hostname works with the default loopback bind — no `SPARKDASH_ALLOWED_HOSTS` entry needed (that list is only for custom reverse-proxy domains).
- Access is **tailnet-only**. Any device signed in to the tailnet (phone, laptop) can open the URL; nobody else can. For public exposure use `tailscale funnel` and an authenticated front door (see [Remote access](./docs/REMOTE-ACCESS.md)) — but prefer keeping it tailnet-only.
- The proxy forwards `/api/*` and `/ws` including WebSocket upgrades; nothing else to configure.
- To remove it later: `sudo tailscale serve --https=443 off`.
- Snap installs run Tailscale as root; if the plain command reports *Access denied*, use `sudo tailscale serve …`.

---

## Mobile PWA (install on a phone)

sparkDash is a **PWA**: from a supported browser it installs to the home screen and runs fullscreen like a native app, with its own icon and no browser chrome.

### What ships

| File | Purpose |
|------|---------|
| `public/manifest.webmanifest` | App name, `standalone` display, theme/background colors (`#0a0c0f`), icons |
| `public/icons/` | 192/512 px icons, `maskable` variants (Android adaptive icons), `apple-touch-icon.png` |
| `public/sw.js` | Service worker: caches the app shell; **never** caches `/api/*` or `/ws` (live data always comes from the network) |
| `src/components/shell/InstallPrompt.tsx` | In-app install banner (see below) |

### Requirements

- **HTTPS** is mandatory for install (or `localhost` for local testing). Use [Tailscale Serve](#tailscale-serve-https) or an authenticated TLS reverse proxy — a plain `http://<lan-ip>:5555` page cannot be installed.
- The manifest and icons are static files served by the same Express server (`dist/` after `npm run build`); no extra configuration.

### Installing

The app shows its own banner when opened in a browser it can be installed from (hidden once installed, or after dismissing):

- **Android / desktop Chrome:** an **Install** banner appears near the bottom of the page; tapping it opens the native confirm dialog. Also available in the ⋮ menu → *Install app* / *Add to Home screen*.
- **iPhone / iPad (Safari):** iOS allows no programmatic prompt; the app shows a one-time hint, then: **Share ⬆︎ → Add to Home Screen → Add**.
- The banner only appears on a fresh page load — reload once if you don't see it.

After installing, the icon sits on the home screen and the dashboard opens fullscreen with live data whenever the device can reach the server (on the tailnet, with Tailscale connected).

### Updating the installed app

Service worker caching: hashed `assets/*` are cache-first (immutable), `index.html` and `/` are network-first with a cache fallback. After deploying a new build, the installed app picks it up on the next open; no manual cache clearing is needed. If you ever need to force it, bump the `CACHE` version in `public/sw.js`.

---

## Kiosk (wall display)

Open **`/kiosk`** (sidebar → **Kiosk**, or **Kiosk** in the command palette) on a TV or a spare monitor. It has no menus and shows up to six units on one screen in at least two rows (3 × 2 on a 16:9 wall), in whichever column count gives the largest cards; each card sizes its type from its share of the screen, so it reads from across a room on a 720p TV or a 4K wall. A larger fleet keeps that card size and scrolls under the header, snapping a whole row at a time.

- **Header:** fleet decode tok/s with its 30-minute trace, GPU power, the hottest GPU, queued requests, energy and output tokens over the last 24 hours (from Fleet energy; marked *est.* when estimated), units online, and the clock in the configured time zone.
- **A card per unit in large type:** name, role (a worker's names its head), the served model with its context (in a pill on the name line) and IP; memory split as on the Overview (model / system / other, with the space free, and system RAM on a host with a discrete card; a Mac, whose GPU shares the system's memory, shows its unified pool, how much of it is in use and what the system has available); GPU use, temperature and power, CPU use and temperature, free space on the root disk, and live decode and prefill tok/s in one block of figures; and a 30-minute trace of GPU and CPU use and generation / prefill tok/s, drawn as smooth curves that never overshoot a sample, that takes the rest of the card. The figures come from the same code as the Overview card; its smaller extras (per-stream rates, slots, power limits, CPU power, storage used / total, chips and the model launcher) stay on the Overview.
- **Alerts:** a band at the bottom lists the same alerts as the Overview (the server's firing set while alert notifications are on), and is hidden when there are none.

Traces come from **Settings → Metrics history** (one-minute averages, refreshed every minute), so a reloaded wall shows the last half hour at once; with history off they start from what the browser has collected. The wall never dims or flashes for a slow or failed update: it keeps its last good frame and the clock shows how old it is. The page keeps the screen awake where the browser supports it (Screen Wake Lock), hides the cursor after three seconds, and **Esc** returns to the dashboard. **Settings → Hide workers** and **Show VRAM breakdown** apply here too. Below 760 px wide (a phone) the cards stack and scroll.

URL flags choose the layout without touching settings:

| Flag | Effect |
|------|--------|
| `?fit=scroll` | Cards of a fixed 3:2 shape that scroll, instead of fitting one screen (`shrink`, the default) |
| `?cols=N` | A fixed number of columns (1–8) instead of the layout that gives the largest cards |
| `?theme=oled` | A theme for this screen only (`white`, `light`, `dark`, `oled`); it is not saved |

## Glance integration

[Glance](https://github.com/glanceapp/glance) can show the cluster on a self-hosted dashboard with the community widget [`sparkdash-dgx-cluster`](https://github.com/glanceapp/community-widgets/tree/main/widgets/sparkdash-dgx-cluster) (contributed by [@linxichen](https://github.com/linxichen)). One `custom-api` card renders GPU temperature and usage, VRAM, generation tok/s, KV-cache usage, and uptime for a head node plus one worker, reading `/api/sparks/:id/metrics` directly:

```yaml
- type: custom-api
  title: sparkDash · DGX Cluster
  cache: 30s
  url: ${SPARKDASH_HEAD_URL}
  subrequests:
    node2:
      url: ${SPARKDASH_NODE2_URL}
  options:
    dashboardUrl: ${SPARKDASH_DASHBOARD_URL}
  template: |
    # paste the template from the widget's README
```

| Variable | Value |
|----------|-------|
| `SPARKDASH_HEAD_URL` | Metrics URL of one unit — `https://sparkdash.example.com/api/sparks/<id>/metrics` |
| `SPARKDASH_NODE2_URL` | Metrics URL of a second unit. For a single Spark, drop the `subrequests` map and the widget's second node block |
| `SPARKDASH_DASHBOARD_URL` | Dashboard base URL, used for the card's title link |

`/api/sparks/:id/metrics` is unauthenticated on loopback, the same as the rest of the dashboard. Read [Security](#security) before exposing it beyond a trusted network.

---

## Quality bench

The **Quality** button on the LLM card scores whatever model the port is serving on a fixed suite, so you can compare models, quantizations and KV-cache formats over time. Every item comes from a seeded PRNG and has a stable id: two runs are the same questions, paired item by item.

Every request is an OpenAI chat completion at temperature 0 with a fixed `seed`. Thinking is switched with the same flags the other benches use.

| Category | Items | Thinking | max_tokens | Scored by |
|----------|-------|----------|------------|-----------|
| **QA** | 150 (30 fixed + 120 generated: multiplication, add/subtract, string reversal, letter counts, sorting, binary, date offsets, LCM) | off | ≥ 64 | Accepted answer as a case-insensitive substring; counts, binary and LCM must be the last integer in the reply |
| **Reasoning** | 40 multi-step word problems | on | 8192 | Last `Answer: <jar>, <per box>` line in the final answer (not the reasoning) |
| **Arithmetic chain** | 40 ten-step chains (multiply, add, subtract, remainder, floor divide) | on | 12288 | Last `Answer: <number>` (markdown and thousands commas allowed) |
| **State tracking** | 40 token-transfer stories, 5 people, 25 events | on | 12288 | Last `Answer: <number>` |
| **GSM8K** | 200 grade-school maths problems, a fixed seeded sample of the public GSM8K test set (MIT) | on | 8192 | Last `Answer: <number>` (`$`, markdown and thousands commas allowed) |
| **MMLU** | 285 multiple-choice questions, 5 per subject across all 57 MMLU subjects, a fixed seeded sample of the public test set (MIT) | off | 512 | Last `Answer: <letter>` (or a bare letter) |
| **Instruction following** | 40 prompts with 2–4 verifiable formatting rules (case, length, bullets, paragraphs, keywords, endings…) | off | 1024 | Each rule is checked by code; an item passes only when every rule holds. Off by default so older overall scores stay comparable |
| **Long-context recall** | Items per size (default 2) at 8k–256k (default 32k, off by default) | off | 512 | 16 animal codes spread through filler text; 4 are corrected near the end. Passes when all 16 latest codes come back; overwritten codes are counted as *stale* |

The overall score is the mean of the category percentages. Long sizes that do not fit the model context (from the live probe or `/v1/models`) are skipped and listed.

The dialog shows live progress, the per-category table (mean completion tokens and how many replies hit `max_tokens` for the thinking categories, keys found and stale answers for long recall), and a collapsible per-item table with reply excerpts. Pick an earlier run under **Compare with** to see both scores, how many replies were identical, how many items only one run got right, and the exact two-sided McNemar p-value. When p ≥ 0.05 the row reads *difference within noise*. **Copy results** copies a plain-text summary.

The last 30 runs per unit are kept in `config/quality-bench-history.json`, with the label, model id, settings, and per-item pass/fail and reply hash. A run can be removed on its own — **Delete** in the history table of the Quality bench page, or **Delete run** in the dialog's footer — without touching the other runs or the other ports' history; a run still in flight is refused, so cancel it first. One quality run per unit at a time; it cannot overlap a decode or prefill bench or a showcase. A full default run is about 755 requests, and the thinking categories can take a while on slow models.

<sub>Quality bench by Mia's AI Lab.</sub>

---

## Prometheus

Opt-in (default **off**). **Settings → Prometheus metrics** serves every unit's metrics at `GET /metrics` in the Prometheus text format (0.0.4), so Prometheus, VictoriaMetrics or Grafana Agent can scrape sparkDash and keep history beyond what the dashboard shows. While the setting is off the path answers `404`.

`/metrics` goes through the same auth as the REST API: open on a loopback install, and on a remote bind with `SPARKDASH_TOKEN` set it needs the token as a bearer header.

```yaml
scrape_configs:
  - job_name: sparkdash
    scrape_interval: 15s
    static_configs:
      - targets: ["sparkdash.lan:5555"]
    # Only when SPARKDASH_TOKEN is set on a non-loopback bind:
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/sparkdash.token
```

The exporter reads the snapshot sparkDash already holds, so scraping adds no SSH or nvidia-smi calls; values are as fresh as the poll interval. Names follow node_exporter / DCGM-exporter practice: base units (bytes, seconds, °C, watts, 0–1 ratios), `_total` only on counters. Every series carries `unit` (the unit id), `unit_name`, `kind` (`spark` / `host`) and `role` (`head` / `worker` / `standalone`). Memory and disk sizes are collected in MiB and converted to bytes.

| Family | Type | Extra labels | Notes |
|--------|------|--------------|-------|
| `sparkdash_up` | gauge | | 1 when the unit answered its last liveness check. An unreachable unit exports `sparkdash_up 0` and nothing else |
| `sparkdash_uptime_seconds` | gauge | | Host uptime |
| `sparkdash_collector_last_success_timestamp_seconds` | gauge | `collector` | Unix time of the last poll of each collector (`gpu`, `cpu`, `ram`, `memory`, `network`, `storage`, `llm`, `roce`) that returned real data, not zeroed defaults. A stuck collector stops advancing while `sparkdash_up` stays 1, so alert on `time() - sparkdash_collector_last_success_timestamp_seconds > 60`. Absent until a collector has succeeded |
| `sparkdash_gpu_info` | gauge | `gpu`, `name`, `uuid` | Always 1. `gpu` is the nvidia-smi index for an NVIDIA card; an AMD card (amd-smi) is its index plus 1000, so `gpu="1000"` is the first AMD card. Per-card chart history uses the same number (`gpu.1000.*`) |
| `sparkdash_gpu_utilization_ratio` | gauge | `gpu` | 0–1 |
| `sparkdash_gpu_temperature_celsius` | gauge | `gpu` | |
| `sparkdash_gpu_power_watts`, `sparkdash_gpu_power_limit_watts` | gauge | `gpu` | |
| `sparkdash_gpu_memory_used_bytes`, `sparkdash_gpu_memory_total_bytes` | gauge | `gpu` | GB10: the GPU's share of / the whole unified pool |
| `sparkdash_gpu_throttled` | gauge | `gpu`, `reason` | 1 while clocks are limited for `thermal`, `power` or `hw` |
| `sparkdash_memory_available_bytes` | gauge | | Headroom for GPU work: unified-pool `MemAvailable` on a GB10, free VRAM on a discrete GPU |
| `sparkdash_cpu_utilization_ratio` | gauge | | 0–1 |
| `sparkdash_cpu_temperature_celsius` | gauge | `sensor` | A GB10 has no CPU package sensor; `sensor="acpitz"` says it is a board zone |
| `sparkdash_ram_used_bytes`, `sparkdash_ram_total_bytes` | gauge | | |
| `sparkdash_network_receive_bytes_per_second`, `…_transmit_bytes_per_second` | gauge | `interface` | Interfaces hidden in sparkDash are skipped |
| `sparkdash_disk_used_bytes`, `…_available_bytes`, `…_total_bytes` | gauge | `mount`, `device` | Devices hidden in sparkDash are skipped |
| `sparkdash_llm_up` | gauge | `port`, `backend`, `model` | One per LLM endpoint (head and standalone units) |
| `sparkdash_llm_measurement_valid` | gauge | `port`, `backend`, `model` | 1 when the endpoint's stats were read on the last poll, 0 when it answered but they could not be read (the rate and counter series are then omitted) |
| `sparkdash_llm_generation_tokens_per_second`, `sparkdash_llm_prefill_tokens_per_second` | gauge | `port`, `backend`, `model` | |
| `sparkdash_llm_kv_cache_usage_ratio` | gauge | `port`, `backend`, `model` | Where the backend reports it |
| `sparkdash_llm_requests_running`, `sparkdash_llm_requests_waiting` | gauge | `port`, `backend`, `model` | Where the backend reports it |
| `sparkdash_llm_generated_tokens_total`, `sparkdash_llm_prompt_tokens_total`, `sparkdash_llm_cached_prompt_tokens_total` | counter | `port`, `backend`, `model` | The engine's own lifetime counters — they reset when the engine restarts, which `rate()` handles |

Unknown is left out rather than written as zero: a failed GPU read, a sensor that does not exist, or a field the LLM backend does not publish produces no sample.

---

## Alert notifications

Opt-in (default **off**): **Settings → Alert notifications → Configure…**. The server sends a notification to ntfy, Discord, Slack or a JSON webhook when a problem has held for a while, and again when it clears — whether or not a dashboard is open.

### What notifies

Nothing new is detected here. The conditions are the ones sparkDash already shows, with their own thresholds:

- the **Health findings** on the unit cards (`server/health/HealthEvaluator.js`: GPU temperature, unified memory, stuck low-power state, Xid / OOM, RoCE link and loss, slow link, several models loaded), and
- the **Overview exceptions** (`src/shared/fleetExceptions.js`, the strip's own code): unit offline, thermal or hardware throttle (never the software power cap), storage at or above 90 %, LLM unavailable, tailnet unavailable.

Each can be switched off, and given its own wait. Timing works like Prometheus: a condition has to hold for its wait before it fires (until then it is *pending*), and a firing alert clears only after the condition has stayed clear for the same wait (at least 30 s), so a reading hovering on a threshold does not notify on every crossing. An offline unit keeps its other alerts as they are instead of clearing them. The firing set is saved, so a restart neither repeats a notification nor resets a duration.

The Activity log keeps recording what happened, as before; on top, every notification sent or failed is an `alert.notify.sent` / `alert.notify.failed` event (category *Alert notifications*), which names the channel and the alert — never the URL, never what the server answered.

### Channels

| Type | What is sent |
|------|--------------|
| `ntfy` | `POST` plain text to the topic URL with `Title`, `Priority` (5 critical, 4 warning, 3 resolved) and `Tags` headers — ntfy.sh or self-hosted |
| `discord` | Discord webhook JSON: `content` plus one embed per alert (mentions disabled) |
| `slack` | Slack incoming-webhook JSON `{ "text": … }`; `&`, `<` and `>` are escaped, so unit names and remote text cannot add mentions or links |
| `webhook` | Generic JSON `{ source, status, severity, title, reminder, sentAt, alerts: [{ status, severity, rule, ruleName, unit, unitId, label, summary, startsAt, endsAt }] }` |

Everything that fires or clears in one evaluation goes out as one message per channel, filtered by the channel's minimum severity. **Remind while still firing** (off by default) repeats firing alerts every 1 h / 4 h / 12 h / 24 h. Text that comes from elsewhere (unit names, SSH errors, kernel Xid lines, model ids) is cut to 120 characters.

How sends are made:

- **Outbound policy.** A channel URL must be `http(s)` and pass the same target policy as units and LLM endpoints (`server/validate.js`): LAN, Tailscale and loopback addresses are fine (a self-hosted ntfy), link-local / cloud-metadata, multicast and unspecified addresses are refused. The host is checked when the channel is saved and resolved again on every send; the connection goes to exactly the address that was checked, so a DNS record that changes in between cannot redirect it.
- **No redirects.** A `3xx` answer is a failed send (`redirect not followed`).
- **No response bodies.** A failure is reported as a status code or a fixed reason (`HTTP 403`, `timed out after 10s`, `connection failed (ECONNREFUSED)`) — in the dialog, the log and Activity alike.
- **No retries.** Each message is sent once. A failed send is logged, shown on the channel and recorded in Activity (`alert.notify.failed`), but the alert still counts as notified: the channel next hears about it when it escalates, clears, or — with **Remind while still firing** on — at the next reminder. Use **Send test** to check a channel after changing it.
- **Channel URLs may point at your LAN.** Like unit and LLM targets, a channel can be a private or loopback address (a self-hosted ntfy), so `POST /api/alerts/test` shows, to anyone who holds the dashboard token, whether a host and port on those networks answers (a status code or a fixed reason, never the response body). Link-local, metadata, unspecified and multicast addresses are refused, and the connection is pinned to the addresses that were checked. Set `SPARKDASH_TOKEN` if the dashboard is reachable beyond your own machine.

Example — phone notifications with [ntfy](https://ntfy.sh): subscribe the ntfy app to a topic nobody will guess (e.g. `sparkdash-7f3k9q`), turn notifications on, **Add channel** with type `ntfy` and URL `https://ntfy.sh/sparkdash-7f3k9q` (or your own server), **Save**, then **Send test**.

### Where the configuration lives

Channel URLs are credentials, so they are stored encrypted in `config/sparks-secrets.json` next to the unit passwords and LLM API keys, and the API only ever shows them masked (`https://ntfy.sh/…`: the host and a fixed mask, nothing of the topic or token; saving the masked value unchanged keeps the stored URL). `config/alerts.json` (`ALERTS_JSON_PATH`, mode `0600`) holds the rest: rule switches and waits, channel names and types, and the firing set. A plaintext URL left in `alerts.json` by an earlier build is moved into the encrypted store when the server starts.

While notifications are off, nothing is evaluated or sent, and `PUT /api/alerts/config` and `POST /api/alerts/test` answer `409`. While on, the WebSocket snapshot carries `alerts.active` and the Overview exceptions strip lists the server's alerts with their real durations.

### In the browser

**Settings → Tab badge / Desktop notifications** (per browser, both off by default): the tab title shows how many fleet alerts are active — `(2) sparkDash` — with a red (critical) or amber dot on the icon, and a desktop notification pops up when one becomes active while the page is open. Both count every alert the strip knows of — the server's alerts while notifications are on, otherwise the strip's own conditions with the temperature unit applied — including offline units, storage, LLM and Health while *Show active fleet exceptions* is off and the strip itself shows throttling only. Conditions the browser derives itself must hold for 30 s before they count and stay clear for 30 s before they stop, so a flapping reading notifies once. Browsers only allow notifications on HTTPS or localhost — on a plain-HTTP LAN address, use an SSH tunnel, Tailscale Serve or an HTTPS proxy, or an ntfy channel.

---

## MQTT

Opt-in (default **off**). **Settings → MQTT publishing** forwards what sparkDash already holds to your own broker as it changes — no scraping of the dashboard and no extra SSH: the fleet event stream, per-unit availability and per-unit readings, published as JSON. Useful with Home Assistant, Node-RED, Telegraf or anything else that speaks MQTT.

**Settings → MQTT** holds the broker URL (`mqtt://host:1883`, `mqtts://` for TLS, `ws(s)://` for a websocket broker), the username (empty for anonymous) and the topic prefix (default `sparkdash`). The password never goes into `config/settings.json` (that file is world-readable): set `SPARKDASH_MQTT_PASSWORD` in the server's environment instead. For the same reason a URL with credentials in it (`mqtt://user:pass@host`) is refused, and one found in an existing `settings.json` is removed from the file at startup. A changed URL, username or prefix reconnects immediately; the password is read once at startup. Everything is published under the prefix, so `PREFIX/#` sees the whole feed:

| Topic | Payload | Published |
|-------|---------|-----------|
| `PREFIX/events` | one JSON activity-feed record per event (`id`, `ts`, `type`, `severity`, `sparkId`, `sparkName`, `message`, and `data` where present) | every accepted event, QoS 1 (the same 5 s dedupe as the Activity page applies) |
| `PREFIX/status/{unitId}` | `1` or `0`, **retained** | whenever it changes (and on reconnect); the last state survives a broker restart and a new subscriber learns it immediately. Removing a unit clears its retained status and metrics (an empty retained message) |
| `PREFIX/metrics/{unitId}` | `{ts, up, …}` — the JSON twin of the unit's Prometheus series (fields below; semantics in [Prometheus](#prometheus)) | whenever the readings change (and on reconnect), QoS 0, **retained** |
| `PREFIX/dashboard/status` | `1` while sparkDash is connected, `0` on shutdown and as its last-will message, **retained** | on connect; on a clean shutdown (sparkDash waits up to 1.5 s for the broker to acknowledge it); by the broker if sparkDash dies uncleanly |

`PREFIX/metrics/{unitId}` is one unit's readings in a nested shape — `{ts, up, uptime_seconds, gpu: [{index, name, uuid, utilization_ratio, temperature_celsius, power_watts, power_limit_watts, memory_used_bytes, memory_total_bytes, throttled: {thermal, power, hw}}], memory_available_bytes, cpu: {utilization_ratio, temperature_celsius, temperature_source}, ram: {used_bytes, total_bytes}, net: [{interface, receive_bytes_per_second, transmit_bytes_per_second}], disks: [{mount, device, used_bytes, available_bytes, total_bytes}], llm: [{port, backend, model, up, generation_tokens_per_second, prefill_tokens_per_second, kv_cache_usage_ratio, requests_running, requests_waiting, generated_tokens_total, prompt_tokens_total, cached_prompt_tokens_total}], collector_last_success_seconds}`. An LLM entry whose endpoint answered but whose stats could not be read carries `measurement_valid: 0` and no rates or counters. An unreachable unit publishes `{ts, up: 0}` on its metrics topic, and a reading the collectors could not take is omitted rather than reported as zero — the same rules `/metrics` follows.

```bash
mosquitto_sub -h homeassistant.local -t 'sparkdash/#' -v
```

Publishing is best-effort: while the broker is unreachable sparkDash retries every 5 s in the background and drops messages instead of queueing them, so a long outage leaves a gap rather than a backlog. A slow broker is handled the same way: at most 100 publishes wait for acknowledgement at once, beyond that new events are dropped and changed readings are sent once it catches up, and a connection that leaves a publish unacknowledged for 30 s is reopened. Nothing on the publish path can block a poll loop (warnings are rate-limited to one line per 30 s). For Home Assistant, `PREFIX/status/{unitId}` drives a binary sensor and each `PREFIX/metrics/{unitId}` key maps to a template sensor; for Node-RED the JSON is directly `msg.payload`.

---

## API Keys

Opt-in (default **off**). **Settings → API Keys page** adds a read-only **API Keys** page listing the [LiteLLM](https://docs.litellm.ai/docs/proxy/virtual_keys) virtual keys of a LiteLLM proxy you run: alias, state, spend, budget and reset period, RPM / TPM limits, expiry and last activity, with a detail view per key. While the setting is off there is no sidebar, command-palette or mobile entry, and every `/api/apikeys/*` route answers `404`.

sparkDash never talks to LiteLLM and never holds its master key. It talks only to a small **bridge** on the LiteLLM host, over a unix socket, and the bridge answers a fixed list of read-only calls. There is no direct mode. Creating, deleting, blocking or re-budgeting keys is not part of this page.

Set two variables in the server's environment (never in `config/settings.json`, which is world-readable), then bind-mount the socket's directory into the container:

| Variable | Meaning |
| --- | --- |
| `SPARKDASH_APIKEYS_BRIDGE_SOCKET` | Path of the bridge's unix socket as seen by the sparkDash process |
| `SPARKDASH_APIKEYS_BRIDGE_TOKEN` | Token sparkDash sends to the bridge as `Authorization: Bearer …`; the bridge stores only its sha256. Read once at startup |

**Bridge protocol** (version 1). Every request is `GET` with `Authorization: Bearer <token>` and gets a JSON reply:

| Call | Reply |
| --- | --- |
| `GET /v1/health` | `{ version, upstream: "ok" \| "down" }` |
| `GET /v1/keys` | `{ keys: [Key] }` |
| `GET /v1/keys/<id>` | `{ key: Key }`, `404` for an unknown key. `<id>` is LiteLLM's 64-hex hashed key id |

`Key` is `{ id, alias, state ("active" | "blocked" | "expired"), blocked, spend, maxBudget, budgetDuration, budgetResetAt, expires, createdAt, lastActive, rpmLimit, tpmLimit, maxParallelRequests, models }`. Any field may be `null`; key material (`sk-…`) is never part of a reply. sparkDash drops fields it does not know, and a spend or limit that is missing or not a number is shown as **unknown**, never as `0`. For a key with a budget period, LiteLLM's `spend` covers only the current period. The reference bridge refuses a list of more than 5000 keys (`502`) rather than returning part of it, and treats a LiteLLM reply over 8 MB as a failure.

**Bad token, lockout and backoff.** When the bridge answers `401` or `403`, sparkDash stops calling it for 30 s, doubling on each further rejection up to 15 minutes, and the page shows the error and the wait instead of data; the first accepted call resets the backoff. A `429` from the bridge is honoured with its `Retry-After` (at most 15 minutes). The reference bridge itself refuses every request with `429` after 10 rejected tokens within 10 minutes, until the oldest failure leaves the window; any process that can open the socket can therefore trigger that lockout, so keep the socket's group to the sparkDash user. The routes are also behind sparkDash's own auth and a 60-requests-per-minute limit per client.

**Reference bridge.** `scripts/apikeys-bridge/bridge.js` (Node, no dependencies) implements exactly the three calls above, using LiteLLM's `/health/readiness`, `/key/list` and `/key/info` with the master key. It refuses every other method (`405`) and path (`404`) without contacting LiteLLM. `scripts/apikeys-bridge/sparkdash-apikeys-bridge.service.example` runs it under systemd with the master key passed through `LoadCredential`, so the key file can stay root-only. Hash the token with `printf %s "$TOKEN" | sha256sum`. You may write your own bridge instead: anything that speaks the protocol above works.

**Audit log.** None: this page cannot change anything, so nothing is logged and nothing grows on disk.

## RoCE / RDMA monitoring

Spark units with RDMA devices (the CX7 ports) get a **RoCE / RDMA** panel on their page, with no switch integration and no root. Per port: link state and rate, MTU, netdev RX/TX traffic, RDMA payload throughput (the port's own `port_rcv_data` / `port_xmit_data` counters), interface errors and drops, PFC priorities, QoS trust mode (PCP or DSCP) and the DSCP map, global pause settings, and the RDMA counters (out of buffer, sequence errors, ACK timeouts, ECN-marked packets, CNPs sent and handled) plus ethtool discards, CRC errors and pause frames, with the change since the last sample.

Everything comes from the Spark itself: `/sys/class/infiniband`, `/sys/class/net`, `ethtool -S` / `-a` and `mlnx_qos -i`. The fast part (link, RDMA payload rates, counters, netdev traffic) is read about every 5 s; the slow part (ethtool counters, PFC and trust) every 30 s. Units without RDMA devices are skipped and re-checked every 10 minutes. The API exposes it as `metrics.roce` in `/api/sparks/:id/metrics`.

Two health findings use it: **a RoCE link went down** (a port that was up, critical) and **RoCE is dropping packets** (RDMA loss counters such as `out_of_buffer` or sequence errors rising for three samples in a row, or port discards / CRC errors rising on two consecutive 30 s readings; a single dropped frame is not reported). Ports that never came up are not reported. Switch telemetry (PFC and ECN statistics on the switch side) is not part of this; it could be added later as an optional integration.

---

## Intel Arc GPUs

Discrete Intel GPUs bound to the Linux `xe` driver show up in the GPU panel next to NVIDIA and AMD cards, locally and on SSH units. Everything is read from sysfs and hwmon, with no vendor tool: temperature, fan, clock and power cap directly; power in watts from the card's energy counter (a delta between polls); usage from the GT idle residency. Integrated GPUs (PCI bus 00) and `i915` cards are not read. Intel cards have their own index range (2000 and up) and `vendor: "intel"`.

**VRAM.** Exact VRAM use lives in root-only debugfs (`/sys/kernel/debug/dri/<pci-address>/tile<N>/vram_mm`). Reading it is **off by default**: with **Settings → Intel Arc VRAM via sudo** off, no `sudo` runs on any host and the card shows its PCI BAR size as the total (`vramSource: "pci-bar"`, usage unknown). When it is on, the probe runs `sudo -n cat <exact path>` for `tile0` first and then `tile1` to `tile3`, one path per call, and the first file that answers wins. The result is cached for 45 seconds, and a host where `sudo -n` fails is not asked again for 10 minutes, so neither case floods the host's auth log.

**The sudoers rule.** Grant the SSH user that one command on the exact files and nothing wider. A bare `cat` grant (or `ALL`) would let that user read any file as root. Pin each card's debugfs files by its PCI address (`lspci -D | grep -i -E 'vga|display'`, for example `0000:3a:00.0`):

```
# /etc/sudoers.d/sparkdash-intel-vram   (edit with: sudo visudo -f /etc/sudoers.d/sparkdash-intel-vram)
Cmnd_Alias SPARKDASH_INTEL_VRAM = \
    /usr/bin/cat /sys/kernel/debug/dri/0000\:3a\:00.0/tile0/vram_mm, \
    /usr/bin/cat /sys/kernel/debug/dri/0000\:3a\:00.0/tile1/vram_mm, \
    /usr/bin/cat /sys/kernel/debug/dri/0000\:3a\:00.0/tile2/vram_mm, \
    /usr/bin/cat /sys/kernel/debug/dri/0000\:3a\:00.0/tile3/vram_mm
sparky ALL=(root) NOPASSWD: SPARKDASH_INTEL_VRAM
```

Use the full path of `cat` that `command -v cat` prints for that user (`/usr/bin/cat` or `/bin/cat`; they are the same file on merged-`/usr` systems) and escape the colons of the PCI address with a backslash, as above. Do not use `*` in the paths: in sudoers a wildcard also matches spaces and `/`, so `.../dri/*/tile0/vram_mm` would also allow `cat` of other files. On sudo 1.9.10 or newer a regular expression pins the same set: `/usr/bin/cat ^/sys/kernel/debug/dri/[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]/tile[0-3]/vram_mm$`. Check the rule with `sudo -n cat /sys/kernel/debug/dri/<pci-address>/tile0/vram_mm` as that user. The local unit (the container with `pid: host`) runs as root and needs no rule.

**Health.** Intel cards are shown and counted in the power and VRAM totals but are not judged by the NVIDIA-tuned health thresholds. If `nvidia-smi` is installed but returns no devices on a host that has an Intel card, the GPU collection is reported as failed (the Intel card is still shown), so a broken NVIDIA driver does not look healthy; a host with no `nvidia-smi` at all is treated as Intel-only.

## Windows PCs

A Windows PC with an NVIDIA GPU can be monitored with no agent. On the PC:

1. Install the **OpenSSH Server** (Settings → Apps → Optional features → *OpenSSH Server*), then start it and set it to start automatically: `Start-Service sshd; Set-Service sshd -StartupType Automatic` in an elevated PowerShell. Windows Firewall opens port 22 for it.
2. Make sure the NVIDIA driver is installed (`nvidia-smi` works in a terminal).
3. In sparkDash choose **Add Spark / GPU host**, set **Unit type** to *Windows PC with an NVIDIA GPU*, enter the PC's LAN IP and your Windows user (a password works; for key login see the administrator-account note below).

**Keys work everywhere but this PC?** For a Windows user in the *Administrators* group, `sshd` ignores `~\.ssh\authorized_keys` and reads `C:\ProgramData\ssh\administrators_authorized_keys` instead, and refuses it unless only Administrators and SYSTEM can write to it. Put the public key in that file, then fix its permissions in an elevated PowerShell:

```powershell
icacls.exe "$env:ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

A refused key on a Windows unit also shows this hint in the connection error.

sparkDash then runs two short PowerShell scripts over SSH per poll (no files are installed): GPU temperature, utilisation, power, VRAM and GPU processes from `nvidia-smi`, and RAM, uptime, CPU load, disks (fixed drives) and network adapters from Windows' CIM classes. Shutdown works (`shutdown.exe /s`). Not available on Windows: CPU temperature (Windows exposes no unprivileged sensor; CPU power is estimated from load), automatic Wake-on-LAN MAC detection (enter the MAC by hand), Hermes and Tailnet checks, model launchers, and the kernel Xid/OOM events. LLM servers on the PC (llama.cpp, Ollama, LM Studio, vLLM) are probed over HTTP as for any unit; if the server only listens on `127.0.0.1`, benchmarks fall back to an SSH tunnel.

**AMD-iGPU Windows hosts (Strix Halo)**: if `nvidia-smi` is not installed, the same GPU script falls back to Windows' GPU Engine / GPU Adapter Memory performance counters — utilization is the busiest engine per physical adapter (three samples per poll, clamped to 100%), and memory comes from the adapter counters, with the total read from the driver's reported memory size (on a unified-memory iGPU this is the BIOS carve-out, e.g. 96 GB on a 128 GB Strix Halo; a MemTotal/MemAvailable fallback applies when the driver does not report it). The unit type is the same *Windows* option. An NVIDIA PC whose `nvidia-smi` is installed but failing does not use this fallback; it reports the failure instead. AMD publishes no GPU temperature or power to Windows, so those read 0. The model launchers are bash/systemd and stay unsupported on Windows; HTTP probing and benchmarks work as usual.

---

## LLM server presets & backend auto-detection

### Server presets

LM Studio (:1234), Ollama (:11434) and TensorFold (:8888) are one-click presets in three places — the Add wizard's LLM-ports step, the unit page's "+ Add LLM port" panel (clicking a preset adds the port immediately), and each LLM panel's settings (the preset fills the port field, then Save). Presets fill a **port number only**: they do not install, start or switch anything, and the dashboard will show a port as unavailable until a server actually answers there.

### How each backend is detected

| Engine | Signal |
|--------|--------|
| llama.cpp | `/slots` with per-slot timings |
| vLLM | Prometheus `/metrics` (the default for OpenAI-compatible servers); `GET /version` supplies the engine version shown on the LLM panel |
| SGLang | native `/server_info` / `/get_server_info` + `/model_info` |
| LM Studio | `/api/v0/models` — model entries carry a load `state` (a contract no other engine has) |
| Ollama | native `/api/tags` |
| ds4-server | `ds4_*` Prometheus series |
| EXL3 | `/health` with backend + token totals |
| q27 | Prometheus exposition |
| TensorFold | `owned_by` on `/v1/models`, totals from `/health`, and `/health`'s `version` when the build names one |
| FreeToken | `/v1/stats` throughput contract |
| Strata | `/health` reports `service: "strata"`, checked before the llama.cpp-compatible `/slots`; JSON `/metrics` supplies rates |

Detection is **positive-signature first**: some desktop engines (LM Studio) answer HTTP 200 with a JSON body on *every* path, which would trip naive heuristics ("does `/server_info` return JSON?" → SGLang, or the vLLM default). sparkDash probes each engine's unique endpoint and never lets a catch-all-200 server downgrade an identified backend.

Strata monitoring follows the [v0.1.45 JSON metrics contract](https://github.com/Niko1221/Strata/blob/477ac13cbe8e582c20484871ce459d20d82df09d/serve/server.py#L3738-L3790). **Decode** uses the aggregate sliding-window rate. When a newer request is prefilling and hides that rate, it sums the available decoding-slot rates and labels the result **active-slot mean** (each slot's mean starts at its first generated token). It publishes no partial sum if a decoding slot lacks a rate or work is running outside the slots. **Prefill** is the engine's **last reported mean** for new/computed prompt tokens, shown while the selected request is reading and either a slot is reading or unfinished engine progress confirms prefill outside the slots; the value may come from an earlier prefill and is not a sum across concurrent slots. A busy phase without a rate says **decoding** or **prefilling**. Idle clears both rates immediately. Completed-request totals are retained as totals, never turned into live rates; restarting Strata therefore does not create a TPS spike. No per-slot prefill throughput or KV-cache occupancy is inferred from held prompt tokens.

Strata's model aliases share the loaded engine's native context limit, shown on both the LLM panel and overview card. Its loaded engine is **Active** even when idle. The sidebar retains numeric decode rates, uses **prefilling** or **decoding** while work is active without a decode rate, and returns to zero when idle.

### Decode / prefill tok/s on engines without counters

vLLM, SGLang and friends publish cumulative token counters, and the dashboard diffs them per poll. LM Studio and Ollama publish none, so their tok/s tiles stay at 0 in the LLM panel. sparkDash never sends a request of its own to a model server to measure speed (that would load models, keep them resident and add traffic you did not ask for). The decode and prefill benchmarks and the Prompt Showcase measure real speed on demand.

### Multiple LLM ports

Any unit can monitor several LLM servers on different ports at once; each port gets its own panel with independent backend detection, metrics and history. Panels are matched to their port explicitly, so adding, removing or switching ports never shows one port's data on another's panel.

### Engines run in containers (sparkrun, `docker run`)

sparkDash only needs the engine's HTTP port; it does not care how the engine was started. For a vLLM (or any supported engine) that a container tool such as sparkrun publishes on the unit:

- Add the unit, then add that port in the Add wizard's LLM-ports step or the unit page's **+ Add LLM port** panel. The probe, live tok/s, KV-cache tiles (vLLM Prometheus `/metrics`) and the decode/prefill/quality benchmarks run over HTTP; nothing is installed in the engine's container.
- The dashboard container uses `network_mode: host`, so a port published on the unit's loopback or LAN address is reachable as `127.0.0.1` (this unit) or its LAN IP (a remote unit). Benchmarks on a remote unit whose server only listens on loopback fall back to an SSH tunnel.
- A Docker-based start script that detaches (`docker run -d`) shows **Stopped** in the Models panel because the script's process group is gone, while the port probe shows **Serving**. Treat the port status as the source of truth (the **Output** button re-opens the script's output while it runs).
- Provisioning models (pulling weights, choosing a recipe) stays with your own tool; the Models panel only runs the `start.sh` / `stop.sh` you register.

Model launchers require Bash, util-linux `setsid`, and GNU `tail` with `--pid` support on the Linux unit. **Start** and live **Output** drain the log before reporting completion, including the last line without a newline. The follower tracks the script's whole process group, so output continues when the wrapper exits but the model process is still running.

---

## GPU clock cap

### Set it from the dashboard

**Edit unit → GPU clock cap** (Spark units on Linux only; hosts, Windows and Macs do not show it) caps the graphics clock with `nvidia-smi -lgc 0,MAX`, the same thing the standalone [sparkLimiter](https://github.com/MiaAI-Lab/sparkLimiter) script does. It shows the cap in effect and the GPU maximum, and has:

- **Apply** — caps the clock now (300 MHz up to the GPU maximum). It is lost at the next reboot unless the option below is on.
- **Keep after reboot** — installs the boot hook this unit can take: `spark-gpu-clock-limit.service` (a oneshot unit that re-applies the cap at boot; the same name sparkLimiter uses, so the two manage one unit) where sudo reaches a root shell and systemd runs, otherwise an `@reboot` line in the SSH user's own crontab tagged `# sparkdash-gpu-clock-cap` that runs the very same `sudo -n nvidia-smi -lgc` the cap just ran. Only one hook is kept at a time: installing one removes the other. Other crontab lines are never touched (our line is the one that ends in the tag), and a crontab that cannot be read is left alone and the change refused. The `@reboot` job tries three times; if every attempt fails it writes a failure marker (`~/.config/sparkdash/gpu-clock-cap.failed`, holding that boot's id) and tries `logger -t sparkdash`, and the dialog then shows that the job ran at this boot and the GPU is not capped. The next **Apply**, or **Remove limit**, clears it. The checkbox names the hook. Switching it off removes it.
- **Remove limit** — runs `nvidia-smi -rgc` and removes both hooks and the marker.
  If an old root-owned marker cannot be removed after sudo permissions were narrowed, Apply and Remove refuse before changing clocks or boot hooks. Use the per-unit password/manual-command flow with sufficient privileges to clean up the marker; the error names the affected path.

It acts at once on the unit's saved connection settings; it is not part of **Save**. Activity records each change.

**Run it on the Spark yourself.** The section also has a *Run it on the Spark yourself* panel (open by default when no password can be typed in the dashboard). **Show command: apply / remove** gives a command to paste into a terminal on the Spark. It is the same steps as the buttons, as a short readable script, but with plain `sudo`, so **sudo asks for your password there** and the result is printed in plain words (non-zero exit on failure). Nothing is sent to the dashboard, and it works when the dashboard has no sudo or the unit is offline to it. API: `GET /api/sparks/:id/gpu-clock/command?action=apply&maxMHz=1800&persist=1` (or `action=reset`).

Needs root on the unit: the local unit runs as root through the host mount namespace (like Shutdown); a remote one uses `sudo`. A passwordless rule for the commands the cap itself runs — the shape [sparkLimiter](https://github.com/MiaAI-Lab/sparkLimiter) installs, with the arguments pinned as in **The narrow sudoers rule** below — is enough to cap, read back and unlock; the marker then goes to the SSH user's `~/.config/sparkdash/gpu-clock-cap`, which the status read checks alongside the root-owned one. **Keep after reboot** installs a boot hook, so it needs either `NOPASSWD: ALL` (or root) for the systemd unit, or a running cron service for the `@reboot` job; where neither is available the box is disabled with the reason inline, before the GPU is touched. Without passwordless sudo the section asks for the **sudo password** of that user: it is sent once over your connection to the dashboard, passed to `sudo -S` on the unit through stdin (never in a command line, never in the program text, and dropped from the environment before anything else runs), used for that one change, then discarded. It is never stored or logged, a wrong password is reported as such, and three wrong ones lock that account for five minutes (and nine across all units). The dashboard only accepts a typed password over **https or from the machine itself** (a plain `http://<lan-ip>` page would send it in the clear; a same-host reverse proxy on plain http is recognised by its forwarding headers and does not count as local); there the buttons stay off and the paste-in command below is offered. If starting the boot service fails, the previous service is restored and the cap stays applied until the next reboot. If an old boot hook cannot be removed after a cap without **Keep after reboot** was applied, the error says so: the cap is in force and recorded, but the old hook will re-apply its own cap at the next boot. A cap above the GPU's maximum is refused, only validated whole numbers reach the unit, and `nvidia-smi` is only taken from fixed system paths (`/usr/bin`, `/usr/local/bin`, `/bin`), never from `PATH`. The `@reboot` line also contains the path of `sudo` and the SSH user's home directory, which come from the unit: each must be a plain absolute path (letters, digits, `_ . / -`), otherwise the change is refused before the GPU is touched. API: `GET|PUT|DELETE /api/sparks/:id/gpu-clock` (same token and rate limits as the power routes).

Apply and Remove require Linux `flock` (from util-linux, at `/usr/bin/flock` or `/bin/flock`). They share a per-user lock at `~/.config/sparkdash/gpu-clock-cap.lock` with the dashboard's `@reboot` job, including when the cap marker is root-owned. The job sleeps outside the lock, then checks its install token and changes clocks and markers while holding it. A completed Remove therefore cannot be undone by an older in-flight job. Missing locking support or an inaccessible lock refuses the operation before changing clocks or hooks; do not delete the lock file while an operation is running.

Cron persistence also requires the exact NVIDIA cap command to work **without a password or cached sudo authentication**. Its initial cap uses `sudo -k -n` to establish that; a typed password alone cannot authorize a boot-time command. If refused, apply without **Keep after reboot**, or grant the narrow `NOPASSWD` rule below. An unreadable crontab makes status fail rather than claiming that no hook is installed.

**The narrow sudoers rule.** Do not grant `nvidia-smi -lgc *`: in sudoers a `*` also matches spaces and further words, so the user could pass any other `nvidia-smi` option to root (`-lgc 0,1800 --id=0` is allowed by that rule). Pin the arguments. On sudo 1.9.10 or newer, with a regular expression:

```
# /etc/sudoers.d/sparkdash-gpu-clock   (edit with: sudo visudo -f /etc/sudoers.d/sparkdash-gpu-clock)
sparky ALL=(root) NOPASSWD: /usr/bin/nvidia-smi ^-lgc 0,[0-9]+$, /usr/bin/nvidia-smi -rgc
```

On older sudo, list the exact commands instead (the commas inside an argument are escaped). The Settings presets are 1800 to 2400 MHz in 100 MHz steps; a custom value from **Edit unit** needs its own line:

```
sparky ALL=(root) NOPASSWD: /usr/bin/nvidia-smi -lgc 0\,1800, /usr/bin/nvidia-smi -lgc 0\,1900, /usr/bin/nvidia-smi -lgc 0\,2000, /usr/bin/nvidia-smi -lgc 0\,2100, /usr/bin/nvidia-smi -lgc 0\,2200, /usr/bin/nvidia-smi -lgc 0\,2300, /usr/bin/nvidia-smi -lgc 0\,2400, /usr/bin/nvidia-smi -rgc
```

Use the path `command -v nvidia-smi` prints for that user. Both forms were checked against sudo 1.9.17: `-lgc 0,1800` and `-rgc` run without a password, while `-lgc 0,1800 -q`, `-lgc 0,18x0`, `-lgc 300,1800` and `-rgc -i 0` ask for one. The status check asks `sudo -l nvidia-smi -lgc 0,2400`, which both forms allow. The `@reboot` job runs the same `sudo -n nvidia-smi -lgc 0,MAX` line, so the same rule covers it.

The current value is shown on the unit: `cap 1800 MHz` under the SM clock on the GPU panel and a `Cap 1.8 GHz` chip on the Overview card. A unit capped with the standalone script shows no value until you press **Apply** once, because that script writes no marker.

### Cap the whole fleet at once

**Settings → GPU clock cap** is the same control for every unit, shown as the states a Spark can be in: **Full capacity** (no cap) and **1800–2400 MHz** in 100 MHz steps. The state every Spark is on is marked; picking another only selects it — **Save** applies the picked state to every unit first, and stores settings only when that operation succeeds. Units already changed are not rolled back when another refuses. A mixed fleet marks nothing. The list stops at 1800 so a cap cannot silently underclock below the range the fleet runs at. **Keep after reboot** installs a boot hook on each unit — the systemd service where `NOPASSWD: ALL` reaches `systemctl` and `install`, an `@reboot` cron job where only the `nvidia-smi` commands are granted: where every unit that answered can keep the cap the tick starts on, and where none can it is disabled with that reason, leaving the cap until the next reboot. **Full capacity** removes the cap everywhere (`nvidia-smi -rgc` plus both hooks and the marker) and asks for no confirmation.

It runs each unit's own change in turn through the same path as the per-unit dialog, so the sudo requirements above apply unchanged — including that **Keep after reboot** needs a boot hook on each unit; one unit failing does not stop the others, and the row reports the per-unit outcome (`3 of 4 units, 1 skipped`) plus which hook each unit took (`kept after reboot by the boot service` / `by the @reboot cron job`) instead of a bare success. A unit that cannot take a cap at all — a host, a Windows or Mac unit, a box without `nvidia-smi` — is reported as skipped, not as an error; but a fleet where every unit was skipped changed nothing, so the answer is `success: false` with `applied: 0` and the row says `Nothing changed`. The whole batch has a three-minute budget: units not reached by then are reported as not attempted. API: `POST /api/sparks/gpu-clock-all` with `{ maxMHz, persist? }`, or `{ reset: true }` to clear it everywhere; the answer is `{ success, applied, results }`.

If every attempted unit reports a failure, the summary warns that some changes may already have applied: a cap can take effect before installing or removing its reboot hook fails. The requested state stays pending for retry; the per-unit errors and refreshed live status show what happened.

A failed Save remains pending even if the live cap already matches the pick: installing or removing its boot hook may still need to be retried. Save retries the operation before storing other settings, and a failed **Keep after reboot** request keeps its checkbox selected until you explicitly change it.
If the GPU operation succeeds but storing settings fails, Save remains available and retries the settings request without reapplying the successful GPU operation.
A persistence-only change keeps the fleet's known shared frequency. Save compares the requested state with each unit's installed hooks, not just its current MHz or its ability to install a hook. Missing, disabled, failed, duplicate or differently configured hooks remain actionable. Opening Settings alone does not queue a GPU change; on a mixed or unreadable fleet, pick a frequency before changing persistence.
Selecting **Full capacity** also removes installed boot hooks when the GPUs are already unlocked. A selection remains pending if any supported unit could not be read. In the per-unit dialog, an installed but currently unavailable boot hook can still be unticked. Each cron install has its own token: a delayed reboot job whose line has been removed or replaced exits instead of restoring the old cap.

### How the value is read

`nvidia-smi -lgc 0,<MHz>` locks the max graphics clock, but NVML has no way to
read that lock back (`clocks.max.*` stays at the hardware max). So whoever sets
the lock drops a one-line marker on the Spark, and sparkDash shows it as
`cap 1800 MHz` under the SM clock on the GPU panel, a `Cap 1.8 GHz` chip on the
Overview card, and `gpu.throttle.clockCapMHz` in the API.

```bash
# set
sudo nvidia-smi -lgc 0,1800
mkdir -p ~/.config/sparkdash
echo "1800 $(cat /proc/sys/kernel/random/boot_id)" > ~/.config/sparkdash/gpu-clock-cap

# revert
sudo nvidia-smi -rgc
rm -f ~/.config/sparkdash/gpu-clock-cap
```

The marker is read from `/run/sparkdash/gpu-clock-cap` (for a root-run unit)
or `~/.config/sparkdash/gpu-clock-cap` of the SSH user. The optional boot_id
makes a stale marker disappear after a reboot, when the lock is gone too.

## Quick start

```bash
git clone https://github.com/MiaAI-Lab/sparkDash.git
cd sparkDash

# Production (Docker; loopback-only by default)
docker compose up --build -d

# Or development (host, with hot reload)
npm install
npm run dev
```

- **Docker**: open **http://127.0.0.1:5555** on the host (auto-restart, host mounts for GPU/metrics access). The image is built for the machine's own architecture — Docker detects it, so a DGX Spark builds and runs the arm64 image as before and an x86 box builds a native amd64 one, with no emulation and no *image platform does not match the host platform* warning. Both architectures are supported: `docker compose -f docker-compose.yml -f docker-compose.multiarch.yml build` produces the arm64 and amd64 variants in one manifest list (the pair the release workflow publishes), and `DOCKER_DEFAULT_PLATFORM=linux/arm64` (or `linux/amd64`) cross-targets a single one. The compose file serves the frontend from the host's `./dist` when it has been built (`npm run build`) and from the copy baked into the image otherwise, so a fresh clone works; a host build that is older than the image's copy is ignored, so after `git pull` one `docker compose up --build -d` is enough
- **Dev**: Vite on **http://localhost:5173** (proxies API/WS to Express)

For another computer, keep the server on loopback and use an SSH tunnel:

```bash
ssh -N -L 5555:127.0.0.1:5555 user@sparkdash-host
```

Then open `http://127.0.0.1:5555` on that computer. For shared access, use an authenticated TLS reverse proxy, Tailscale Serve, or set `BIND_HOST=0.0.0.0` **and** `SPARKDASH_TOKEN`. A direct LAN bind without a token is **open by default**: anyone who can reach the port can change settings and power units off, and the header shows an **Open access** warning. Set `SPARKDASH_TOKEN` to require a token, or `SPARKDASH_ALLOW_OPEN_REMOTE=0` to make a tokenless LAN bind refuse to start.

When the server has `SPARKDASH_TOKEN` set, the dashboard asks for it: the first request or live-telemetry connection the server turns away opens an **Access token** dialog. Enter the token once; it is checked against the server, stored in this browser only, and the live connection reconnects with it — no reload, no devtools. **Settings → Access token** shows whether one is stored and lets you change or clear it.

For development with Docker (source-mounted, HMR):
```bash
docker compose -f docker-compose.dev.yml up --build
```

**Published image (no local build):** each release tag (`v*`) is built for arm64 and amd64 and pushed to `ghcr.io/miaai-lab/sparkdash`. The workflow only runs for tags pushed after it was added, so releases up to v2.32.0 have no image: until the first newer release is out, `docker pull` answers `denied` (an unpublished package looks the same as a private one) and you build from source (`docker compose up --build -d`). `docker-compose.image.yml` runs that image with the same host mounts and environment as `docker-compose.yml`; it is the only file the host needs, and `./config` next to it holds the runtime state:

```bash
curl -fsSLO https://raw.githubusercontent.com/MiaAI-Lab/sparkDash/main/docker-compose.image.yml
docker compose -f docker-compose.image.yml up -d
```

It follows `latest` unless `SPARKDASH_VERSION` names a release (`SPARKDASH_VERSION=<version>`); update with `docker compose -f docker-compose.image.yml pull` and `up -d`. The frontend history window (`VITE_HISTORY_HOURS`) is fixed at the default 8 hours in the published image; build locally to change it.

**Remote units + SSH keys (Docker):** SSH is executed *inside* the container on the sparkDash host (typically the head DGX). Configured LAN IPs are from **that** host’s point of view, not your laptop. OpenSSH looks for keys under `/root/.ssh` in the container — the host user’s `~/.ssh` is not used unless you bind-mount it. Uncomment this volume in `docker-compose.yml` (and recreate the container):

```yaml
- ${HOME}/.ssh/id_ed25519:/root/.ssh/id_ed25519:ro
```

If the key file has a non-default name (e.g. `id_ed25519_shared`), mount it **as** `id_ed25519`, or set `SSH_IDENTITY_FILE` to the path inside the container. Keep the file mode `600`. The unit that runs sparkDash itself should be added with **This host (local collectors — no SSH for metrics)**.

---

### Running it on a machine that is not a Spark

The dashboard does not have to run on a Spark. Every unit, including the machine running the dashboard, can be monitored over SSH, so you can run sparkDash on any Linux box (an x86 mini PC, a NAS, a VM) and add all your Sparks as remote units.

- The shipped `Dockerfile` and `docker-compose.yml` target arm64 DGX Spark hosts (platform pin and `aarch64` NVIDIA library mounts). On x86 either edit those lines or run it bare: `npm install && npm run build && npm start` (Node 22).
- Add each Spark with **Add Spark** using its LAN IP and an SSH user. The machine running the dashboard does not need a GPU; skip adding it as a unit.
- An x86 Docker build is untested. Reports and PRs are welcome.

## Architecture

Design principle: **one Spark model, N instances**. Every unit is a record in `config/sparks.json` with a `kind` field (`spark` or `host`). The same `SparkMonitor`, `SystemCollector`, and `LlmProbe` code runs for all of them. Adding a unit is a config change, not a code change.

```txt
┌────────────────────── Docker container (sparkDash) ────────────────────────┐
│  Express (server/)                                                         │
│  ├─ config/sparks.json        Spark registry (API read/write)              │
│  ├─ SparkRegistry             load/persist Sparks; change events           │
│  ├─ SparkMonitor (per Spark)  collector + LLM probe + rate baselines       │
│  │   ├─ SystemCollector       local sysfs/proc OR remote SSH               │
│  │   └─ LlmProbe              HTTP to host:LLM_PORT, backend autodetect    │
│  ├─ REST /api/*                                                            │
│  └─ WebSocket /ws             snapshot stream to browsers                  │
│  React SPA (src/)  — Overview + per-Spark pages, themes, dialogs           │
└────────────────────────────────────────────────────────────────────────────┘
         │ SSH (key or sshpass)                    │ HTTP :8888
         ▼                                         ▼
    remote Spark(s)                         each Spark’s LLM server
```

### Data flow

```txt
Browser  ←→  WebSocket /ws   ←→  SparkMonitor.snapshot()  ←→  collectors
Browser  ←→  REST /api/*     ←→  SparkRegistry + SparkMonitor
```

Poll loops run in the background (even with no clients) so rate metrics — tokens/s, network bytes/s, disk I/O — stay correct.

---

## Tech stack

| Layer | Stack |
|-------|--------|
| Frontend | React 19, TypeScript, Vite 8, Tailwind CSS v4 |
| Backend | Node.js (ESM), Express 5, `ws` |
| Platform | The dashboard targets ARM64 — DGX Spark GB10 (Neoverse V2). Units it monitors can be Linux, macOS or Windows machines over SSH |
| Deploy | Docker multi-stage (arm64), Compose |
| Secrets | AES-256-GCM SSH password store |
| Ports | **5555** dashboard/API; **5173** Vite (dev only) |

---

## Repository layout

```txt
sparkDash/
├── src/                 React + TypeScript SPA
│   ├── api/             REST client + shared types
│   ├── components/      Overview, Spark pages, dialogs, UI primitives
│   ├── hooks/           WebSocket snapshot, routing
│   └── theme / CSS      Tailwind v4 + four themes
├── server/              Express + WebSocket (plain JS ESM)
│   ├── sparks/          SparkRegistry, SparkMonitor
│   ├── collectors/      SystemCollector, LlmProbe, ssh, RoCE, Windows (PowerShell)
│   ├── health/          HealthEvaluator (findings)
│   ├── energy/          Fleet energy tracker + monthly archive
│   ├── llmtokens/       Token ledger · events/ Activity log · metrics/ Unit history (GPU chart, Temps week, 48 h / 30 d tiers)
│   ├── llmlaunch/       Model launchers · tooleval/ Tool Eval Bench
│   ├── secretsStore.js  Encrypted password persistence
│   └── validate.js      Host/user validation (SSRF-minded)
├── config/              Runtime state (volume; secrets gitignored)
├── assets/              Logo (bolt.svg) and legacy media
├── .github/             README screenshot and Showcase video; image publish workflow
├── Dockerfile           Production multi-stage arm64
├── docker-compose.yml   Production
├── docker-compose.image.yml  Production from the published image
├── docker-compose.dev.yml
└── deploy.sh            Rebuild / recreate helpers
```

---

## REST API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sparks` | List Sparks (passwords redacted) |
| POST | `/api/sparks` | Add Spark and start its monitor |
| PATCH | `/api/sparks/:id` | Update Spark (hot-swap config) |
| DELETE | `/api/sparks/:id` | Remove Spark and drain monitor |
| PUT | `/api/sparks/order` | Persist tab order |
| GET | `/api/sparks/:id/metrics` | One-shot metrics snapshot |
| GET | `/api/fleet-energy` | Estimated fleet watts, rolling energy, coverage, and Wh/output-token |
| GET | `/api/fleet-energy/history` | Hourly / daily energy buckets for the Fleet energy page |
| GET/DELETE | `/api/fleet-energy/monthly` | Permanent per-UTC-month energy totals; `DELETE` needs `?month=YYYY-MM` or `?all=true&confirm=delete-all-history` |
| GET | `/api/llm-token-totals` · `/api/llm-token-totals/history` | Cumulative LLM tokens by model, and the hourly / daily history behind the Token totals page |
| GET | `/api/sparks/:id/gpu-history` | GPU utilization, temperature and power % (`windowMs`; up to 8 h at ~2 s resolution, up to 7 days at minute resolution from the long-retention store; parallel arrays) |
| GET | `/api/sparks/:id/history` | Bucketed unit history, `range=1h\|6h\|24h\|7d\|30d` (default `1h`): `points` of `{ t, <series>: { avg, max, min? } }` plus per-port `llm` series, at most ~500 points; `{ enabled: false }` while `metricsHistory` is off, `400` for another range |
| GET/POST | `/api/restart` | `GET` says whether the server can restart itself (Docker with a restart policy); `POST` shuts down cleanly so Docker starts it again |
| DELETE | `/api/events` · `/api/fleet-energy` | Clear Activity or Fleet energy: everything, or only entries older than `?olderThanMs=` |
| DELETE | `/api/llm-token-totals` | Reset Token totals (all Sparks, or one with `?sparkId=`) |
| GET | `/api/health` · `/api/auth/status` | Bind / auth mode, the running server's version; whether a token is required and accepted |
| GET · PUT · DELETE | `/api/sparks/:id/gpu-clock` | GPU clock cap on a Spark unit: status, apply (`maxMHz`, `persist`), remove (see [GPU clock cap](#gpu-clock-cap)) |
| POST | `/api/sparks/gpu-clock-all` | GPU clock cap on every Spark at once: `{ maxMHz, persist? }`, or `{ reset: true }`; one result per unit (see [GPU clock cap](#gpu-clock-cap)) |
| POST | `/api/sparks/:id/shutdown` · `/wake` · `/api/sparks/shutdown-all` · `/wake-all` | Power controls (see [Power controls](#power-controls-shutdown--wake-on-lan)) |
| POST | `/api/sparks/:id/refresh/:domain` | Re-poll one domain now (`storage` or `llm` only) |
| GET/POST/DELETE | `/api/sparks/:id/llm/showcase[/:sessionId]` | Prompt Showcase sessions |
| GET | `/api/events` | Fleet event log (`limit`, `sparkId`, `sinceId`, `beforeId`; 2000 kept) |
| GET/POST/PUT/DELETE | `/api/sparks/:id/llm-launchers[/:lid]` | Registered start.sh / stop.sh model launchers; `POST …/:lid/start` and `…/stop` run them, `GET …/jobs/:jobId` streams the shell output |
| GET/POST/DELETE | `/api/sparks/:id/tool-eval/…` | Tool Eval Bench on a Spark: `status`, `install`, `preview`, `probe`, `runs` (start / list / stream / attach / stop / refresh / `result` / delete); `GET /api/tool-eval/spec` serves the option spec |
| POST | `/api/sparks/test` | Ephemeral SSH + LLM (+ Comfy if enabled) test (no persist) |
| POST | `/api/sparks/:id/test` | Connectivity test (can save password) |
| POST | `/api/sparks/:id/comfy/cancel` | Cancel ComfyUI job by `promptId` |
| PUT | `/api/sparks/:id/password` | Save SSH password (works offline) |
| PUT | `/api/sparks/:id/disabled-devices` | Hide storage devices (hot) |
| PUT | `/api/sparks/:id/disabled-interfaces` | Hide network interfaces (hot) |
| PUT | `/api/sparks/:id/llm-ports` | Replace all LLM ports (hot) |
| POST | `/api/sparks/:id/llm-ports` | Add an LLM port (hot) |
| DELETE | `/api/sparks/:id/llm-ports/:port` | Remove an LLM port (hot) |
| PUT | `/api/sparks/:id/llm-port` | LLM port — backward-compat (hot) |
| GET | `/api/sparks/:id/llm/daily` | Daily busy decode/prefill tok/s (`port`, `days`) |
| POST | `/api/sparks/:id/llm/bench` | Start decode benchmark (202); poll/cancel/clear on the same path |
| POST | `/api/sparks/:id/llm/prefill-bench` | Start prefill + TTFT context sweep (202); poll/cancel/clear on the same path |
| POST | `/api/sparks/:id/llm/quality-bench` | Start quality suite (202); `GET` lists active / last / history summaries, `GET :benchId` returns a full run, `DELETE :benchId` cancels a run in flight (`409` once it has finished), `DELETE history/:benchId` removes one saved run, `DELETE` clears the history |
| GET | `/metrics` | Prometheus exposition (opt-in, see [Prometheus](#prometheus)) |
| GET | `/api/alerts` · `/api/alerts/config` | Firing, pending and recent alerts; rules and channels (URLs masked) — see [Alert notifications](#alert-notifications) |
| PUT/POST | `/api/alerts/config` · `/api/alerts/test` | Save rules and channels; send a test message (both `409` while notifications are off) |
| GET | `/api/settings` | Global settings |
| PUT | `/api/settings` | Update global settings |
| GET | `/api/apikeys/status` · `/api/apikeys/keys` · `/api/apikeys/keys/:id` | Read-only API keys views through the host bridge (opt-in, `404` while off; see [API Keys](#api-keys)) |
| WS | `/ws` | Real-time metrics stream |

There is no application authentication on the HTTP/WebSocket API. sparkDash therefore binds to loopback and refuses direct LAN binding. Use an SSH tunnel, authenticated TLS reverse proxy, or Tailscale Serve; see [Remote access](./docs/REMOTE-ACCESS.md).

`/api/fleet-energy` samples the configured fleet independently every two seconds. It estimates
each node as GPU board draw + a CPU utilization model (5.2–65 W) + 23 W of memory/network/base
overhead, clamped to the DGX Spark power envelope. Current and hourly fleet watts require fresh,
simultaneous telemetry from every node; coverage fields make gaps explicit. Minute buckets are
persisted at mode `0600` for rolling 24-hour and 31-day windows. Wh/output-token is computed from one observation per available LLM endpoint on each `head` or
`standalone` node (workers are skipped, since they front their head's engine).
These values are estimates, not wall-meter measurements. Restart sparkDash after changing fleet
membership so the persisted series has one stable node set.

Finished minutes are also rolled up once into a permanent monthly archive
(`config/fleet-energy-monthly.json`, read through `/api/fleet-energy/monthly`): per UTC month and
node watt-hours and coverage, the fleet total, output tokens and Wh/output-token. A minute is added
10 seconds after it ends, a stored watermark guarantees it is never counted twice, and the first
start backfills from the existing 31-day file. The archive is not touched by **Reset…**, restarts or
fleet membership changes (the previous scope's file is rolled up, after the same plausibility checks as a normal load, before it is set aside). Only
`DELETE /api/fleet-energy/monthly` removes months (all of them only with `confirm=delete-all-history`). A clock that jumps ahead cannot hide later
minutes: nothing is folded, and no watermark is kept, beyond the clock plus one day (a stored watermark
beyond that is clamped back on load, totals unchanged).

---

## Configuration

### Global settings (UI or API)

Gear icon in the header, or `GET`/`PUT` `/api/settings`:

| Setting | Default | Description |
|---------|---------|-------------|
| Refresh rate (`pollIntervalMs`) | 2000 ms | How often every unit is polled for GPU, CPU/RAM, network, memory bandwidth, LLM and ComfyUI metrics, and how often the dashboard is pushed an update (the dialog offers 1 s to 10 s; the server accepts 0.5 s to 60 s). Remote units are polled over SSH, so 1 s costs the most. Memory bandwidth (`nvidia-smi dmon`, which blocks ~1 s) never goes below 2 s. Storage, liveness, Tailnet, Hermes and the `NV_ERR` scan keep their own cadences. A `POLL_INTERVAL_*` env var, when set, pins its domain instead |
| Default LLM port | 8888 | Default for new Sparks |
| Hide offline Sparks | false | Hide offline Sparks on Overview |
| Hide worker nodes | false | Hide Worker-role Sparks from Overview and the tab bar |
| Temperature unit | Celsius | Display GPU temperature in °C or °F |
| Time zone | Browser | Hour and day boundaries and labels on the Tokens, Energy and Activity charts (IANA name such as `Europe/Paris`; empty follows each browser). Daily token buckets and monthly energy stay UTC |
| Benchmark share image | true | Decode/prefill **Copy results** becomes a split button: the label copies the text summary, the caret offers **Copy as text** / **Copy as image** on hover or click. Turn it off to keep the plain button. The image copies where the page has an image clipboard (HTTPS or localhost); over plain http on a LAN IP the card downloads instead |
| Detailed VRAM breakdown | true | The VRAM bar on the Overview cards and the GPU panel is split by what holds the memory — LLM engine (largest GPU process while an endpoint is serving), system/CPU (GB10 unified pool), other GPU use — over a free track, and turns amber/red on low free memory (GB10: under 8 / 4 GB; discrete GPU: under 2 / 1 GB) rather than on a high percentage. Hover or focus for the breakdown, including the engine's KV fill where the backend reports it. Turn it off for the single percentage bar |
| Show Fleet Energy | true | Overview card with rolling fleet power estimates (the Fleet energy page is always in the sidebar) |
| Electricity price / currency | not set / `$` | Per kWh, for the estimated cost on the Fleet energy page; empty hides cost |
| Show LLM Token Totals | true | Overview card with cumulative tokens per model |
| Show Recent activity | true | Overview card with the latest health and kernel events (the Activity page is always in the sidebar) |
| Show Fleet decode / Fleet power / Memory in use / Tokens in last 24 hours tile | true | Each of the four Overview tiles can be hidden on its own; the rest share the row (Tokens in last 24 hours also covers the Online count that replaces it when no tokens are tracked) |
| Show active fleet exceptions | false | Overview strip for offline units, throttling, disk and LLM alerts |
| Show search and status filters | false | Overview search field and status dropdown |
| Save benchmark debug traces | false | Store prompts, HTTP ids and GPU samples in bench history (larger files) |
| Prometheus metrics | false | Serve `GET /metrics` for Prometheus / Grafana (see [Prometheus](#prometheus)); `404` while off |
| Intel Arc VRAM via sudo (`intelVramSudo`) | false | Read exact Intel Arc VRAM use through `sudo -n cat` on pinned debugfs files (see [Intel Arc GPUs](#intel-arc-gpus)); off shows the PCI BAR size and runs no sudo |
| Metrics history (`metricsHistory`) | false | Keep 48 h of 1-minute and 30 days of 15-minute history per unit (GPU, memory headroom, CPU, RAM, network, LLM tok/s and KV) and show it in a History panel at the bottom of each unit's page (also `GET /api/sparks/:id/history`). The panel polls every 30 s only while it is on screen. Readings are gaps, not zeros, while a unit is offline or a collection is failed or older than 3 × the poll interval (at least 15 s). Stored in `config/metrics-history.json` (at most ~1 MB per unit, +~0.3 MB per LLM port), saved every 5 min and on shutdown; nothing is recorded or written while off |
| Alert notifications (`alertsEnabled`) | false | Notify ntfy / Discord / Slack / a webhook about Health findings and Overview exceptions (see [Alert notifications](#alert-notifications)); while off nothing is evaluated or sent |
| MQTT publishing | false | Publish the activity feed, per-unit availability and readings to an MQTT broker as they change (see [MQTT](#mqtt)); broker URL, username and topic prefix are set in the same dialog |
| API Keys page (`apiKeysEnabled`) | false | Read-only page of LiteLLM virtual keys through a host-side bridge (see [API Keys](#api-keys)); while off there is no navigation entry and `/api/apikeys/*` answers `404` |
| Session age (`occupancyMaxAgeMs`) | 12 hours | Hide harness sessions older than this. Settings offers 1 hour through 14 days. A missing or out-of-range value becomes 12 hours. There is no unlimited value |
| GPU temperature alerts (`healthTempWarnC`, `healthTempCriticalC`) | 85, 90 | °C at which the Health finding for a hot GPU warns and turns critical; Alert notifications use the same limits. Each is a number from 40 to 110 and the warning must be lower than critical, otherwise the save is refused (`400` from `PUT /api/settings`). The values apply to every unit and to NVIDIA cards only, as before |

### Harness sessions

Each LLM card can list sessions from OpenClaw, OpenCode, oh-my-pi, Hermes and DeepSeek Harness. One occupancy helper runs on the machine that has those tools. The dashboard does not open an ACP connection per session and does not spawn a bridge per poll. It stores the helper URL and bearer token, then reads that helper's cache.

Open the wizard from **Settings → Harness sessions**, the command palette (**Set up harness sessions**), or **+ Harness** on an empty LLM card. Pick the harnesses, the helper URL and token, and a route for each harness (Spark, port, optional directory prefix). **Check connection** reports coverage and a session count. It does not show session titles, install packages, or start an agent. If the helper rejects the token, the wizard says so. That response does not open the dashboard's own access-token dialog.

On the helper machine:

```bash
OCCUPANCY_BIND=127.0.0.1 \
OCCUPANCY_TOKEN="$(openssl rand -hex 32)" \
OCCUPANCY_ADAPTERS=openclaw,opencode,omp,hermes,dsh \
node scripts/occupancy-helper/index.js
```

`OCCUPANCY_ADAPTERS` lists only the harnesses you enabled. Hermes reads `HERMES_STATE_DIR` (it does not launch `hermes-acp`, because that list path can write). DeepSeek Harness reads `DSH_WEB_URL` (default `http://127.0.0.1:3080`). A helper bound to anything other than loopback requires `OCCUPANCY_TOKEN`, and it refuses `0.0.0.0` and `::`. A helper hostname that is not loopback must be listed in `SPARKDASH_HELPER_HOSTS`.

A missing ACP command marks that adapter unavailable while the helper keeps serving its cache. Adapter subprocesses keep their harness configuration but do not receive `OCCUPANCY_TOKEN`. ACP stdout frames are capped at 2,000,000 bytes, including unfinished lines; exceeding the cap closes that bridge and retains any previous rows as stale. Diagnostic RPC history retains only the latest 64 method names.

Bearer tokens are sent over HTTPS outside loopback; a plain HTTP helper resolving to a LAN or tailnet address is refused when a token is configured. Use an HTTPS endpoint for a remote helper. Loopback HTTP remains supported. Helper PUT and DELETE requests share a limit of 30 changes per minute per dashboard principal (or client IP without a principal).

DSH refreshes have one 8-second budget for headers, bodies and optional model lookups, with a 1 MB streamed response cap per RPC. A stalled private adapter cannot hold another adapter's refresh guard. Closing the helper cancels private reads. Hermes reports an absent session store as unavailable, accepts a real empty store, and reads its SQLite fallback asynchronously with a bounded subprocess. ACP cleanup sends SIGTERM to its owned process group and escalates to SIGKILL after 250 ms.

Each dashboard helper request has an 8-second deadline, including its response body. Disconnects, oversized responses and malformed occupancy replies fail that helper's refresh. Replies must carry the helper's existing version-1 envelope (`schemaVersion`, numeric `observedAt`, `adapters`, and `rows`). Dashboard snapshots use cached helper configuration; a corrupt config keeps the last valid configuration until repaired, logs a warning, and cannot be overwritten through helper mutations.

ACP rows are metadata only: they can look recent, and they are never labeled Generating or Stalled. Those labels are reserved for Hermes and DeepSeek Harness when the adapter itself reports a running session. A row with no timestamp stays in the list and stays unlabeled. Sessions with no matching route stay off the cards.

### Environment variables

Copy `.env.example` to `.env` if needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `BIND_HOST` | `127.0.0.1` | HTTP and WebSocket listen address. A non-loopback bind without `SPARKDASH_TOKEN` is open to anyone who can reach it (see `SPARKDASH_ALLOW_OPEN_REMOTE`). |
| `SPARKDASH_TOKEN` | _(empty)_ | Bearer token. When set, it is required for every mutation and WebSocket connection, and for REST reads on a non-loopback bind. The browser prompts for it when needed (Settings → Access token to change it). |
| `SPARKDASH_ALLOW_OPEN_REMOTE` | `1` | Unset, empty, or `1`: a non-loopback bind without `SPARKDASH_TOKEN` stays open. `0`: refuse to start without a token (fail closed). |
| `SPARKDASH_ALLOWED_HOSTS` | _(empty)_ | Only for a reverse proxy on a custom domain: comma-separated names a loopback bind should also answer to. `localhost`, IP addresses, this machine's hostname and its Tailscale name work without it. |
| `SPARKDASH_MQTT_PASSWORD` | _(empty)_ | Password for the MQTT broker configured in Settings → MQTT (the URL and username live in `settings.json`). Read once at startup. |
| `SPARKDASH_APIKEYS_BRIDGE_SOCKET` | _(empty)_ | Unix socket of the API keys bridge (see [API Keys](#api-keys)). Read once at startup. |
| `SPARKDASH_APIKEYS_BRIDGE_TOKEN` | _(empty)_ | Token sent to the API keys bridge; never stored in `settings.json`. Read once at startup. |
| `SPARKDASH_HELPER_HOSTS` | _(empty)_ | Extra hostnames allowed for harness occupancy helpers, comma separated. `localhost`, `127.0.0.1` and `::1` are always allowed. The dashboard connects only to an address from that lookup and does not follow redirects |
| `OCCUPANCY_POLL_MS` | `15000` | How often the dashboard reads each helper's cache. Clamped to 5–120 seconds |
| `PORT` | `5555` | HTTP + WebSocket listen port |
| `LLM_PORT` | `8888` | Default LLM probe port |
| `COMFY_PORT` | `8188` | Default ComfyUI probe port |
| `POLL_INTERVAL_GPU` | _(setting)_ | GPU poll (ms). Unset: follows **Settings → Refresh rate**; set: pins GPU polling regardless of the setting |
| `POLL_INTERVAL_COMFY` | _(setting)_ | ComfyUI probe poll (ms); same rule |
| `POLL_INTERVAL_CPU` | _(setting)_ | CPU / RAM poll (ms); same rule |
| `POLL_INTERVAL_NETWORK` | _(setting)_ | Network poll (ms); same rule |
| `POLL_INTERVAL_STORAGE` | `5000` | Storage poll (ms): disk usage and the read/write speed on the Storage panel |
| `POLL_INTERVAL_LLM` | _(setting)_ | LLM probe poll (ms); same rule |
| `POLL_INTERVAL_BANDWIDTH` | _(setting, ≥ 2000)_ | Memory bandwidth / dmon poll (ms); same rule, and when it follows the setting it never drops below 2000 |
| `POLL_INTERVAL_HERMES` | `600000` | Hermes Agent update check poll (ms) |
| `POLL_INTERVAL_TAILSCALE` | `30000` | Tailnet probe poll (ms) |
| `TAILSCALE_PROBE_TIMEOUT_MS` | `8000` | Timeout for `tailscale status --json` (ms) |
| `POLL_INTERVAL_NVERR` | `60000` | Incremental kernel journal reads for NV_ERR, Xid and OOM counters (ms), after the initial backfill |
| `HERMES_UPDATE_TIMEOUT_MS` | `600000` | Hard timeout for running `hermes update` over SSH (ms) |
| `POLL_INTERVAL_LIVENESS` | `5000` | Online/SSH liveness check (ms) |
| `SPARKDASH_SECRETS_KEY` | _(auto)_ | Passphrase or 64-char hex for secret encryption |
| `HOST_PROC_PATH` | `/host/proc` | Host proc mount inside container |
| `HOST_SYS_PATH` | `/host/sys` | Host sys mount |
| `HOST_ROOT_PATH` | `/host/root` | Host root mount |
| `SSH_IDENTITY_FILE` | _(unset)_ | Path **inside the process** to a private key (`ssh -i`). Use when the bind-mount is not a default OpenSSH name. |
| `MACMON_PATH` | _(unset)_ | macOS units: path to [macmon](https://github.com/vladkens/macmon) on the Mac, when it is not in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin` or the SSH PATH. macmon (no sudo) supplies CPU / GPU usage, temperatures, RAM and system power for Mac units. |
| `SSH_CONTROL_PERSIST_SECONDS` | `60` | Idle SSH transport persistence in seconds, capped at `3600`. Set to `0` to disable multiplexing. |
| `MAX_ACTIVE_BENCH_JOBS` | `2` | Benchmarks (decode, prefill, quality) that may run at the same time across the whole fleet; each unit still runs one at a time. Clamped to 1–32. A start above the cap is refused with 429. Docker compose passes it through; set it in `.env`. |
| `FLEET_ENERGY_JSON_PATH` | `config/fleet-energy.json` | Rolling fleet-energy persistence path |
| `FLEET_ENERGY_MONTHLY_JSON_PATH` | `config/fleet-energy-monthly.json` | Permanent monthly energy archive |
| `GPU_HISTORY_JSON_PATH` | `config/gpu-history.json` | 8 h GPU chart history |
| `GPU_HISTORY_LONG_JSON_PATH` | `config/gpu-history-long.json` | 7-day minute-resolution GPU history (Temps page) |
| `METRICS_HISTORY_JSON_PATH` | `config/metrics-history.json` | 48 h / 30 d unit history (only with `metricsHistory` on) |
| `ALERTS_JSON_PATH` | `config/alerts.json` | Alert rule switches, channel settings (no URLs) and the firing set |
| `MODEL_PRICES_FETCH` | `0` | **Cost compare**: when `1`, the server refreshes the hosted-model price catalog once a day from `raw.githubusercontent.com` (the community litellm list). Opt-in so an install never phones out unasked; while off, the Cost compare page serves the last catalog on disk and makes no requests |
| `MODEL_PRICES_JSON_PATH` | `config/model-prices.json` | **Cost compare**: where the last good price catalog is persisted (the offline / opt-out fallback). Pre-seed it to use the page with `MODEL_PRICES_FETCH` off |

For compatibility, `SSH_CONTROL_PERSIST` is accepted as a seconds-based fallback when `SSH_CONTROL_PERSIST_SECONDS` is unset. The existing `SSH_MULTIPLEX=0` switch also disables reuse. SSH tunnels always use an independent connection.

> The listener and both Compose files default to `127.0.0.1`. Existing Docker users who opened
> `http://<host-ip>:5555` must migrate to an SSH tunnel, authenticated reverse proxy, Tailscale
> Serve, or `BIND_HOST=0.0.0.0 SPARKDASH_TOKEN=...` (without the token a `0.0.0.0` bind is open to the
> network unless `SPARKDASH_ALLOW_OPEN_REMOTE=0`). Recovery:
> `BIND_HOST=127.0.0.1 docker compose up -d --force-recreate`.

### Adding a unit

1. Click **+** next to *Sparks* in the sidebar (or **Add Spark / GPU host** in the Sparks menu on a phone).
2. Choose **Unit type**:
   - **NVIDIA DGX Spark** — the default; hardware summary shows DGX Spark specs and the CX7 IP field is available.
   - **Dedicated GPU host** — any Linux machine with an NVIDIA GPU. It is monitored exactly like a Spark (SSH + `nvidia-smi`) but is **not** reported as a DGX Spark: the header shows a detected hardware summary (GPU model, CPU, RAM) instead of fixed GB10 specs, and the page shows separate **RAM** and **VRAM** panels (VRAM from `nvidia-smi`, RAM from system memory). On the unit page, RAM → Network → Storage stack in the right column with GPU filling the left column. A host with **more than one GPU** needs nothing extra: every card `nvidia-smi` lists is collected, the header names them all, the GPU panel shows a block per card, and `metrics.gpu` stays the aggregate (hottest / busiest card, summed power and VRAM) with the per-card detail under `gpu.gpus[]`.
   - **Windows PC with an NVIDIA GPU** — a Windows machine with the OpenSSH Server and the NVIDIA driver; see [Windows PCs](#windows-pcs). Always a remote unit; no model launchers, CPU temperature or Hermes / Tailnet checks.
3. Set **Name** and choose whether this is **This host**. Local units do not require a LAN IP or SSH; their optional LAN IP enables browser links. On a dedicated GPU host it also directs Wake-on-LAN. Remote units require a LAN IP/host, SSH user, and key or password. Key auth in Docker needs a key mounted into the container (see Quick start).
   - **LLM host** (optional, `llmHost` in the unit's config): when the model API listens on one specific address of a multi-interface Spark, pin it here; probes and benchmarks then use it instead of the LAN IP (SSH keeps using the SSH host). An unreachable `llmHost` is never tunnelled to the SSH host's loopback.
4. **Test** shows pass/fail/skipped for host collectors/SSH and each enabled service (LLM, ComfyUI, Hermes Agent, Tailnet). Every enabled capability must pass; disable an unavailable optional service before saving if it should not be monitored.
5. Save — a tab appears and metrics start streaming.

### When an engine moves to another node

Head and worker roles are configured, not discovered: a worker is never probed for LLM endpoints, and a head is always monitored. If a tensor-parallel recipe moves rank 0 and its API to the former worker, edit the units so the API-serving node is the Head, update the other node to Worker and its head link, and verify the Head's LLM ports. Token totals resume from newly observed counters; traffic during the unmonitored period cannot be reconstructed. sparkDash does not currently detect this role mismatch or automatically follow the engine.

### Loaded models in private containers

Overview lists all models returned by the configured, reachable LLM endpoints.
For remote Linux units with LLM monitoring on (never workers), it also checks running Docker containers whose image name
contains `vllm`, every 30 seconds over the existing SSH connection. It reads
`/v1/models` on each container's private network address and configured `--port`
(default 8000), without publishing ports or sending inference requests.

This optional discovery requires Python 3 and existing permission to read Docker
state on the remote unit. At most 20 containers and 50 models are read, within a few
seconds; a failed check keeps the previous list for about 90 seconds before clearing it.
Local, macOS and Windows units are skipped. Additional models are
labelled **Loaded**. Throughput, benchmarks and token totals still apply to the
configured LLM endpoints; discovery does not add a monitored endpoint. Offline
units do not display stale discovered models.

### Power controls (shutdown / Wake-on-LAN)

- **Shutdown** (per Spark or **Shutdown All** on Overview) runs the host helper
  `/usr/local/bin/spark-shutdown` with passwordless sudo. The helper contract is
  two invocations:

  | Invocation | Expected behaviour |
  |------------|--------------------|
  | `spark-shutdown` | Schedule the graceful shutdown |
  | `spark-shutdown --check` | Print an acknowledgement, exit 0, change nothing |

  `--check` is what proves authorization before anything is scheduled, so a
  sudoers rule scoped to the helper is enough:

  ```
  sparky ALL=(root) NOPASSWD: /usr/local/bin/spark-shutdown
  ```

  A helper without `--check` still works when sudo is granted more broadly (the
  authorization probe falls back to `sudo -n true`), but a rule limited to the
  helper path needs `--check` support.
- On a **local unit**, the helper runs on the Spark itself. When the dashboard
  is in Docker that means the invocation first enters the host mount namespace
  (`nsenter --mount=/host/proc/1/ns/mnt -- sudo -n …`), using the same
  `HOST_PROC_PATH` mount and `privileged: true` the collectors already need. A
  bare-host install calls `sudo` directly. The helper always resolves against
  the **host** filesystem, so it does not need to exist inside the container.
- **Wake** / **Wake All** send a UDP magic packet (port 9) to **dedicated GPU hosts** whose NIC and firmware support Wake-on-LAN. The MAC is taken from the **enP7s7** interface while the host is online (persisted as `detectedMacAddress`), or from a **MAC override** in Edit Spark. Broadcast is derived as `/24` from LAN IP, or `255.255.255.255` if LAN IP is missing. **DGX Spark does not wake this way** — the GB10 onboard NIC has no Wake-on-LAN — so the Wake control is not offered on Spark units.
- On a **Windows PC** shutdown runs `shutdown.exe /s /t 5` over SSH; Wake-on-LAN needs a MAC address entered by hand.
- Batch shutdown only targets **online** Sparks; offline nodes are skipped.
- Power APIs are mutations: with `SPARKDASH_TOKEN` set they require it; without it they are open on loopback (local trust) **and** on a remote bind, unless `SPARKDASH_ALLOW_OPEN_REMOTE=0` makes that bind fail closed.

### Themes

Choose a theme in **Settings → Appearance** (or the sun / moon button in the sidebar):

| Theme | Notes |
|-------|--------|
| **Dark** (default) | Neutral grays, true black base, muted amber accent |
| **Light** | Warm paper whites |
| **White** | Cool neutral whites |
| **OLED** | True black for OLED panels |

Choice is stored in `localStorage`.

---

## Security

- **SSH passwords** are not stored in `sparks.json` and are never returned by the API.
- Passwords are encrypted with **AES-256-GCM** in `config/sparks-secrets.json` (survives restarts).
- Encryption key: `config/.secrets-key` (auto-generated) or `SPARKDASH_SECRETS_KEY`. **Do not delete the key file** or encrypted secrets become unreadable.
- **Target validation** rejects clearly unsafe IPv4 targets (link-local `169.254.0.0/16`, `0.0.0.0/8`, multicast/reserved ≥ 224). Private, loopback, and public addresses are allowed so LAN and remote Sparks work.
- SSH and HTTP probes use short timeouts (about 5 s SSH connect, 3 s HTTP) so a hung host cannot stall the poll loop.
- Prefer **SSH keys** over passwords. In Docker, mount the private key into `/root/.ssh` (see Quick start); passwords are the only SSH secret the app stores itself.
- Loopback installs remain local-trust. A remote bind (`BIND_HOST` not loopback) **without** `SPARKDASH_TOKEN` is open by default: anyone who can reach the port can read telemetry, change settings and power units off, and the header shows an **Open access** warning (dismissible per browser). Set `SPARKDASH_TOKEN` to require a bearer token for mutations and remote telemetry/WebSocket, and `SPARKDASH_ALLOW_OPEN_REMOTE=0` to refuse to start a remote bind without one. `GET /api/health` reports which applies as `authMode`: `loopback-open`, `bearer`, `open-remote`, or `required-missing`.
- One-off remote benchmark hosts must be listed in `SPARKDASH_BENCH_HOSTS`.
- Tested operator capacity for this remediation: **12 units**.


---

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Vite (5173) + Express (5555) together |
| `npm run dev:server` | Express only (`node --watch`) |
| `npm run dev:client` | Vite only |
| `npm run build` | Production frontend → `dist/` |
| `npm run build:watch` | Rebuild `dist/` on every save |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Server tests (`node --test`) and frontend tests (`vitest`); also `npm run test:server` / `test:frontend` |
| `npm start` | Production server (`node server/index.js`) |
| `npm run docker:up` | `docker compose up -d` |
| `npm run docker:prod` | Same as `docker:up` |
| `npm run docker:rebuild` | `docker compose up --build -d` |
| `npm run docker:multiarch` | Build the arm64 + amd64 variants into one manifest list |
| `npm run docker:dev` | Dev Compose |
| `npm run docker:dev:build` | Dev Compose with rebuild |
| `./deploy.sh` | Recreate container; `--build`, `--frontend` flags |

---

## How it works

### Local vs remote Sparks

One `SystemCollector` path for both modes. When `spark.isLocal` is true, metrics come from host sysfs/proc and `nvidia-smi` (often via nsenter into the host namespace). Remote Sparks wrap the same commands in a shared `sshExec()` helper (key agent or `sshpass`). The helper reuses an authenticated OpenSSH transport by default so frequent metric polls do not create a new SSH/PAM login lifecycle each time. Set `SSH_CONTROL_PERSIST_SECONDS=0` to disable reuse. For `kind: "host"` units, actual hardware (GPU model, driver version, CPU, RAM) is detected once and cached in place of the static DGX Spark specs, and GPU VRAM comes straight from `nvidia-smi` while system RAM is read from `/proc/meminfo`.

### Remote SSH sessions and host memory

Older sparkDash versions could create hundreds of SSH/PAM login sessions per minute on each remote host. [Issue #73](https://github.com/MiaAI-Lab/sparkDash/issues/73) documents the resulting session churn and observed `polkitd` memory growth. Connection reuse reduces this churn while retaining the collector refresh cadence. After updating, verify that metrics keep advancing and that new SSH authentications/PAM session opens fall after the initial connection; a new SSH client process for each collector command is still expected.

If host memory remains low, compare Linux `MemAvailable` and per-process resident/swap usage. Memory retained by `polkitd` requires separate OS investigation: [polkit PR #653](https://github.com/polkit-org/polkit/pull/653) fixes a reference leak in `NoNewPrivileges` queries. Check whether your distribution's polkit package includes that fix. SSH reuse neither applies the OS patch nor releases memory already retained by another process.

### Health findings

`server/health/HealthEvaluator.js` runs a handful of rules over metrics sparkDash already collects, once per Spark, and reports them as `health[]` on the unit's snapshot. A rule never guesses: a missing metric raises nothing. Findings carry a severity, a detail and a hint, show up as chips on the Overview cards and in full on the unit page, and the monitor writes an Activity event when one appears or clears (never for the first baseline after a restart). The kernel NV_ERR / Xid / OOM counters share one cached journal cursor. Reads process at most 10,000 records and have a host-side 3-second hard timeout, including over SSH. Initial history is backfilled one page per 10 seconds (when polled); counters remain unknown until the baseline is complete. Later reads resume after the cursor at `POLL_INTERVAL_NVERR` cadence rather than scanning the whole boot journal again. Failed reads retain the last complete reading and retry after that interval.

### Windows units

A unit with `platform: "windows"` is reached over the same SSH helper, but every command is a PowerShell script sent as `-EncodedCommand` (so it works whatever the OpenSSH server's default shell is). Two scripts per poll cover the GPU (`nvidia-smi`, or the GPU Engine/Adapter Memory performance counters on an AMD iGPU) and the CIM classes for RAM, CPU load, disks and adapters; their output is parsed into the same shapes the Linux collectors return. See [Windows PCs](#windows-pcs).

### Graceful degradation

Collectors catch errors and return zero/default metrics instead of crashing the loop. After sustained liveness failures, a Spark is marked offline; the UI shows stale or empty states rather than hard errors.

### Hot configuration

Name, IP, SSH credentials, LLM port, and device/interface filters update the running `SparkMonitor` without tearing down poll loops or losing rate baselines. Registry writes are atomic (temp file + rename).

### LLM probe

Each configured LLM port gets its own `LlmProbe` instance running in parallel. Probes auto-detect backends:

- **llama.cpp** — `/slots` for live decode rates; model from `/props`
- **ds4-server** (Entrpi/ds4-on-spark) — `/v1/models` (`owned_by: ds4.c`) + Prometheus `ds4_*` token counters for live tok/s
- **EXL3** (ExLlamaV3 `tools/serve_openai.py`) — `/v1/models` (`owned_by: exl3`) or `/health` `{ok, busy}`; live tok/s from `/health` cumulative counters
- **Flare** (NVIDIA flare-local-inference) — `/v1/models` card with a `flare` object; live tok/s from `flare_generated_tokens_total` / `flare_prefill_tokens_total` counter diffs, cached vs uncached prefill from `flare_cache_reused_tokens_total`, slots, queue, preemptions and KV pool from `flare_*` gauges
- **q27** (signalnine/q27 engine) — `/v1/models` (`owned_by: q27`) or Prometheus `q27_*` series; live tok/s from `q27_*_processed` counter diffs (completion-based totals as fallback), exact computed-only prefill with the cached/uncached split doubling as the prefix-cache hit rate, TTFT/E2E/ITL p95 histograms, and constant-0 preemptions (FIFO admission, no wait queue)
- **TensorFold** (ashhart/TensorFold) — `/v1/models` (`owned_by: tensorfold`). No `/metrics`. Live tok/s comes from `/health` when it publishes `prompt_tokens_total`, `completion_tokens_total`, and `prefill_seconds_total` (decode is the completion-counter diff; prefill is prompt tokens ÷ prefill time). The slots tile reads `streams.max` and `requests_running` on CUDA 0.6.0, and `max_batch_size` on MLX. A stock server that only returns `{ok: true}` stays at 0. Decode/prefill benches and the showcase work regardless.
- **FreeToken** — `/v1/models` (`owned_by: FreeToken`), or a `/v1/stats` document with `throughput.decode_tps` / `prefill_tps` and lifetime prompt/completion totals. Those rates are FreeToken's own 5-second window (0 when idle). `requests.ttft_mean_ms` is a mean; `requests.p95_ms` is end-to-end latency, not TTFT p95. Queue length, slot capacity, and preemptions stay unset.
- **vLLM / sglang** — `/v1/models`; sglang via `/server_info` (`last_gen_throughput` when metrics off; `/get_server_info` fallback), vLLM via Prometheus `/metrics` counters (scientific notation supported)

Rates are derived from per-probe cumulative counter diffs (or SGLang sticky throughput while it moves). Multiple ports can be added or removed at runtime without restarting the monitor.

Live probes use the LAN IP on remote units, and fall back to an SSH forward to the unit's loopback after two failed direct probes (the LLM panel then shows a **via SSH** chip). **Decode, prefill and quality benches** try that same HTTP target first; if it is closed they open an SSH local-forward onto the remote’s `127.0.0.1` so loopback-bound servers (ds4 `start.sh` default) can still be measured. The tunnel is torn down when the job finishes or is cancelled.

---

## Optional inference request activity

For shared inference deployments, an optional Overview card groups in-flight requests and recent completions by approved **display labels**. It is disabled by default and makes no source requests until configured. The gateway must already expose sanitized JSON; sparkDash does not intercept inference, handle client API keys or infer their owners.

Set these variables in the **server's environment**, then restart sparkDash:

```dotenv
SPARKDASH_INFERENCE_ACTIVITY_URL=http://127.0.0.1:9001/activity
SPARKDASH_INFERENCE_ACTIVITY_LABELS=service-a,user-1
```

The URL accepts HTTP/S with an explicit loopback or RFC1918 IP literal only; DNS names, public/link-local targets, credentials, queries, fragments and redirects are rejected. Requests carry no source credentials, time out after 5 seconds and read at most 64 KiB. There is no browser-editable URL or API-key mapping. These labels are visible to anyone allowed to view the dashboard: protect the dashboard with its normal authentication or private access, and **never configure a key, token, IP, email or prompt as a label**.

The source must return `application/json` with this shape:

```json
{
  "available": true,
  "generatedAt": "2026-10-11T12:00:00Z",
  "active": [
    {"principal": "service-a", "model": "model-a", "count": 2,
     "oldestAgeMs": 900, "newestAgeMs": 100}
  ],
  "recent": [
    {"principal": "user-1", "model": "model-a", "durationMs": 400, "ageMs": 1000}
  ],
  "overflowed": false
}
```

`generatedAt` is the source sampling time, refreshed by the source on each sample. Both arrays are required. The first 256 active input rows are normalized and grouped by principal/model: duplicate groups sum counts, take the maximum oldest age and minimum newest age. Counts are independently positive safe integers, not limited to 256; an unsafe individual count or combined total makes the sample unavailable. Truncated input is marked incomplete. Snake-case `oldest_age_ms`/`newest_age_ms` are also accepted. Principals not in the configured label list become `unknown`; model labels are optional non-secret identifiers. URL/IP labels and recognizable credential-like model segments become `unknown`, but this is not a general secret detector: the source must never place credentials or user content in metadata. Recent rows may provide an actual HTTP `status`, otherwise no status is invented. At most 24 recent rows are retained in memory, with a 10-minute recent window and bounded non-negative ages/durations. Extra fields—including keys, headers, IPs, request IDs and prompts—are discarded, not persisted. Source bodies, failures and URLs are not logged or returned by the dashboard API.

The source is read at most once per 5 seconds, shared between dashboard viewers. The server judges sample freshness: samples older than 30 seconds, invalid payloads and failed reads show **unknown**, not zero. The browser trusts the server's `available`, without comparing server timestamps to its own clock. A separate 30-second no-response timer hides the last live display if a later browser fetch hangs, and resets on a successful response. A fresh empty `active` array is a measured zero. The read-only `/api/inference/activity` route uses the dashboard's existing GET access policy and `Cache-Control: no-store`: loopback GETs remain open, while a token-protected remote bind requires the dashboard token. Configuration is not writable through that route or Settings. The card is absent when no URL is configured, including when the normal sidebar cards are hidden.

**In flight includes queued, prefill and decoding HTTP requests.** It is not the number of active GPU slots, does not distinguish engine queueing, and does not measure per-key token throughput. This card needs an external sanitized activity source; an unmodified model server without that source remains unchanged.

## Contributing

Contributions are welcome. Conventions:

- **Server**: plain JavaScript ESM
- **Client**: TypeScript + React
- Prefer extending the shared Spark model over per-unit special cases
- Run `npm test` and `npm run typecheck` before a pull request. Tests that start the server must point every config file at a temp directory (`server/__tests__/isolatedEnv.js`)
- Read [AGENTS.md](./AGENTS.md) and [CODEBASE.md](./CODEBASE.md) first

### Interface language

Settings → Language switches immediately between English and 简体中文, remembers the choice in this browser (`sparkdash-locale`) and updates `<html lang>`. It applies without Save and preserves pending settings edits. A supported stored preference takes precedence over the browser language; unsupported languages fall back to English. Simplified Chinese tags and the earlier `zh-Hans` preference map to `zh-CN`; Traditional Chinese is not supported yet. Switching still works for the current page when browser storage is blocked.

This foundation translates Settings and its embedded browser-alert controls. Navigation, other pages, the separate Alerts dialog, access-token prompt and raw server diagnostics remain English for later page-sized changes. Server settings and other users' language preferences are unaffected.

`src/i18n/index.ts` owns one i18next/react-i18next instance, initialized by `src/main.tsx` before React mounts. The small `language` and `settings` catalogs are bundled eagerly. English JSON in `src/locales/en/` is the source of truth and fallback; `src/locales/zh-CN/` mirrors each page or namespace. Add future namespace imports and resources to this same loader.

Use `const { t } = useTranslation("settings")` with static keys such as `t("dialog.save")`. Add the English entry first, then its translation. Use plain i18next interpolation (`"Hello, {{name}}"`) and ordinary plural keys (`items_one` / `items_other` with a numeric `count`); there is no ICU plugin or `intl-messageformat`. React escapes rendered text. Keep IDs, settings values and raw diagnostics separate from display text, and store stable message reasons rather than translated strings so feedback updates on language changes.

`npm test` runs `npm run i18n:check` and the checker's regression fixtures before the server and frontend suites. The AST check validates wired keys against English catalogs, including missing keys/catalogs, duplicate JSON keys, orphan Chinese keys and interpolation mismatches. Use static hook namespaces and distinct `t` aliases for multiple namespaces; dynamic or ambiguous calls, inline defaults and direct `i18n.t()` calls are rejected. The checker does not measure untranslated text coverage. Per-call namespace overrides (`t("key", { ns })`) and `<Trans>` are not checked yet; keep this foundation's static-hook pattern until those forms have coverage.

The two direct build dependencies are exactly pinned: `i18next@26.4.2` (published 2026-09-03) and `react-i18next@17.0.15` (2026-09-21), both more than two weeks old when submitted. Their new transitive packages are `@babel/runtime@7.29.7`, `html-parse-stringify@4.0.1` and `use-sync-external-store@1.7.0`; a scoped override holds the first at its reviewed version. The lockfile leaves existing resolutions unchanged. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for licenses. The checker currently uses `rolldown/parseAst` supplied transitively by Vite, so validate that import when changing the build dependencies.

Validate with a supported Node release such as 22.23.2: `npm ci`, `npm test`, `npm run typecheck` and `npm run build`. The server suite needs native Linux/POSIX tools, Python 3.11+ and Git; install zsh to exercise the login-shell probe. In a browser, check Settings at desktop and phone sizes, switch English → 简体中文 → English, reload, check accessible labels and horizontal overflow, and verify a pending setting survives a language switch and Save. Use synthetic data for writes.

---

## License

[Apache License 2.0](./LICENSE) from version 2.0.0 onward. Copyright 2026 Mia's AI Lab. See [NOTICE](./NOTICE).

Versions up to 1.9.0 were released under the MIT License ([LICENSE-MIT](./LICENSE-MIT)), and those releases stay MIT-licensed.

---

## Acknowledgements

sparkDash is built and maintained by [Mia's AI Lab](https://mia-ai.net/).

**Contributors.** Thank you to everyone who sent code, fixes and ideas:
[@MikeGibbsOnyx](https://github.com/MikeGibbsOnyx), [@Lesilva](https://github.com/Lesilva), [@vincenzopalazzo](https://github.com/vincenzopalazzo), [@Acermax](https://github.com/Acermax), [@danielkuykendall23-boop](https://github.com/danielkuykendall23-boop), [@0xdfi](https://github.com/0xdfi), [@BHCC2025](https://github.com/BHCC2025), [@ayylemao](https://github.com/ayylemao), [@SashaMIT](https://github.com/SashaMIT), [@krunkosaurus](https://github.com/krunkosaurus), [@andrei-dotdna](https://github.com/andrei-dotdna), [@0xWhiteMage](https://github.com/0xWhiteMage), [@kesslerio](https://github.com/kesslerio), [@nkavassalis](https://github.com/nkavassalis), [@Olyno](https://github.com/Olyno), [@willy92wins](https://github.com/willy92wins) and [@saitakarcesme](https://github.com/saitakarcesme), plus Nyx Voss (who wrote the macOS collectors with C. Michael Gibbs, @MikeGibbsOnyx), Liao Shiwu and Philip Eriksson, and to everyone who reported issues. The full list is on the [contributors page](https://github.com/MiaAI-Lab/sparkDash/graphs/contributors).
The [`sparkdash-dgx-cluster`](https://github.com/glanceapp/community-widgets/tree/main/widgets/sparkdash-dgx-cluster) Glance widget was contributed by [@linxichen](https://github.com/linxichen).

**Projects and data sparkDash builds on**
- [tool-eval-bench](https://github.com/SeraphimSerapis/tool-eval-bench) by SeraphimSerapis (MIT) powers **Tool Eval Bench**. It adapts the scenario methodology of ToolCall-15 by stevibe (MIT) and credits the Typed Decisions dataset from the LocalLLaMA organization (Apache 2.0).
- **GSM8K** (OpenAI, MIT) and **MMLU** (Dan Hendrycks, MIT) supply the maths and knowledge questions in the Quality bench. The instruction-following category is inspired by **IFEval** (Zhou et al., Google).
- [Hermes Agent](https://github.com/nousresearch/hermes-agent) by Nous Research can be monitored and updated from sparkDash.
- The health findings were inspired by [spark-doctor](https://github.com/joeynyc/spark-doctor) by joeynyc (MIT). No code from it is used.
- Fonts: [Geist and Geist Mono](https://github.com/vercel/geist-font) by Vercel (SIL Open Font License 1.1). The bolt in the logo follows the "zap" icon from [Feather](https://github.com/feathericons/feather) (MIT).
- Built with [React](https://react.dev/), [Vite](https://vitejs.dev/), [Tailwind CSS](https://tailwindcss.com/), [Express](https://expressjs.com/), [ws](https://github.com/websockets/ws), [undici](https://github.com/nodejs/undici), [dnd kit](https://dndkit.com/) and [dotenv](https://github.com/motdotla/dotenv). Licenses and copyright notices are in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

Built for the **NVIDIA DGX Spark (GB10)** on ARM64.

### Cost compare without a price catalog

On a fresh install, Cost compare shows **No price data yet** until a catalog is supplied. Catalog fetching is off by default: set `MODEL_PRICES_FETCH=1` and restart the server to opt in, or pre-seed `MODEL_PRICES_JSON_PATH` for offline use, then click **Retry**. A failed enabled fetch remains an error unless a cached catalog is available. Choose a hosted model explicitly to compare costs; the page does not infer a provider from local model names.

### Interpreting RoCE traffic

The RoCE panel shows netdev byte-counter rates, which do not measure RDMA payload throughput; a busy tensor-parallel link can therefore show little netdev traffic. Pause-frame counters are cumulative totals and are separate from the current PFC setting. RDMA error counters and their deltas remain available in the panel.
