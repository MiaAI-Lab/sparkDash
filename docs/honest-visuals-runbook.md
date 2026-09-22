# Honest-Visuals Operator Runbook

One-page reference for the honest-visuals display overhaul. Read this before
changing any rendering constant, adding a model, or sharing a screenshot.

## 1. Where the constants live

- `src/config/display.js` — **single source of truth** (invariant I-11). Every
  display constant (`TEMP_DOMAIN_C`, `TEMP_WARN_C`/`TEMP_THROTTLE_C`,
  `USAGE_DOMAIN`, `IDLE_AFTER_S`, `STALE_AFTER_S`, `DEAD_AFTER_S`,
  `AGG_WINDOW_S`, `TELEMETRY_STRING_MAX`, …) and the `MODEL_SCALES` table.
- `src/config/display.d.ts` — TypeScript declarations for the same module.
  **The two files must stay in sync**; `npm run typecheck` fails if the `.d.ts`
  drifts from how callers use the exports.
- Nothing may be overridden per node, per request, or via content. If a value
  needs to change, it changes in `display.js` for the whole fleet.

## 2. Gauge scales — precedence and provenance (Addendum E amends I-2′)

Scale resolution per dial, highest first:

1. **Manual per-Spark override** — set with the gear icon on a card in the
   Alt-overview tab; persisted in server settings (`gaugeScales`). Empty
   (cleared) values defer to the next level.
2. **`MODEL_SCALES[served-model]`** — keyed by the served model name exactly
   as the backend probe reports it (`vLLM /v1/models` id; ds4 `model_alias`).
3. **`FALLBACK_SCALE`** — unknown model and no override: renders with a
   **Default Scale** badge so a guessed scale is never mistaken for a
   measured one.

Addendum E (Operator, 2026-09-09) restored the per-Spark override that
Addendum C.2 had retired, and removed the idle dimming (a zero reading now
renders at full opacity like any other value). Never auto-scale a dial to
observed traffic — an adaptive dial was defect class T4 and stays gone.

`MODEL_SCALES` entries are **observed tok/s, not measured ceilings** (OQ-6).
To add one:

1. Serve the model under sustained load and observe steady gen/prefill tok/s.
2. Add an entry in `src/config/display.js` with a `source:` string
   (date + how it was observed). Example shape:
   `"my-model": { gen: 120, prefill: 1200, source: "observed 2026-09-09" }`.
3. Unknown keys render at `FALLBACK_SCALE` with a **Default Scale** badge —
   if you see the badge in production, the entry (or an override) is missing.

When a needle pins at max (WARN colour + a console note), the scale is stale —
refine it from a new sustained-load observation, don't raise it speculatively.

## 3. Share mode (I-8, T2)

- Enable via **Settings → Share-safe mode**, or open the app with `?share=1`.
- State is deliberately in-memory only (never persisted) so a screenshot
  workflow can't leak redaction state across sessions.
- What it does: host/model names render as session-stable aliases (Node A…,
  model-a…), capacities render as percentages, and destructive controls
  (Wake All / Shutdown All, per-node settings gears) are **removed from the
  DOM, not disabled**. A yellow "Share mode — identifiers redacted" banner
  confirms it is active.
- **Known limitation:** redaction is render-layer only. Raw WebSocket
  telemetry frames still carry real identifiers — share mode is a
  screenshot-safe view, **not** wire-level anonymisation. Don't point a
  traffic inspector at a share-mode session and call it safe.

## 4. Running the acceptance suite

```bash
npm test                 # server (node --test) + frontend (vitest)
npm run test:frontend    # vitest/jsdom — includes honestVisuals.acceptance.*.test.tsx
npm run test:server      # node --test over server/**/__tests__
npm run typecheck        # tsc --noEmit — display.js/.d.ts sync guard
npm run build
```

## 5. Tests that MUST re-run after every fork change

Any change to rendering, telemetry ingestion, or the API boundary must re-run
(at minimum):

- **AT-1** — workload-section placeholders never disappear (`honestVisuals.acceptance.test.tsx`).
- **AT-6-class freshness tests** — `updated Ns ago` / STALE badge / DEAD
  placeholder timing (`STALE_AFTER_S`/`DEAD_AFTER_S`) and the metricsStore
  timestamp contract (`src/hooks/metricsStore.test.ts`).
- **AT-12 injection** — hostile `modelId` renders as inert text, no script
  execution (`honestVisuals.acceptance.test.tsx`).

Full gate: `npm test && npm run typecheck && npm run build`.

## 6. Open questions / caveats

- **OQ-3 (thermal thresholds):** `TEMP_WARN_C` 45 / `TEMP_THROTTLE_C` 51 °C
  were **measured** 2026-09-09 on gx10 (GB10) via
  `nvidia-smi -q -d TEMPERATURE` (GPU T.Limit Temp 51 °C; idle reading 45 °C).
  Validate under sustained load before treating as final.
- **OQ-6 (scales):** as above — `MODEL_SCALES` are observed values, refine
  per model from sustained-load benchmarks.
