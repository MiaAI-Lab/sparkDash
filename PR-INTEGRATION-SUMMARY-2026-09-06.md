# sparkDash PR Integration Summary — 2026-09-06

## Executive summary

Tonight's work reviewed the open sparkDash pull-request backlog against current upstream `main`, transplanted the safe and still-relevant changes into a clean local integration branch, resolved conflicts against the current architecture, ran automated validation after each accepted integration, and then exercised the resulting build against the live four-Spark Onyx fleet.

**Repository:** `MiaAI-Lab/sparkDash`  
**Integration branch:** `integration/pr-backlog`  
**Integrated HEAD:** `9631e801a1be4ad13e4cb6fc04c449b77c4c3e56`  
**Upstream base checked during final validation:** `e03b9d624e7135d6e82b4c8fc94ea0ddcf300547`  
**Branch state before this report:** eight isolated commits ahead of `origin/main`, with no pushed changes.

### Final automated gate

The complete integrated branch passed:

```text
285 tests passed
0 failed
TypeScript typecheck passed
Production Vite build passed
git diff --check passed during integration gates
```

### Live fleet validation

The integrated build was first started on isolated port `5556`, then promoted to the existing reboot-persistent LaunchAgent on port `5555` after successful telemetry checks.

Verified live against:

- `nyx-den` — online; live GPU, CPU, RAM, storage and network telemetry
- `iris-den` — online; live GPU, CPU, RAM, storage and network telemetry
- `mike-den` — online; live GPU, CPU, RAM, storage and network telemetry
- `rin-den` — online; live telemetry while its training workload remained untouched

Additional live checks:

- Dashboard root returned HTTP 200.
- `/api/sparks` returned all four configured Sparks.
- `/api/fleet-energy` returned fresh data from all four nodes.
- Both LLM daily-history endpoints returned HTTP 200.
- Consecutive samples changed with the hardware state, confirming that the dashboard was collecting real telemetry rather than display/demo values.
- The persistent LaunchAgent was verified running from `/Users/openclaw/repos/sparkDash/server/index.js`, with working directory `/Users/openclaw/repos/sparkDash` and listener `*:5555`.

The existing deployment remains rollback-safe through:

```text
/Users/openclaw/Library/LaunchAgents/ai.onyx.sparkdash.plist.bak-20260906-224716
/Users/openclaw/projects/sparkDash
```

---

## PRs integrated and recommended for `main`

Each accepted PR was applied as an isolated, reversible commit rather than merging the contributor branch wholesale. This preserved current `main` behavior, excluded unrelated or stacked changes, and makes review or rollback possible one feature at a time.

## PR #81 — Upgrade `undici` for CVE-2026-12151

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/81>  
**Local commit:** `cfa67dd954a96379c1b60abe433a70abdd7713fe`  
**Files:** `package.json`, `package-lock.json`

### What was integrated

- Updated the direct `undici` dependency to the patched release.
- Regenerated the lockfile result without importing unrelated source changes.

### Testing performed

- Dependency installation/lockfile resolution was exercised as part of the integration environment.
- Full server test suite passed after integration.
- TypeScript typecheck passed.
- Production build passed.
- The final eight-commit branch passed all 285 tests.
- The resulting application ran successfully in the live four-Spark deployment.

### Why it is safe to push

- The change is narrowly scoped to a security dependency and its lockfile.
- No application API, collector, persistence, or UI behavior was altered directly.
- The complete application test/build gate and live startup passed with the patched dependency.

---

## PR #79 — Derive worker labels from the head node's live model

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/79>  
**Local commit:** `b8226bc1c135493dddfb9556a2dc1359813bbdce`

### What was integrated

- Added a derived worker-card label based on the healthy head node's currently served model.
- Preserved manual worker-label overrides.
- Made derivation fail closed: an offline, unavailable, self-referential, or unresolved head does not produce a stale or invented label.
- Added API types and Overview/Spark header presentation support.

### Testing performed

A dedicated regression suite was added in:

```text
server/sparks/__tests__/worker-derived-label.test.js
```

Coverage includes:

- Worker mirrors a healthy head model.
- Manual label overrides remain authoritative.
- Offline heads do not leak stale model labels.
- Unresolvable and self-referential head IDs produce no derived label.
- Standalone nodes never mirror a head.
- Multi-port selection skips unavailable entries and selects the first valid live model.

The focused tests were included in every subsequent full-suite run, including the final **285/285** pass. Typecheck and production build also passed.

### Why it is safe to push

- It is display-only derivation from existing live snapshots; it does not change routing, serving, or node configuration.
- It explicitly fails closed instead of displaying potentially stale operational claims.
- Manual operator configuration is preserved.
- The behavior is isolated behind direct regression tests.

---

## PR #76 — Reconcile encrypted LLM API keys when ports change

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/76>  
**Local commit:** `699797920bb3d789b824239ac97c89e375ab359d`

### What was integrated

- Reconciles encrypted LLM API-key entries when `llmPorts` changes through the PATCH route.
- Reconciles safe, unambiguous out-of-band `sparks.json` port renames during registry load.
- Prunes a key when its port is explicitly removed.
- Refuses destructive migration when the before/after shape is ambiguous.
- Keeps API keys in the encrypted secret store; they are never moved into public Spark configuration or API responses.

### Testing performed

A dedicated suite was added in:

```text
server/sparks/__tests__/SparkRegistry.llmApiKeys.test.js
```

Coverage includes:

- Unambiguous single-port rename moves the key intact.
- Ambiguous shapes preserve the existing key and warn instead of guessing.
- Already-aligned configurations remain unchanged.
- Removed ports are pruned.
- Empty and legacy scalar port forms normalize correctly.
- PATCH requests that omit `llmPorts` do not touch keys.
- Warning output identifies ports without exposing secret values.

All tests remained green through the final **285/285** run; typecheck and build passed.

### Why it is safe to push

- The code protects credentials from becoming orphaned while using conservative migration rules.
- Ambiguity is non-destructive: it warns and preserves data rather than guessing.
- Secret material remains encrypted and outside public API payloads.
- The highest-risk migration and pruning cases have direct tests.

---

## PR #59 — Isolate monitor polling lifecycles

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/59>  
**Local commit:** `3287dd7d8fd3d87da506b80a297d3837417d52b9`

### What was integrated

- Added generation/run guards so asynchronous work from a stopped or reconfigured monitor cannot commit into the current monitor state.
- Protected GPU, CPU, storage and liveness polling from stale completions.
- Preserved newer CPU-temperature and NVRM behavior already present in `main` during conflict resolution.
- Prevented older CPU samples from rewinding the accepted baseline.

### Testing performed

A dedicated lifecycle suite was added in:

```text
server/sparks/__tests__/monitor-lifecycle.test.js
```

Coverage includes:

- A poll from an earlier run cannot commit after restart.
- A pre-`updateConfig` poll cannot commit against a new target.
- Rejected old CPU polls cannot rewind generation state.
- Stale liveness checks cannot overwrite current liveness.
- Stale storage refreshes cannot overwrite current storage.
- Earlier-run operations cannot incorrectly clear current in-flight state.

At this integration point, **217/217 tests passed**. Typecheck and production build passed. The tests remained green in the final 285-test branch and during live four-node monitoring.

### Why it is safe to push

- The change hardens asynchronous state ownership without changing collector commands or telemetry meaning.
- It specifically prevents race-driven stale data, one of the more dangerous failure modes in a monitoring dashboard.
- Existing current-main behavior was intentionally retained during conflict resolution.
- It has broad direct regression coverage and passed live multi-node polling.

---

## PR #77 — Reuse SSH transports for remote collectors

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/77>  
**Local commit:** `29153a6266dbc323fc13f1a08bdecea6705cf3ba`

### What was integrated

- Added OpenSSH ControlMaster/ControlPersist reuse so rapid remote collector polls do not perform a full SSH/PAM authentication for every command.
- Preserved current SSH tunnel behavior.
- Added configuration to disable multiplexing by setting `SSH_CONTROL_PERSIST_SECONDS=0`.
- Fixed a stale-master invalidation defect identified during review: transport readiness is re-probed rather than trusting a dead cached master.

