# sparkDash live (macOS LaunchAgent) hardening — 2026-09-07

Promote-night postmortem hardened two failure modes. Files:

- `scripts/ensure-runtime.sh` — post-checkout runtime guard (startup path)
- `scripts/watchdog.sh` — crash watchdog + fleet alert
- `deploy/ai.onyx.sparkdash.plist` — canonical main service unit
- `deploy/ai.onyx.sparkdash-watchdog.plist` — canonical watchdog unit

## Failure modes seen on promote night

1. **Empty node_modules after checkout.** A git checkout/merge landed with
   `node_modules` missing/wiped; `node server/index.js` died instantly with
   `ERR_MODULE_NOT_FOUND: Cannot find package 'express'` and launchd's
   `KeepAlive.SuccessfulExit=false` never restarted a *clean* state — the
   first bounce was dead on arrival.
2. **No watchdog.** If the LaunchAgent process dies to a signal (SIGKILL,
   OOM) or gets booted out, nothing notices. `KeepAlive` alone does not
   cover a bootout-ed service and emits no alert.

## Fixes

### 1. Startup guard (`scripts/ensure-runtime.sh`)

LaunchAgent now runs `bash scripts/ensure-runtime.sh` instead of node
directly. Before `exec node server/index.js` it:

- probes the four runtime deps with one `node -e` import test;
  if missing → `npm ci --omit=dev --no-audit --no-fund` (~0.3s warm cache);
- if `dist/index.html` is missing → full `npm ci` + `npm run build`, then
  prunes back to prod-only deps with `npm ci --omit=dev`;
- `exec`s node so launchd supervises the real server process directly.

Idempotent and cheap on the happy path (one import probe, one stat).

### 2. Watchdog (`scripts/watchdog.sh` + `ai.onyx.sparkdash-watchdog.plist`)

Probes `http://127.0.0.1:5555/health` every 60s (LaunchAgent
`StartInterval=60`). State machine (marker files under
`~/Library/Logs/`):

- 3 consecutive failures → `launchctl kickstart -k gui/$UID/ai.onyx.sparkdash`
  + `DOWN` alert (one per episode — cannot thrash);
- recovery within 45s → `RECOVERED` alert;
- still dead after kickstart → `STILL DOWN ... human intervention required`.

Alerts append to `~/Library/Logs/sparkdash-alerts.log` — the fleet alert
surface (tail/ship it wherever fleet alerts live; the watchdog itself does
no outbound messaging).

Env overrides for testing: `WATCHDOG_STATE_FILE`, `WATCHDOG_ALERT_LOG`,
`SPARKDASH_HEALTH_URL`, `SPARKDASH_LABEL`, `WATCHDOG_FAIL_THRESHOLD`.

### 3. KeepAlive / ThrottleInterval audit (main plist)

| key | before | after | why |
|---|---|---|---|
| KeepAlive | `{SuccessfulExit=false}` | `true` | SuccessfulExit=false does NOT restart on signal deaths (SIGKILL/OOM/SIGSEGV — no clean exit code). `true` restarts on any death; the guard makes restarts cheap and self-healing. |
| ThrottleInterval | unset (launchd default 10s) | explicit `10` | Documented crash-loop ceiling; guard npm ci can't spin faster than 1 restart/10s. |
| ProgramArguments | node directly | bash ensure-runtime.sh | self-heal before exec. |
| NODE_BIN env | — | hermes node path | guard `exec`s this exact binary. |

## Install / reload

```bash
cp deploy/ai.onyx.sparkdash.plist deploy/ai.onyx.sparkdash-watchdog.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/ai.onyx.sparkdash 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.onyx.sparkdash.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.onyx.sparkdash-watchdog.plist
launchctl kickstart -k gui/$(id -u)/ai.onyx.sparkdash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5555/health   # 200
```

## Verification evidence (2026-09-07, isolated clone on port 5599)

Clone of `onyx/live-promote-2026-09-07` with **no node_modules, no dist**
(the exact promote-night state):

1. `node server/index.js` directly → reproduced
   `ERR_MODULE_NOT_FOUND: Cannot find package 'express'` (instant death).
2. `bash scripts/ensure-runtime.sh` → guard logged `runtime deps missing —
   running: npm ci --omit=dev`, `added 70 packages`, then
   `dist/index.html missing — building frontend`, full vite build, pruned
   back to 70 prod packages, and served: `/health` → 200, `/` → 200 HTML.
3. Fake crash: `kill -9` the guard-managed node on :5599 → health probe 000.
   Watchdog runs 1–2 stayed silent (threshold 3); run 3 logged
   `DOWN ... attempting launchctl kickstart` (+ `kickstart FAILED` for the
   intentionally-bogus label), then after the service came back, next
   watchdog run logged `RECOVERED`, state flipped to `up`, and subsequent
   runs stayed quiet. Alert log showed the full DOWN→RECOVERED cycle.

## Follow-ups (not in this change)

- Ship a fleet-alert tailer that forwards
  `~/Library/Logs/sparkdash-alerts.log` lines to the fleet channel (kept
  draft-only per comms rules).
- Live switch-over of `~/Library/LaunchAgents/ai.onyx.sparkdash.plist` to
  the hardened copy is a production restart — needs Mike's GO.
