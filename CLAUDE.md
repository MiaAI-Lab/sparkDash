# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

sparkDash is a real-time monitoring dashboard for multiple NVIDIA DGX Spark (GB10) units plus "dedicated GPU host" Linux boxes. A Node/Express/`ws` backend (plain JS ESM, **no TypeScript on the server**) polls hosts (local sysfs/proc/`nvidia-smi`, or remote over SSH) and LLM servers (llama.cpp / vLLM / SGLang / ds4), and streams snapshots over WebSocket to a React 19 + TypeScript + Vite + Tailwind v4 SPA. Production target is an arm64 Docker container. README.md is thorough on features, REST routes, env vars, and security model — read it for user-facing behavior; this file covers what you need to change code safely.

## Commands

```bash
npm install                 # needed for typecheck and the ComfyProbe test (imports `ws`); most tests run without deps
npm run dev                 # Vite :5173 (proxies /api and /ws → 127.0.0.1:5555) + `node --watch server/index.js` :5555
npm run dev:server          # server only
npm run dev:client          # Vite only
npm run build               # frontend → dist/ (server serves dist/ + SPA fallback in prod)
npm start                   # node server/index.js (serves API, WS, and dist/)
npm run typecheck           # tsc --noEmit — covers src/ only (server/ and config/ are excluded)
npm test                    # node --test server/collectors/__tests__/*.test.js server/sparks/__tests__/*.test.js
node --test server/collectors/__tests__/LlmProbe.sglang.test.js          # single file
node --test --test-name-pattern "sticky" server/collectors/__tests__/*.test.js   # by test name
```

- There is no linter/formatter config and no frontend test harness; `npm test` is server-only and the glob list in `package.json` is explicit — **a new `__tests__` directory is not picked up unless added there**.
- Docker: `docker compose up --build -d` (prod; `network_mode: host`, `privileged`, `pid: host`), `docker compose -f docker-compose.dev.yml up --build` (dev with HMR), `./deploy.sh` (down → build → up). The prod compose bind-mounts `./server` and `./src/shared` and runs `node --watch`, so **server edits hot-reload inside the running container, but frontend edits need an image rebuild**.
- Release convention (see CHANGELOG.md header): bump `package.json` version, add a section at the top of `CHANGELOG.md`, and replace the README "Latest version changelog" block (README shows only the current release).

## Architecture

### One Spark model, N instances

Every unit is a record in `config/sparks.json` with `kind: "spark" | "host"` and `role: "head" | "worker" | "standalone"`. The same `SparkMonitor` / `SystemCollector` / `LlmProbe` code runs for all of them — prefer extending the shared model over per-unit special cases.

### Server data flow (`server/`)

```
SparkRegistry (config + encrypted secrets, change events)
  └─ SparkMonitor (one per spark; per-domain setInterval + liveness timer; owns rate baselines + _metrics cache)
       ├─ SystemCollector   local: /host/proc, /host/sys, nvidia-smi via `nsenter --mount`; remote: one batched SSH cmd per domain, split on '---'
       ├─ LlmProbe[]        one per configured LLM port; backend autodetect + counter-diff tok/s
       ├─ ComfyProbe        opt-in; + ComfyProgressSocket (ws client to Comfy)
       └─ HermesProbe       opt-in; `hermes update --check` over SSH / setpriv-as-host-user locally
  → monitor.snapshot() → orderedSnapshots() (registry tab order) → WS broadcast
```