### Testing performed

A dedicated suite was added in:

```text
server/collectors/__tests__/ssh.multiplex.test.js
```

Coverage includes:

- Stable and safely derived control-socket behavior.
- Multiplexing enable/disable behavior.
- Reuse of authenticated transports.
- Forced readiness re-probing after stale-master invalidation.
- Compatibility with existing SSH execution paths.

At this integration point, **222/222 tests passed**. Typecheck and production build passed. The final 285-test gate passed, and the deployed build successfully collected frequent telemetry over SSH from all four live Sparks.

### Why it is safe to push

- It reduces connection churn without changing the remote commands being executed.
- Operators have an explicit zero-value escape hatch to restore one-connection-per-command behavior.
- The reviewed version fixes the stale-master case rather than importing the source PR blindly.
- Four-node live monitoring validated the real SSH path.

---

## PR #74 — Add q27 backend telemetry

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/74>  
**Local commit:** `768160efa473f98a5adca9889398924e02aa0882`

### What was integrated

- Added detection and parsing for the signalnine/q27 LLM backend.
- Added q27 streaming/telemetry handling and corresponding API/UI type support.
- Limited the transplant to q27 support; unrelated collector changes from the source branch were excluded.

### Testing performed

A dedicated suite was added in:

```text
server/collectors/__tests__/LlmProbe.q27.test.js
```

The focused suite exercises q27 identification, response parsing, metrics mapping, streaming behavior, unavailable/error behavior, and separation from other supported backends. It passed as part of each subsequent full-suite gate and the final **285/285** run. Typecheck and production build passed.

The live deployment also verified that unavailable configured LLM ports are reported as unavailable rather than falsely detected as q27 or another backend.

### Why it is safe to push

- Detection is backend-specific and does not replace existing vLLM, ds4, EXL3, SGLang, or llama.cpp handling.
- Unrelated source-branch edits were deliberately excluded.
- Failure behavior is conservative: an unreachable service remains unavailable rather than being assigned a fabricated backend.
- The parser has a substantial focused regression suite.

---

## PR #63 — Add fleet energy telemetry

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/63>  
**Local commit:** `374f71a80216bf7f06c6cd7da9c935f1e6e634a7`

### What was integrated

- Added a read-only `/api/fleet-energy` endpoint.
- Added rolling 24-hour and 31-day energy estimates, 30-second current-power averaging, coverage accounting, output-token accounting, and Wh/token estimates.
- Added bounded, atomic, mode-0600 persistence.
- Applied the feature without duplicating the source branch's stacked #59 lifecycle commits.
- Explicitly labels the result as estimated; it does not present modeled whole-system energy as direct wall-meter data.

### Testing performed

A comprehensive suite was added in:

```text
server/sparks/__tests__/fleet-energy.test.js
```

The suite covers, among other cases:

- Freshness and provenance requirements.
- Read-only endpoint behavior and response contract.
- CPU/GPU estimator bounds.
- Trapezoidal integration.
- UTC minute-boundary splitting.
- Missing-node and long-gap rebasing.
- Backward-clock and rollback suppression.
- Persistence reload, migration and corruption handling.
- Physical and relational validation of persisted buckets.
- Token counter resets, source changes and ambiguous heads.
- Independent 24-hour/31-day retention.
- Atomic persistence, mode 0600 and bounded retention.
- Failure containment during close/persistence.

The integration gate ran the full test suite, typecheck, and production build. The tests remained green through the final **285/285** pass.

Live validation returned HTTP 200 from `/api/fleet-energy`, reported `freshNodeCount: 4`, and calculated current fleet watts from fresh telemetry for all four Sparks.

### Why it is safe to push

- The endpoint is read-only and explicitly identifies its results as estimates.
- Energy is accumulated only from fresh, provenance-qualified telemetry.
- Persistence is bounded, atomic and private by file mode.
- Clock rollback, gaps, resets, disappearing nodes and corrupted state are extensively tested.
- The implementation was de-stacked from #59, avoiding duplicate commits and conflict risk.

---

