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
| `server/passkeys/`, `server/passkeyAdmin.js` | Opt-in WebAuthn ceremonies, persistent browser sessions and host-side recovery |
| `server/secretsStore.js`, `server/settings.js` | Encrypted credentials and ordinary persistent settings |
| `server/metrics/`, `server/llmtokens/`, `server/energy/` | Metric histories, token accounting and fleet energy |
| `server/health/`, `server/alerts/`, `server/events/` | Findings, optional notifications and bounded activity history |
| `server/llmlaunch/`, `server/tooleval/`, `server/gpuclock/` | Model launcher jobs, tool evaluation and GPU-clock management |
| `server/prices/` | Opt-in hosted-model price catalog and offline cache |
| `src/api/` | API clients and browser-facing data types |
| `src/hooks/` | Snapshot subscription, metric history and UI hooks |
| `src/components/` | Shell, overview, unit panels and feature pages |
| `src/styles/`, `src/index.css` | Component styles, Tailwind entry and theme variables |
| `src/shared/` | Shared pure logic, including benchmark prompts and formatting |
| `config/` | Runtime configuration and persisted histories; never use live files in tests |
| `docs/` | Design, operational notes and feature documentation |

Most API routes are inline in `server/index.js`; larger existing feature modules register their routes there. Snapshot payloads contain a list of self-contained units. Frontend history and summary views consume those shared records. A failure in one collector must not stop other units or the polling loop; missing measurement data must not be fabricated as observed zero.

## Development and validation

Use `npm ci` to install the existing lockfile graph, then `npm run dev` for the Node watch server plus Vite. Use `npm run typecheck`, `npm run build`, and `npm test` before submission. `npm test` runs the complete server suite followed by the frontend suite; individual test globs and commands live in `package.json`. Server fixtures isolate configuration in temporary directories; frontend fixtures live under `src/testing/`.

GPU-clock generated programs require Linux util-linux `flock` for on-unit serialization with their reboot jobs. Their sandbox subprocesses must all use the fixture's isolated HOME and PATH, including manual-command and password-mode executions; never let a generated program discover the developer's crontab or marker.

Model-launcher programs use GNU `tail --pid` with a process-group lifetime monitor where `tail` supports it, and fall back to a short timed shutdown on BSD/macOS `tail`; keep log draining before the protocol exit marker. Linux verification containers must reap detached children (`docker run --init`) rather than leaving wrapper helpers as zombies.

`npm start` serves the production frontend and API on port 5555, binding to loopback by default. Vite development uses port 5173. README documents authentication, allowed targets and Docker operation. Production compose mounts `server` and `dist`, so server edits reload and frontend edits require a host build and browser refresh. Changes to dependencies or the Dockerfile require a container rebuild.

## Metric conventions

Preserve the meaning of existing metrics when adding platform support: active residency and frequency-scaled utilisation are distinct signals and should have explicit fields or a documented basis before changing historical series. Hardware names may come from platform probes such as macmon, but a model name is not evidence of an engine version. Cost compare uses an explicitly selected hosted model and an opt-in price catalog; it does not infer a provider from a local model name.

Keep this overview synchronized when module boundaries, scripts, architecture or dependencies change. Historical local design notes may describe earlier versions; verify them against the current source.