- `server/index.js` is the whole HTTP layer: Express routes, the single `WebSocketServer` on `/ws`, `monitors: Map<sparkId, SparkMonitor>`, `startBroadcast()`. Boot: `loadSettings()` → `startBroadcast()` → `listen` → `startAllMonitors()`.
- **WS protocol is one message type**, `{ type: "snapshot", sparks: SparkSnapshot[], refreshInterval }`, pushed every `settings.pollIntervalMs`. No client→server WS messages — all mutations are REST. The broadcaster **skips the tick if the JSON payload is byte-identical to the last one**; that is why `snapshot()` deliberately has no `timestamp` field (see the NOTE in `SparkMonitor.js`). Use `forceBroadcast()` after out-of-band state changes (Hermes check/update, manual refresh).
- Poll loops run with no clients connected so rate metrics (tok/s, bytes/s, disk I/O) keep valid baselines. `_pollDomain()` has in-flight guards and re-checks `this._running` after every `await` — keep that pattern when adding a domain.
- Hot vs restart: `PATCH /api/sparks/:id` stops and restarts the monitor; password-only, disabled-devices/interfaces, and llm-port routes call `monitor.updateConfig()` (comment `// hot — no monitor restart`) so baselines survive. Settings hot-reload in-process; only `pollIntervalMs` triggers `restartBroadcast()`.
- Route order matters in `index.js`: batch routes (`/api/sparks/shutdown-all`, `/wake-all`, `/hermes/update-all`) and `PUT /api/sparks/order` are registered **before** `/api/sparks/:id/*`. SPA fallback uses Express 5 syntax `app.get("*splat", …)`.
- Every route accepting a host/user/id goes through `server/validate.js` (`validateSparkTarget`, `isAllowedTargetHost`, `isValidSshUser`, `isValidSparkId`). The API is intentionally unauthenticated (LAN-trusted) — don't add features that assume otherwise without saying so.
- `server/collectors/ssh.js` `sshExec()` is the only SSH path: `execFile` argv (no shell), whitelisted child env, password via `sshpass -e` + `SSHPASS` env (never argv). Remote collectors batch commands and parse text; add to the batch rather than opening more SSH sessions.
- Local Hermes must run as the host user (`setpriv` inside `nsenter`), never container root — root previously corrupted installs. Keep `chooseLocalInvocation()` semantics if touching HermesProbe.

### Persistence (`config/`, bind-mounted volume)

All writers go through `server/util/atomicWrite.js` (tmp + rename, with fallbacks for root-owned files from Docker). `sparks.json` never contains secrets; SSH passwords and LLM API keys are AES-256-GCM in `sparks-secrets.json` keyed by `.secrets-key` (or `SPARKDASH_SECRETS_KEY`). `registry.toPublic()` strips secrets for every API response (`ssh.hasPassword`, `llmApiKeyPorts` only). `bench-active.json` checkpoints running decode benchmarks so a `node --watch` reload doesn't 404 the dialog. `gpu-memory.json` is written by the host cron `config/gpu-memory.sh` and is only used as a fallback when the live `nvidia-smi --query-compute-apps` call failed.

### LLM subsystem (`server/collectors/LlmProbe.js`, `LlmStreaming.js`, `DecodeBench.js`, `ShowcaseManager.js`)

- `LlmProbe` detects backend via `/slots` (llama.cpp) then `/v1/models` + `owned_by` / Prometheus `ds4_*` / `/get_server_info` → `vllm | sglang | ds4 | lmstudio`. Once known to be OpenAI-compatible it stops probing `/slots` (avoids 404 spam). LM Studio (`owned_by: organization_owner`) answers *every* unknown path with 200 + `{"error"}` and logs it as an ERROR, so it is classified from `owned_by` alone, never probed for `/metrics`/`/get_server_info`, and its model list is read only every 10 s (`_probeLmStudio`); `_looksLikeServerInfo()` keeps such error envelopes from reading as SGLang. Several tests lock in backend quirks: SGLang `last_gen_throughput` is a sticky gauge (treat as live only while it changes); never use SGLang `max_total_num_tokens` as context length; never use ds4 `*_tok_s` window gauges for live tok/s; HF hub cache paths normalize to `org/name` via `normalizeModelId()`.
- `LlmStreaming.js` is the shared SSE layer for both DecodeBench and Showcase: splits `delta.content` from `delta.reasoning`/`reasoning_content`, measures decode tok/s first-visible→last-visible token, and `applyThinkingFlags()` writes model-family-specific `chat_template_kwargs` (`enable_thinking`, MiniMax `thinking_mode`, DeepSeek `thinking`) with a one-shot retry on HTTP 400 after stripping them.
- `src/shared/llmPrompts.js` is the prompt catalog imported by **both** the server (`../../src/shared/llmPrompts.js`) and the client (`../../shared/llmPrompts.js`). `showcasePrompts.test.js` reads the *source text* of DecodeBench, ShowcaseManager, llmPrompts and the client re-export and regex-asserts request bodies and import paths — a behavior-preserving refactor of those request bodies can still fail that test.
- Decode bench and Showcase are mutually exclusive per spark; Showcase sessions are kept alive by client `GET` heartbeats and auto-cancel after 5 s without one.

