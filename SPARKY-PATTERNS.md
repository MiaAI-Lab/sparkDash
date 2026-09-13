# Sparky → sparkDash pattern steal

Local branch: `feat/sparky-patterns-local`. **Not live `:5555`.** Review on isolated port.

sparkDash stays Node/Vite/ops. We steal UX/telemetry, not Sparky’s single-file Python or read-only stance.

## 1. Live in-flight strip

**Problem.** sparkDash already has `generationTps` + `requestsRunning`. Idle gauges look like “last decode forever.” Sparky shows *this poll*: `N live · ~X tok/s each · Y combined`.

**Plan.** Client helper `formatLiveStrip`. Render under Generation tok/s only when `requestsRunning > 0` and `generationTps > 0`. Prefill stays its own row.

**Done.** `src/lib/liveStrip.ts` + `LlmPanel`.

## 2. Token bank across restarts

**Problem.** vLLM `/metrics` counters reset on bounce. Lifetime tokens drop to 0.

**Plan.** Persist `{ banked, lastLive }` per `sparkId:port` in `config/token-bank.json` (override `TOKEN_BANK_PATH`). On drop (`live < lastLive`), add previous live to banked. Expose `outputTokensLifetime`.

**Done.** `server/tokenBank.js` + `LlmProbe._getSnapshot`.

## 3. Comfy VRAM high-water while rendering

**Problem.** Idle Comfy VRAM is a lie. Sparky peaks while the queue is busy.

**Plan.** Parse `devices[].vram_total` / `vram_used` from `/system_stats`. While `queue_running > 0`, raise `vramPeak`. Reset peak when idle for one successful poll.

**Done.** `ComfyProbe` + `ComfyPanel`.

## 4. Collapse all + persist

**Problem.** Screen real estate must be collapsible/closeable.

**Plan.** Existing Resources/Services toggles stay. Add **Collapse all** / **Expand all** (writes the same localStorage keys).

**Done.** `SparkPage` toolbar. Drag-reorder is *not* in this build (layout is CSS grid with GPU spanning rows — reordering would fight that). Documented as follow-up.

## 5. Fabric-switch card

**Problem.** Sparky’s MikroTik RoCE panel is a different product. We have CX7 / 200G QSFP, not a Mikrotik API.

**Plan (this build).** Collapsible **Fabric** panel, default **closed**. Shows `spark.fabricNote` if set in `sparks.json`; otherwise a one-liner that QSFP/RoCE is host Network, not a switch scrape. No MikroTik SSH. No extra poller.

**Done.** `FabricPanel.tsx`.

## 6. Fail stale, never crash the poller

**Problem.** One bad probe should not kill the dashboard tick.

**Plan.** Collectors already return `_default()` on throw. Token-bank I/O is try/catch and never throws into the probe. Comfy VRAM parse is best-effort.

**Done.** Bank + VRAM parsers swallow errors.

## Review

```
cd /Users/openclaw/repos/sparkDash
BIND_HOST=127.0.0.1 PORT=5599 npm start
```

Do **not** bootstrap LaunchAgent / `:5555` without GO.
