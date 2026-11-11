# Codebase overview

sparkDash monitors a fleet of NVIDIA DGX Sparks and other supported hosts. Every configured unit has one registry entry and a shared `SparkMonitor` instance; hardware and LLM collectors are parameterized by that unit. Local collectors read host metrics, while remote collectors use SSH or the platform-specific collection paths.

## Stack and entry points

The package uses ESM throughout. `server/index.js` runs directly in Node and creates the Express HTTP server, API and WebSocket service. `src/main.tsx` starts the React application; `src/App.tsx` owns navigation and dialogs. Frontend TypeScript is bundled by Vite with Tailwind CSS v4. Package versions and executable scripts are defined in `package.json` and `package-lock.json`.

## Main paths

| Path | Responsibility |
| --- | --- |
| `server/sparks/` | Persistent unit registry and independent poll loops |
| `server/collectors/` | Hardware, platform-specific probes, LLM detection, streaming, benchmarks and Showcase |
| `server/auth.js`, `server/validate.js` | Incoming access checks and configured-target validation |
| `server/secretsStore.js`, `server/settings.js` | Encrypted credentials and ordinary persistent settings |
| `server/metrics/`, `server/llmtokens/`, `server/energy/` | Metric histories, token accounting and fleet energy |
| `server/powermeter/` | Opt-in external power meters: provider base class and registry, polling, reconciliation with the meter's own history. Wall power is recorded by `server/energy/` (docs/POWER-METERS.md) |
| `server/health/`, `server/alerts/`, `server/events/` | Findings, optional notifications and bounded activity history |
| `server/llmlaunch/`, `server/tooleval/`, `server/gpuclock/` | Model launcher jobs, tool evaluation, GPU-clock management and per-card power limits on GPU hosts (`gpuclock/powerCommands.js`) |
| `server/prices/` | Opt-in hosted-model price catalog and offline cache |
| `server/apiKeys/`, `scripts/apikeys-bridge/` | Opt-in read-only API Keys views and the reference host bridge they call over a unix socket |
| `server/storage/` | Storage Manager: disk scans, Docker images, deletes. Shell programs in `scripts/`, path safety in `policy.js`, execution contexts (ssh / native-local / container-local) and the per-feature `supports()` table in `context.js`, what may start (one job per Spark, two scans per fleet) in `admission.js`, scan stop and reconcile rules in `scanJob.js` (unit-side lock and job records in `scripts/unit-state.sh`, stop in `scripts/job.sh`), the delete advisor's rules and known-place table in `advice.js` (pure; evidence from the read-only `scripts/advise.sh`, parsed by `parseAdviseOutput` in `commands.js`), routes under `/api/sparks/:id/storage` |
| `src/api/` | API clients and browser-facing data types |
| `src/hooks/` | Snapshot subscription, metric history and UI hooks |
| `src/components/` | Shell, overview, unit panels and feature pages; the Storage Manager's delete check is `StoragePage/DeleteAdvice.tsx` with its pure rules for friction in `deleteAdvice.ts` and its request in `useDeleteAdvice.ts` |
| `src/styles/`, `src/index.css` | Component styles, Tailwind entry and theme variables |
| `src/shared/` | Shared pure logic, including benchmark prompts, formatting and the one "main disk" policy (`mainFilesystem.js`, also imported by the server) |
| `config/` | Runtime configuration and persisted histories; never use live files in tests |
| `docs/` | Design, operational notes and feature documentation |
| `homeassistant/` | Home Assistant custom component (Python) that polls a hub's `/api/sparks` endpoints; not run by `npm test`, only its docs are checked |

Most API routes are inline in `server/index.js`; larger existing feature modules register their routes there. Snapshot payloads contain a list of self-contained units. Frontend history and summary views consume those shared records. A failure in one collector must not stop other units or the polling loop; missing measurement data must not be fabricated as observed zero.

## Development and validation

Use `npm ci` to install the existing lockfile graph, then `npm run dev` for the Node watch server plus Vite. Use `npm run typecheck`, `npm run build`, and `npm test` before submission. `npm test` runs the complete server suite followed by the frontend suite; individual test globs and commands live in `package.json`. Server fixtures isolate configuration in temporary directories; frontend fixtures live under `src/testing/`.

GPU-clock generated programs require Linux util-linux `flock` for on-unit serialization with their reboot jobs. Their sandbox subprocesses must all use the fixture's isolated HOME and PATH, including manual-command and password-mode executions; never let a generated program discover the developer's crontab or marker.

Model-launcher programs use GNU `tail --pid` with a process-group lifetime monitor where `tail` supports it, and fall back to a short timed shutdown on BSD/macOS `tail`; keep log draining before the protocol exit marker. Linux verification containers must reap detached children (`docker run --init`) rather than leaving wrapper helpers as zombies.

`npm start` serves the production frontend and API on port 5555, binding to loopback by default. Vite development uses port 5173. README documents authentication, allowed targets and Docker operation. Production compose mounts `server` and `dist`, so server edits reload and frontend edits require a host build and browser refresh. Changes to dependencies or the Dockerfile require a container rebuild.

## Mac runtime control

`agents/macos/runtime_control.py` authenticates and serializes user-agent actions;
`profile_runner.py` owns stopping, process release, detached startup and exact-model
readiness for private installed profiles. Privileged collectors remain read-only.
`MacRuntimeControl.js` returns accepted actions promptly and polls the agent's
current/latest operation through the dashboard API. Browser polling never replays
an action; network failures retain the last authoritative operation state.
Agent-backed Macs expose this catalog in the Models panel, including bounded
operation output with copy and expanded views. The configured `macTransport`
snapshot field keeps that control surface stable while telemetry is offline.
SSH-backed hosts retain the script-based Models panel.

## Metric conventions

Preserve the meaning of existing metrics when adding platform support: active residency and frequency-scaled utilisation are distinct signals and should have explicit fields or a documented basis before changing historical series. Hardware names may come from platform probes such as macmon, but a model name is not evidence of an engine version. Cost compare uses an explicitly selected hosted model and an opt-in price catalog; it does not infer a provider from a local model name.

Keep this overview synchronized when module boundaries, scripts, architecture or dependencies change. Historical local design notes may describe earlier versions; verify them against the current source.

## Apple Silicon units

`kind: "mac"` selects `MacSystemCollector` (SSH) or `MacAgentCollector` (optional on-device agent). Missing temperatures and privileged power readings remain unavailable. `agents/macos/README.md` documents the read path, optional privileged collector and opt-in runtime control.