### Client (`src/`)

- No router library: `hooks/useRoute.ts` does History-API path routing — `/` Overview, `/spark/:id` detail, `/showcase/:id` a separate full-screen mode rendered by `App.tsx` with no dashboard chrome (opened via `window.open` from `LlmPanel`). `OVERVIEW_ID = "__overview__"` (`constants.ts`) is a reserved pseudo-tab id; the server rejects it as a spark id by hand-duplicated check in `validate.js`.
- **No React Context.** Live data is a module-level store + `useSyncExternalStore`: `hooks/useSnapshot.ts` owns the WS (fixed 2 s reconnect) and calls `ingestSnapshots()` from `hooks/metricsStore.ts`, which keeps client-side rolling series (`HISTORY_MAX = 1800`, precomputed `SPARKLINE_TAIL = 30`) keyed `"${sparkId}:${metric}"`. Panels take `sparkId` and read their own series via `useMetricsHistoryTail()` — don't thread history through props. The store header documents a reference-stability contract (unchanged keys keep the same array ref); preserve it. `hooks/useHermesUpdateDialog.ts` uses the same module-store pattern for a global dialog.
- REST lives in `api/client.ts` behind one `apiFetch<T>()` wrapper (relative URLs; throws `Error(body.error)`); wire types are hand-mirrored from the server in `api/types.ts` — **no codegen**, keep both sides in sync manually.
- Always resolve roles via `api/sparkRole.ts` (`resolveSparkRole`, `isLlmMonitoringEnabled`) — it handles the legacy `workerNode` boolean; don't read `role`/`workerNode` directly.
- Cross-tier shared code goes in `src/shared/*.js` (plain ESM so Node can import it) with a sibling `.d.ts` — never `.ts`.
- Theming is a `data-theme` attribute on `<html>` (`white | light | dark | oled`, localStorage key `sparkdash-theme`), not Tailwind `dark:`. Tokens are CSS custom properties defined per `[data-theme]` block in `index.css` and re-exported through an `@theme { --color-*: var(--color-*) }` block so Tailwind utilities (`bg-surface`, `text-muted`, `text-accent`, …) resolve to the live theme. **A new color token must be added in every `[data-theme]` block and in `@theme`.** Density is a second attribute, `data-density="compact|comfortable"`, driven by server-persisted settings and consumed via `--density-*` vars.
- Every metric card is a `ui/Panel`; `ui/MetricBar` (`bandColor`), `ui/Sparkline`, and hand-inlined `ui/icons.tsx` are the primitives (no icon library). Dialogs use `createPortal` + `hooks/useModalPresence` for enter/exit transitions.
- `SparkPage.tsx` layout is conditional on `kind`: hosts render GPU (left, row-span-3) + RAM → Network → Storage; Sparks render GPU (row-span-2) + Storage → Network with **no RamPanel** (unified memory lives in GpuPanel). `metrics.llm[i]` is index-matched to `llmPorts[i]`.
- `SparkTabs.tsx` (@dnd-kit): the drag handle is intentionally outside the memoized tab label so `useSortable` listeners stay fresh (see comment near line 95); `App.tsx` keeps an `orderOverride` so reorders don't flicker against the next WS frame.
- The `@/` alias exists in both `vite.config.ts` and `tsconfig.json` but is unused — code uses relative imports; match that.

## Conventions

- Server: ESM, `.js` extensions on every import, `__dirname` via `fileURLToPath`, JSDoc for types. Client: strict TS, `import type` for type-only imports, `console.error` as the failure path (the toast system was removed in 1.8.0).
- Tests use `node:test` + `node:assert` with no mocking library: swap `globalThis.fetch` with a URL-matching stub (restore in `finally`), monkey-patch instance methods (`probe._run = async () => …`), or `Object.create(Class.prototype)` to call pure private methods without touching disk.
- Collectors must degrade gracefully — catch and return zero/default metrics rather than throwing out of a poll loop; sustained liveness failure (10 s grace) marks the spark offline.
- Honor the explicit "on purpose" comments when you meet them (no snapshot `timestamp`, gpu-memory.json fallback-only, SGLang/ds4 gauge rules, Hermes privilege drop, `ComfyPanel.comfyOpenUrl()` preferring `lanIp` over the dashboard origin).
