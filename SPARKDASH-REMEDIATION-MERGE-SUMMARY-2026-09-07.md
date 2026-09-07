# sparkDash Remediation Merge Summary — 2026-09-07

## Executive summary

Tonight's work merged the six audit-remediation draft PRs into our writable fork integration branch. Each PR was already implemented, tested, and pushed as an isolated draft. The merge applied them in review order onto `onyx/pr-backlog-integration-2026-09-06`, resolved conflicts against the current architecture, ran the full automated gate on the merged tree, and smoke-tested the result on an isolated loopback port.

**Repository:** `MikeGibbsOnyx/sparkDash` only  
**Integration branch:** `onyx/pr-backlog-integration-2026-09-06`  
**Integrated HEAD:** `f76af12812886afa3d3b6ae587f73a74e79f567f`  
**Base before merge:** `bfdccc378ef5b0ba56c89036a4ee536855f286dd`  
**MiaAI-Lab/sparkDash:** not pushed, not merged  
**Live fleet `:5555`:** not rebound, not restarted

### Final automated gate

The complete merged tree passed:

```text
310 server tests passed
23 frontend tests passed
333 tests total, 0 failed
TypeScript typecheck passed
Production Vite build passed
npm audit --omit=dev: 0 production vulnerabilities
```

Production bundle after merge:

```text
dist/assets/index-Dfl3lbTx.css   78.73 kB │ gzip:  13.94 kB
dist/assets/index-3f4WV9AC.js   461.60 kB │ gzip: 130.03 kB
```

### Local load / test answer

**Yes — loaded and tested locally on the merged tree.**  
**No — not promoted onto the live four-Spark dashboard.**

What was actually exercised:

- Full `npm test`, `npm run typecheck`, `npm run build` in `/tmp/sparkdash-merge-integration` at `f76af12`.
- Isolated loopback smoke on `127.0.0.1:18058` with a throwaway empty `SPARKS_JSON_PATH` under `/tmp/sparkdash-merge-smoke`.
- Isolated smoke results: `/` 200, `/api/health` 200 (`ok:true`, `authMode: loopback-open`), `/api/sparks` 200, `/api/fleet-energy` 200 (`estimated:true`), local-unit POST without LAN IP **200**.
- Isolated smoke process was killed after the check.

What was **not** done:

- Live LaunchAgent on `*:5555` was left on the Sep 6 process (`PID 83356`, cwd `/Users/openclaw/repos/sparkDash`, started `Sun Sep 6 23:52:24 2026`). Live root still 200; live `/api/sparks` still returns 4 Sparks.
- No headed Playwright/browser E2E against a real browser.
- No Docker rebuild of the merged tree (`docker compose` plugin still missing). Existing lockfile image `sparkdash:remediation-lockfile-test` `eddacf9aeb76` is from earlier today, not this merge HEAD.
- Builder A's unpushed cookie/sign-in auth (`SPARKDASH_ADMIN_TOKEN`) was **not** landed.

The live deployment remains rollback-safe through the existing Sep 6 backup:

```text
/Users/openclaw/Library/LaunchAgents/ai.onyx.sparkdash.plist.bak-20260906-224716
/Users/openclaw/projects/sparkDash
```

---

## Merge order

```text
32bd7fc merge: PR #1 secure dashboard administration and remote targets
f5fc923 merge: PR #2 durable registry and fleet energy
00807b0 merge: PR #3 honest bounded live telemetry
5776d7f merge: PR #4 complete fleet operations UX
d35abbe merge: PR #5 secure installation and operations
8479d4f merge: PR #6 audit remediation validation
f76af12 fix: export merged telemetry APIs for frontend tests
```

GitHub closed all six as **MERGED** at `2026-09-07T22:15:26Z` when the integration branch received the merge commits.

---

## PR #1 — Secure dashboard administration and remote targets

**Source:** https://github.com/MikeGibbsOnyx/sparkDash/pull/1  
**Head:** `5f57913ad80c639c203566bece14af149179835e`  
**Merge commit:** `32bd7fc7ba04686e5cda9a0ed68e6a7c9defbb0a`

### Commits landed

```text
922e697 chore: open security remediation workstream
3ed32d5 chore: resolve production qs advisories
0b0d8cd feat: protect dashboard administration
1a5cb24 fix: bound remote targets and expensive actions
5f57913 fix: enforce allowlisted targets and benchmark budgets
```

### What was integrated

- Production `qs` advisory bump (`6.15.3` → `6.16.0`) via lockfile-only audit fix.
- Loopback-open local trust; non-loopback bind fail-closed without `SPARKDASH_TOKEN` / `DASHBOARD_TOKEN`.
- HTTP bearer auth + WebSocket `verifyClient` / `?token=` upgrade check.
- Saved Spark hosts are the fleet allowlist; one-off bench hosts need `SPARKDASH_BENCH_HOSTS`.
- DNS classification; forbidden addresses rejected.
- Rate limiter TTL + key ceiling (1024).
- Decode/prefill work budgets, cooldown, global active-job cap 2.
- Shutdown/wake/Hermes/test principal + global limits; 403 names the host and how to allow it.

### Testing performed