## PR #75 — LLM tok/s and TTFT trend chart

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/75>  
**Local commit:** `9631e801a1be4ad13e4cb6fc04c449b77c4c3e56`

### What was integrated

- Added an LLM trend chart and supporting metrics-store history.
- Preserved current remote decode/prefill controls while resolving UI conflicts.
- Retained useful tok/s history behavior.
- Excluded the source PR's broken TTFT overlay rather than presenting an invalid trend.

### Testing performed

- Conflict resolution was checked with `git diff --cached --check`.
- Full server suite passed after integration.
- TypeScript typecheck passed.
- Production build passed.
- Final branch passed **285/285 tests**.
- Live `/api/sparks/:id/llm/daily` requests for both configured LLM-monitoring nodes returned HTTP 200.
- The complete frontend bundle was served successfully from the persistent live deployment.

### Why it is safe to push

- The invalid TTFT visualization was deliberately removed rather than papered over.
- Existing remote benchmark controls were preserved during conflict resolution.
- The feature consumes existing telemetry/history and does not change model serving or inference routing.
- Both backend history endpoints and the built frontend were exercised live.

---

## PRs reviewed but not integrated

## PR #68 — Sensorless host CPU probe

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/68>

### Why we did not proceed

Current upstream `main` already contains a broader, complete fix for hosts without usable thermal sensors. Importing #68 would duplicate or regress the newer implementation. This was classified as **obsolete/superseded**, not rejected on quality grounds.

### Review performed

- Compared the PR's intended behavior with the current CPU probe path.
- Confirmed the relevant sensorless-host behavior already exists in current code.
- Kept current-main implementation and its existing tests.

---

## PR #54 — DeepSeek-specific thinking-disable correction

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/54>

### Why we did not proceed

The PR adds DeepSeek-specific benchmark payload handling, but current `main` already has a broader model-agnostic thinking adapter. Current behavior sends the supported variants:

- `enable_thinking`
- `thinking`
- `thinking_mode`

It also removes those fields correctly on fallback and defaults benchmark thinking to off. Importing older model-specific logic would narrow or duplicate the current solution. This PR is **obsolete/superseded**.

### Review performed

- Traced the current benchmark and streaming payload behavior.
- Compared current model-agnostic handling with the PR's DeepSeek-specific approach.
- Confirmed the current implementation covers the PR's intended failure mode more generally.

---

## PR #42 — Fleet storage tiers and model placement

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/42>

### Why we did not proceed

The disk-inventory portion is plausible, but the defining “fabric placement” feature infers availability by matching a loaded model name on one node to a model/file name on another. It does **not** verify:

- Actual routing
- Shared storage
- CX7 topology
- Whether model bytes were read over the fabric
- Whether a remote copy is usable by the active server

That would turn an inference into an operational claim. The PR also recursively sizes model trees on a 30-second cadence, including over SSH, without a clearly bounded work budget. It spans disk inventory, model scanning, route changes and inferred placement across 22 files, making a partial conflict-resolution merge inappropriate.

### Review performed

- Attempted a squash merge to expose the real conflict set.
- Reviewed `SystemCollector`, `SparkMonitor`, package changes and `fleetPlacement.ts`.
- Reviewed model-collection tests.
- Reset cleanly to the pre-PR checkpoint after the no-go decision.

### What would make it acceptable later

Separate read-only disk inventory from placement claims. Any fabric-availability label should require verified topology and route/storage evidence, and recursive scans need caching plus a bounded schedule.

---

## PR #55 — Harness onboarding wizard and session sources

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/55>

### Why we did not proceed

This is a legitimate product concept but not a safe backlog transplant. Relative to the integration base it introduces approximately **12,303 lines across 62 files**, including:

- Five external harness protocols
- Helper daemons
- Session-source registries and onboarding UI
- Secret-store changes
- New configuration/API surfaces
- Functionality overlapping current Hermes monitoring

sparkDash intentionally exposes an unauthenticated local/LAN API, so new session/configuration surfaces and secret-handling changes require dedicated threat modeling and staged design. The snapshots reviewed appeared to limit themselves to handles/status rather than transcript bodies; the rejection was based on integration risk and scope, not an assertion that the PR is malicious.

