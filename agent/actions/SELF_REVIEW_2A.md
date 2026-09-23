# SELF_REVIEW_2A — Batch 2A: Docker actions + append-only audit log

Worker 2A, pre-gate self-review. Scope: `agent/actions/docker.js`,
`agent/actions/audit.js`, `agent/actions/index.js`, tests in
`agent/actions/__tests__/`. `agent/http.js` / `agent/main.js` untouched
(orchestrator wires after Batch 2B).

## Expected inputs / outputs — and why they matter

**docker.js** — input: `(name, opts)`, where `name` is a container name/id
and `opts` mirrors the `ActionRequest` seam fields (`actionId`,
`serviceName`, `timeoutMs`). Output: `Promise<ActionResponse>`
(`shared/types.ts`): `{actionId, serviceName, status, ok, message, error,
durationMs, idempotent, at}`. Why it matters: the dashboard server will
POST these to `POST /actions`; a malformed response breaks the fleet UI's
action feedback, and a non-exact-argv implementation would open a shell
injection hole on every Spark.

**audit.js** — input: one `AuditEntry` (`{ts, action, serviceName, port,
modelId, engine, status, message, durationMs}`); output: one JSONL line
appended to `agent/config/audit.log` (default, configurable via
`opts.path`); `readAudit(limit=50)` returns the last N parsed entries. Why
it matters: fleet actions run across unattended Spawns; the audit trail is
the only after-the-fact evidence of who did what, so append-only /
content-preservation / never-throw are load-bearing.

## The 7 questions

1. **Inputs that endanger the PROJECT goal — handled?**
   Shell metacharacters in `name` cannot break out: the command runs via
   `execFile("docker", [verb, name])` (no shell, `docker.js:runAction`), so
   `name` is a single argv entry. Witness: test "exact-argv: shell
   metacharacters in name stay ONE argv entry" asserts
   `args.length === 2` and `args[1] === "a; rm -rf / && echo pwned"`.

2. **Inputs that break THIS code — handled?**
   Non-string / empty / NUL / newline / >1024-char names are rejected
   before any process spawns (`nameError`), returning a well-formed
   failure `ActionResponse` with `error: "invalid container name: …"` and
   `durationMs: 0`. `opts` of `undefined`/`null`/non-object is normalized to
   `{}`. Witnesses: test "invalid name: empty / non-string / oversized →
   failure WITHOUT spawning" (asserts `calls.length === 0`) and test
   "opts: undefined and null tolerated".

3. **Outputs detrimental to the PROJECT — prevented?**
   `actionId`/`serviceName` defaults never collide or leak: `actionId`
   defaults to `act-<epoch>-<random8>`; `serviceName` defaults to the
   container name. `at` and `durationMs` are always real numbers (never
   `null` from this batch — `null` is reserved for in-flight "running"
   responses, which these synchronous actions never emit). Test "defaults:
   actionId generated, serviceName falls back to container name".

4. **Outputs that break the NEXT package — prevented?**
   Response keys match `ActionResponse` exactly (no extras, no renames):
   `actionId, serviceName, status, ok, message, error, durationMs,
   idempotent, at` — asserted field-by-field in the exit-0 test. `status`
   only ever emits `"success" | "failure"` from this module; `"running"`
   is documented as reserved for Batch 2B. Audit lines are exactly
   `JSON.stringify(entry) + "\n"` (single line, no embedded newlines
   possible from `JSON.stringify`), so the JSONL invariant the dashboard's
   `/audit` reader relies on holds. Test "appendAudit: appends after
   sentinel entries" deep-equals the parsed line against the entry.

5. **Optimal input → optimal output — confirmed?**
   `startContainer("qwen38-sglang", {actionId, serviceName, execFile})`
   with exit 0 → `{ok: true, status: "success", error: null, idempotent:
   true, message: "docker start qwen38-sglang → exit 0"}` — asserted in
   full in test "startContainer: exit 0".