- Focused: `auth-and-targets`, `security-bounds`, `websocket-initial-snapshot`.
- Isolated smoke earlier today on `:18055` (loopback open), `:18056` (remote no token **403**, including health), `:18057` (anon **401**, bearer **200**, wrong token **401**).
- Remained green through the merged **333/333** gate.

### Why it is safe on our fork

- Default bind stays loopback. Remote bind is token-gated rather than open LAN.
- Target policy is fail-closed: unknown hosts and forbidden DNS answers are rejected.
- Expensive actions have explicit work budgets instead of unbounded remote work.
- Live `:5555` was not restarted, so production traffic never saw this merge.

### Caveat

Builder A's stricter cookie/sign-in path (`SPARKDASH_ADMIN_TOKEN`, HttpOnly SameSite cookie, no `localStorage`, same-origin JSON mutations) remains unpushed in `/Users/openclaw/repos/sparkDash-builder-a` at `d214aa29`. Landed auth is bearer + `localStorage.sparkdashToken`.

---

## PR #2 — Durable registry and fleet energy

**Source:** https://github.com/MikeGibbsOnyx/sparkDash/pull/2  
**Head:** `dcd5631d46d102d4d3542bbf4610de18436911aa`  
**Merge commit:** `f5fc9236eaa396e6e3e2ac7c4507e28347ccdfb0`

### Commits landed

```text
57ae20e chore: open durability remediation workstream
7443a7f fix: make spark registry mutations durable
5ee52e8 fix: invalidate fleet energy after membership changes
dcd5631 fix: align token efficiency with fleet coverage
```

### What was integrated

- Persist-before-mutate Spark registry writes; persist failure returns HTTP 500 rather than a lying 200.
- Secrets staged, not written into public Spark config.
- Fleet-energy membership invalidates on add/remove, not reorder.
- Wh/output-token uses `coveredOutputTokens` only during simultaneous full-fleet power coverage.

### Testing performed

- `SparkRegistry.durability.test.js` (RED then GREEN).
- `fleet-energy.test.js` membership + coverage regressions.
- Live `/api/fleet-energy` on isolated merge smoke returned HTTP 200 with `estimated:true`.
- Remained green through the merged **333/333** gate.

### Why it is safe on our fork

- Registry mutations are durable or they fail closed.
- Energy math no longer credits partial-fleet intervals as full-fleet efficiency.
- Endpoint remains read-only and labeled estimated.

---

## PR #3 — Honest, bounded live telemetry

**Source:** https://github.com/MikeGibbsOnyx/sparkDash/pull/3  
**Head:** `7313df83768591bb881a467a62f49bc946cb4d8b`  
**Merge commit:** `00807b0a4fa59ecd4f2b149ac999e683277d13a0`

### Commits landed

```text
c7abf18 chore: open telemetry remediation workstream
a6456e5 fix: send websocket snapshot only to new client
7360a2b fix: release benchmark streaming resources
41afea0 feat: timestamp live telemetry snapshots
bfbc5c3 feat: expose disconnected and stale telemetry
7313df8 fix: make dashboard history time-correct
```

### What was integrated

- Initial WebSocket snapshot is unicast to the new client, not broadcast.
- Benchmark streaming listeners/dispatchers released on shutdown.
- Snapshots carry `generatedAt`; connection health requires a valid snapshot, not a mere open socket.
- Stale UI threshold is `max(10s, 3 × broadcast interval)`.
- `TimedRingBuffer` history is time-correct; same-timestamp samples replace, rewind is ignored.

### Testing performed

- `websocket-initial-snapshot.test.js` (RED then GREEN).
- Frontend: `ringBuffer.test.ts`, `metricsStore.test.ts`, `useSnapshot.test.tsx`, `LlmTrendChart.test.ts` (14/14 after merge-export fix).
- Remained green through the merged **333/333** gate.

### Why it is safe on our fork

- Display/history honesty only; collector commands and serving paths are unchanged.
- Resource cleanup is bounded and idempotent.
- Merge follow-up `f76af12` exported the test-facing APIs and made ingest match the time-correct contract.

---

## PR #4 — Complete fleet operations UX

**Source:** https://github.com/MikeGibbsOnyx/sparkDash/pull/4  
**Head:** `7f91217adbcce527298bd183ba62d9b94555aa39`  
**Merge commit:** `5776d7ff03b611186261e1b4e8e1e3b32e72d087`

### Commits landed

```text
6deff67 chore: open product UX remediation workstream
68922b6 feat: surface dashboard action failures
d5a246e feat: show fleet energy on overview
2efb691 feat: make fleet overview searchable
3e73254 feat: summarize active fleet exceptions
7f91217 fix: complete dashboard accessibility basics
```

### What was integrated

- `ErrorBanner` for refresh/reorder/settings failures.
- `FleetEnergyCard` on overview, including unavailable/restart via `membershipChanged` / `restartRequired`.
- Overview search + status filter (`all|online|offline|issues`) with empty state.
- `FleetAlertStrip` for active fleet exceptions.
- Focus trap + `aria-modal` on Add Spark / Confirm Shutdown; Spark tab `aria-current="page"`.

