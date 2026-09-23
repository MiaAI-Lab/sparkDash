# Self-Review — Batch 2B (Worker 2B): Systemd Actions + LLM Switch

**Scope:** `agent/actions/systemd.js`, `agent/actions/llm-switch.js` + tests in
`agent/actions/__tests__/`. Not wired into `http.js`/`main.js` (orchestrator
wires after Worker 2A merge). No `agent/actions/index.js` created (Worker 2A's
file; orchestrator merges).

## Expected inputs / outputs (and why they matter)

| Entry point | Input | Output | Why it matters |
|---|---|---|---|
| `startUnit / stopUnit / restartUnit(unit, opts, deps)` | unit name (string), `{actionId, serviceName, timeoutMs}`, injectable `exec` | `Promise<ActionResponse>` — always resolves, never rejects | Dashboard POST /actions start/stop/restart path; a reject here would 500 the fleet API |
| `switchLlm(oldPort, newPort, opts)` | ports, `{oldUnit/newUnit}` or `{oldContainer/newContainer}`, `{actionId, serviceName, timeoutMs, canaryTimeoutMs}`, injectable `exec`/`fetch` | `Promise<ActionResponse>`; state word in `message`/`error` | The only action that mutates which LLM serves — double-execution or a false "success" strands the node's LLM port |
| `canaryProbe(port, opts)` | port, `{canaryTimeoutMs, pollMs, fetch}` | `Promise<{state: ready\|loading\|wedged\|stopped, modelId, contextLength, memFraction, tpSize}>` | Readiness gate after start; a false "ready" sends the dashboard wrong VersionInfo |

ActionResponse follows `shared/types.ts`: `{actionId, serviceName, status, ok,
message, error, durationMs, idempotent, at}`, status ∈ success/failure/running,
error truncated to 500 chars.

## Pre-gate questions

1. **Inputs that endanger PROJECT goal — handled?**
   - Shell/injection via unit or container names → strict charset validation
     (`isValidUnitName` systemd.js:96; `isValidContainerName` llm-switch.js:44)
     BEFORE any exec; runner is exact-argv `execFile`, no shell (systemd.js:52).
     Test: "systemd: invalid unit names → failure, exec NEVER called" (10
     hostile forms, 0 exec calls); "canaryProbe: out-of-bounds / invalid port"
     (0 fetch calls).
   - Double-submitted switch (dashboard double-click) → in-flight dedupe by
     `actionId` (`withIdempotency`, systemd.js:158). Tests: "concurrent
     startUnit with same actionId → exactly one exec" + switchLlm twin.
   - Tests must not touch the fleet's real systemd → no test executes real
     `systemctl start/stop` on a real unit; the ENOENT ground-truth uses a
     stripped `PATH` (hermetic), runner ground-truths use `echo`/`false`/`sleep`.

2. **Inputs that break THIS code — handled?**
   - Non-string/absurd units and ports (null, 42, "abc", {}, 0, 65536, "8080.5")
     → guarded by `isValidUnitName`/`validPort`; tests assert failure/stopped
     with zero I/O.
   - stderr > 500 chars → truncated at the builder (test asserts length 500).
   - `/get_server_info` 200 with unparseable body → keeps polling → "loading"
     (test).
   - Injected `exec` that throws/rejects → `withIdempotency` converts to a
     failure ActionResponse (test).
   - Invalid/NaN `timeoutMs`/`canaryTimeoutMs`/`pollMs` → finite-check falls
     back to defaults (knob tests).

3. **Outputs detrimental to PROJECT — prevented?**
   - No false success: `ok=true` requires exit 0 AND canary "ready". Docker
     exit-1 tolerances ("already running", "No such container") are
     stderr-regex-gated — a genuine docker start failure still fails (test:
     "docker start real failure (no tolerance)").
   - No false "stopped" on network blips: any fetch error degrades to
     "loading", per spec (test: ECONNREFUSED → loading, never stopped).
   - Early-stop of the pipeline: stop failure ⇒ no start, no probe
     (asserted `m.calls.length === 1`, `f.calls.length === 0`).