### Review performed

- Audited the PR in a detached worktree rather than contaminating the integration branch.
- Searched server and frontend changes for session content, credentials, API keys, passwords and occupancy data.
- Examined conversation-row and collector shapes.
- Compared secret-store behavior with the current encrypted store.
- Removed the detached audit worktree after review.

### What would make it acceptable later

Treat it as a separate product project. Add one session source at a time, define the API/auth boundary first, preserve encrypted-secret semantics, and require focused tests and live validation for each source.

---

## PR #56 — Multi-model benchmark picker

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/56>

### Why we did not proceed

The PR's selected model is local to the decode dialog only:

- Decode uses the selected model.
- Prefill still silently uses the first/default model.
- Showcase does not receive the user's selected model; it uses `benchmarkModel`/probe default.
- Remote targets do not have a discovered model list.

Therefore the PR description's claim that Showcase uses the selection is not true in the implemented flow. Landing it would create three inconsistent model-selection behaviors across sibling tools.

### Review performed

- Attempted a squash merge and inspected conflicts in `BenchmarkDialog.tsx` and `LlmPanel.tsx`.
- Traced model selection through decode, prefill, Showcase and remote-target paths.
- Reset cleanly to the pre-PR checkpoint after confirming the incomplete behavior.

### What would make it acceptable later

Implement one shared benchmark-target/model selection state used consistently by decode, prefill and Showcase, with explicit remote model discovery or a clearly labeled manual model field.

---

## PR #82 — Pill navigation wrapping beyond eight Sparks

**Source:** <https://github.com/MiaAI-Lab/sparkDash/pull/82>

### Why it was not included tonight

PR #82 appeared after the original backlog review and after the eight-commit integration branch had already been completed and live-tested. It was not part of the reviewed candidate set and has not received code review, conflict analysis, automated integration testing, or live testing from us. It should **not** be represented as accepted or rejected based on tonight's work.

The appropriate next step is an independent review against the now-tested integration branch.

---

## Push recommendation

The eight accepted commits are suitable to propose to upstream `main` **as separate, reviewable commits or a clean PR preserving their order**:

```text
cfa67dd fix(deps): apply undici security update from PR #81
b8226bc feat: apply worker derived labels from PR #79
6997979 fix: apply LLM API key reconciliation from PR #76
3287dd7 fix: isolate monitor polling lifecycles from PR #59
29153a6 fix: reuse SSH transports from PR #77
768160e feat: add q27 LLM backend telemetry from PR #74
374f71a feat: add fleet energy telemetry from PR #63
9631e80 feat: add LLM trend chart from PR #75
```

### Why this branch is a safe push candidate

- Every accepted source PR was narrowed to its intended feature or fix.
- Conflicts were resolved against current `main`, not by choosing an entire stale side.
- Unrelated and stacked commits were excluded.
- Risky or misleading behavior was rejected rather than forced through.
- The branch passed the complete automated gate: **285 tests, typecheck and production build**.
- It was deployed and exercised against the actual four-Spark environment.
- The deployment produced fresh live telemetry without changing any Spark workload.
- The branch remains local; no upstream push or PR was performed without explicit approval.

### Remaining caveats before upstream merge

- Upstream should review the eight commits in order because later features build on the stabilized polling/SSH behavior.
- PR #75 intentionally differs from its source by excluding the invalid TTFT overlay.
- Fleet-energy values are modeled estimates, not wall-meter measurements; the API correctly marks them as estimated.
- q27 behavior has focused automated tests but was not tested against a live q27 server tonight because none of the four Sparks exposed one.
- LLM trend endpoints were live-tested, but the configured LLM ports were unavailable during deployment; no inference workload was started merely to manufacture a green probe.

---

## Reproduction commands

From `/Users/openclaw/repos/sparkDash`:

```bash
git switch integration/pr-backlog
npm test
npm run typecheck
npm run build
git log origin/main..HEAD --reverse --oneline
```

Live dashboard:

```text
http://100.125.180.48:5555
```

No upstream push, merge, Spark update, model restart, or training interruption was performed as part of this report.