### Testing performed

- Typecheck and production build after merge (both banners kept in `App.tsx`).
- Frontend component tests from PR #6 cover banners.
- Remained green through the merged **333/333** gate.

### Why it is safe on our fork

- UX only over existing APIs. No new mutation surface.
- Conflict with PR #3 resolved by keeping **both** `ConnectionBanner` and `ErrorBanner`.

---

## PR #5 — Secure installation and operations

**Source:** https://github.com/MikeGibbsOnyx/sparkDash/pull/5  
**Head:** `f0764128c475826b0eeb37688b8bbdf92cd57b32`  
**Merge commit:** `d35abbefd9e3ff2aebf5321cf5354d4f2f649b24`

### Commits landed

```text
1b97163 chore: open installation remediation workstream
adb68d2 fix: report required connectivity accurately
17b60fe fix: streamline local unit setup
1a882fd fix: make installation secure by default
a93fb0a feat: add installation and runtime preflight
f076412 docs: document token-backed remote bind
```

### What was integrated

- Connectivity `ok` iff every required/enabled capability is `ok` or `skipped`.
- Local units test collectors, not SSH; LAN IP optional for `isLocal`.
- Compose/dev default `BIND_HOST=${BIND_HOST:-127.0.0.1}` (no hardcoded `0.0.0.0`).
- `/api/health` + startup preflight.
- Merge resolution: non-loopback is allowed **only** when a token is configured (PR #1 contract), not refused outright.

### Testing performed

- `startup-preflight.test.js` updated for token-backed remote bind.
- Isolated merge smoke: health 200 on loopback; local-unit POST without LAN IP 200.
- Remained green through the merged **333/333** gate.

### Why it is safe on our fork

- Install defaults are loopback-first.
- Local onboarding no longer demands a fake LAN IP.
- Preflight fails closed on exposed bind without a token.

---

## PR #6 — Audit remediation validation

**Source:** https://github.com/MikeGibbsOnyx/sparkDash/pull/6  
**Head:** `92a9e0fcf80ff3b4bbda3d07091e634d7f93cabc`  
**Merge commit:** `8479d4fd0cedcc4d19ffbb312c761bb0c1e3da69`

### Commits landed

```text
7ec8486 chore: open validation remediation workstream
92a9e0f test: cover frontend and lifecycle contracts
```

### What was integrated

- Frontend Vitest coverage for banners, ring buffer, metrics store, snapshot hook, trend chart.
- SparkTabs `isActive` / `aria-current` contract tests.
- Lifecycle/frontend fixtures under `src/testing/`.

### Testing performed

- Frontend suite **23/23** on the merged tree.
- Conflict in `SparkTabs.tsx` resolved to PR #6 `isActive` (PR #4 already set `aria-current`).
- Follow-up commit `f76af12` made merged telemetry export the APIs these tests import.

### Why it is safe on our fork

- Tests and small export/ingest fixes only. No new runtime behavior beyond making history ingest match the time-correct contract the tests already specified.

---

## Conflict resolutions (not wholesale either side)

- `src/App.tsx`: kept both `ConnectionBanner` (PR #3) and `ErrorBanner` (PR #4).
- `server/validate.js`: local units may omit `lanIp` / `ssh.host`.
- `server/index.js`: PR #1 auth/allowlist/budgets + PR #5 capability connectivity + health/preflight.
- `server/startupPreflight.js`: non-loopback requires token; does not hard-refuse token-backed remote bind.
- `src/components/AddSparkDialog.tsx`: focus trap + `ConnectivityResult`.
- `src/components/SparkTabs.tsx`: `isActive` + `aria-current="page"`.

---

## Remaining caveats before live promotion

- This merge is on **our fork integration branch only**. Mia upstream was not touched.
- Live `:5555` still runs the Sep 6 integration (`PID 83356`). Promoting requires an explicit GO.
- Builder A cookie/sign-in auth was not included.
- `docs/REMOTE-ACCESS.md` is gitignored in the main tree; PR #5 force-added it.
- No headed browser E2E was recorded.
- `docker compose` plugin is still missing on the host; image smoke used `docker build` earlier, not this merge HEAD.
- Isolated smoke used an empty throwaway `sparks.json`, not the live four-Spark config.

---

## Reproduction commands

From a checkout of `f76af12` (do **not** switch the live `/Users/openclaw/repos/sparkDash` tree while `:5555` is running from it):

```bash
git fetch mike
git switch --detach f76af12812886afa3d3b6ae587f73a74e79f567f
npm ci
npm test
npm run typecheck
npm run build
git log bfdccc378ef5b0ba56c89036a4ee536855f286dd..HEAD --oneline
```

Isolated smoke (never `:5555`):

```text
BIND_HOST=127.0.0.1 PORT=18058 SPARKS_JSON_PATH=/tmp/sparkdash-merge-smoke/config/sparks.json
```

Live dashboard still:

```text
http://100.125.180.48:5555
PID 83356  *:5555  cwd /Users/openclaw/repos/sparkDash
```

No Mia push, no live LaunchAgent rewrite, no Spark update, no model restart, and no training interruption were performed as part of this merge.