6. **Degenerate input → prevents bad output?**
   - 600-char stderr → `error` exactly 500 chars (test "stderr is
     truncated to 500 chars"; `ERROR_MAX_CHARS = 500`).
   - Non-zero exit with empty stderr → fallback error text
     `"docker stop exited with code 7"`, never an empty-string error
     (test "empty stderr on failure").
   - Audit: `null`/array/string entries are rejected with a `console.log`,
     no line written, no file created (test "appendAudit: invalid
     entries"); entry without `ts` gets `Date.now()` (test "entry without
     ts").

7. **Out-of-bounds input → reasonable error BEFORE crashing?**
   - Audit `readAudit(0)` → `[]`; `readAudit(-3)` / `readAudit("ten")` →
     default 50; missing file → `[]`; malformed lines skipped. No throw on
     any path (tests "readAudit out-of-bounds limits", "readAudit: missing
     file", "readAudit: malformed lines skipped").
   - Unwritable audit path → `console.log` + resolve, never reject
     (test "graceful degradation: unwritable path → no throw,
     console.log called").
   - docker binary missing (ENOENT) → `error: "docker not found"`
     (test "docker not found (ENOENT)"), mirroring the collectors'
     graceful-degradation convention.

## Findings and rulings

- **FIX (shipped, red-then-green witness):** first test run failed at
  "opts: undefined and null tolerated" — the test created a fake `execFile`
  but did not inject it for the `null`-opts case, so the *real*
  `docker stop c` ran against the live daemon (safe no-op: no container
  `c`). Fixed by driving the null/undefined-opts cases through the
  hermetic fast-fail path; the single real-spawn check uses a guaranteed
  non-existent container name. Red: `AssertionError false !== true`
  (run 1, 24/25); green: run 2, 25/25.
- **NOTE — documented deviation from test spec wording (ruling: house
  pattern chosen over experimental flag):** spec said "mock
  `child_process.execFile`". Implemented as an injectable
  `opts.execFile` seam with the identical `(file, args, options, cb)`
  signature, because on this host's Node v24.21.0 `t.mock.module` requires
  `--experimental-test-module-mocks` AND does not update already-resolved
  static import bindings (empirical witnesses: probes in
  `/tmp/worker2a-probe/`, 2026-09-22). The fake replaces execFile at the
  call seam, so the exact-argv assertions are unchanged. Matches the
  established collectors DI pattern (`collectors/docker.js` `exec` param).
  Plain `node --test` runs with no flags.
- **NOTE — out-of-scope latent defect, flagged for orchestrator (NOT
  fixed; `shared/types.ts` is Batch 0 / Batch 5B write-scope only):**
  `shared/types.ts` is missing the `export interface ActionResponse {`
  declaration line between the "One action response" doc comment and its
  fields (the block ends with a dangling `}`), and several unions carry
  stray `""` members (e.g. `status: "success" | "failure" | "" |
  "running"` in ActionResponse/AuditEntry, `action: … | "" | "switch"`).
  Batch 2A implements the *field shapes* exactly as written; Batch 5B
  should repair the interface declaration.
- **NOTE — audit.log gitignore:** `agent/config/audit.log` is created only
  at runtime on a real node (tests use `mkdtemp` dirs; verified
  `agent/config/` still contains only `recipes.example.json`). No
  `.gitignore` entry was added (outside 2A read/write scope); recommend
  the orchestrator add `agent/config/audit.log` when wiring Batch 2.

## Verification

- `node --test agent/actions/__tests__/docker.test.js
  agent/actions/__tests__/audit.test.js` → **25/25 pass, 0 fail**
  (Node v24.21.0, Narthex).
- `node -e "import('./agent/actions/index.js')…"` → all 10 expected
  exports present (`startContainer, stopContainer, restartContainer,
  removeContainer, appendAudit, readAudit, DEFAULT_TIMEOUT_MS,
  ERROR_MAX_CHARS, DEFAULT_AUDIT_PATH, DEFAULT_READ_LIMIT`).
- Real execFile error shapes (timeout `killed:true/SIGTERM/code:null`,
  ENOENT `code:'ENOENT'`, non-zero exit `code:<n>` + separate stderr arg)
  empirically probed on this host before the fakes were written.