4. **Outputs that break NEXT package — prevented?**
   - Status emits only the seam union (success/failure/running) — see finding F1.
   - Invariants: `error` ≤ 500 chars, `at`/`durationMs` finite numbers or null,
     `idempotent` always true, promise always resolves → the http.js wiring can
     JSON-serialize the result without a try/catch.
   - `runExec` contract (documented in systemd.js header) is what Worker 2A's
     docker.js can reuse or mirror.

5. **Optimal input → optimal output — confirmed?**
   - Happy path asserts the FULL response: message
     `systemctl start qwen38-sglang.service → exit 0`, all ActionResponse
     fields; switch happy path asserts exact argv order + canary-parsed
     model id in the message.
   - Canary parsing verified against a REAL local HTTP server (ground truth):
     modelId `RadixArk/Qwen3.8-27B-NVFP4`, contextLength 262144,
     memFraction 0.85, tpSize 1.

6. **Degenerate input — prevents bad output?**
   - Empty unit, 300-char unit, port 0/99999/null/undefined/{} → failure or
     "stopped" with no exec/fetch executed (tests assert call counts = 0).
   - `oldPort=null` in switchLlm skips the stop step cleanly (test: exactly 1 exec).

7. **Out-of-bounds input — reasonable error BEFORE crashing?**
   - Out-of-bounds port → `invalid newPort`/`invalid oldPort` failure
     (switchLlm) or "stopped" (canaryProbe), no I/O.
   - Invalid name → `invalid unit name` failure, no I/O.
   - No uncaught path: `runExec` never rejects (maps all execFile error
     shapes), `canaryProbe` catches every fetch error, `withIdempotency`
     converts unexpected rejects.

## Findings

- **F1 — note-in-summary (flag for orchestrator ruling):** The task's test
  sketch expected `status: "loading"` for canary-not-ready; the canonical
  seam type `shared/types.ts` defines ActionResponse.status as
  success/failure/running only. I followed the canonical type:
  ready→success, loading→**running** (state word in `message`/`error`),
  wedged/stopped→failure. If the orchestrator wants "loading" verbatim,
  that is a types.ts change (Batch 5B's domain), not a module fix.
- **F2 — note:** The canary is sglang-oriented per spec
  (`/get_server_info` 404 → "wedged"); the switch seam fields
  (mem_fraction_static, tp_size, context_length) are sglang parameters.
  A vLLM-only target would read "wedged" — out of scope, documented in
  llm-switch.js header.
- **F3 — note:** Module state is the `inFlight` Map (systemd.js) — bounded,
  released on settle; not append-only by design, dedupe-only.
- **F4 — note:** Default command timeout 30000 ms; heavy LLM units whose
  `systemctl start` blocks >30 s until active should pass `opts.timeoutMs`.

## Witnesses (red → green)

- **Red:** first run — 4 failures + 1 hang. Failures: two execMock off-by-one
  (results array included a stop step that never happens when `oldPort=null`;
  actual=`'canary: stopped'` vs expected `'job failed'`), two dedupe tests
  asserting `m.calls.length===1` synchronously before the shared exec's
  microtask started (`0 !== 1`); the second dangling its pending exec promise
  (file-level "Promise resolution still pending", 120 s timeout kill).
  Log: `/tmp/batch2b-test.log`.
- **Fix cycle:** microtask flush + watchdog before the dedupe asserts;
  corrected execMock result alignment; replaced the 5 s real-systemctl
  ground-truth (machine-dependent, actually exec'd on a live host) with a
  stripped-`PATH` hermetic ENOENT test.
- **Green:** `node --test` both files → **57/57 pass, 0 fail, 698 ms**,
  exit 0 (`/tmp/batch2b-test2.log`). Full agent suite (collectors + catalog +
  actions): **164/164 pass, 0 fail** (`/tmp/batch2b-full.log`).

## Deviations

- Read-list additions (test-harness discovery only, no repo-wide exploration):
  `package.json` (test runner = `node --test`, zero-dep) and
  `agent/collectors/__tests__/systemd.test.js` (house test style:
  `node:test` + dependency injection).
- Task step 3 (create `agent/actions/index.js`) not executed per the step's
  own overriding note — Worker 2A owns it; orchestrator merges.
