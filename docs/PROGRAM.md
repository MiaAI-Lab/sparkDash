# sparkDash Program Charter

Owner: **Nyx** (nvoss@onyxailabs.com). Program start: 2026-09-07. Host: Onyx Mac Studio.

## 1. Scope

sparkDash is the **live fleet dashboard** for the Onyx fleet. This charter covers its operation
and evolution on the Mac Studio:

- Running production instance at **http://127.0.0.1:5555** (loopback; remote access only via
  authenticated front door — see `docs/REMOTE-ACCESS.md`).
- Code evolution in the fork `MikeGibbsOnyx/sparkDash` (remote `mike`).
- Ops hygiene: backups, promote procedure, weekly reporting.

Out of scope unless Mike explicitly expands it: upstream contributions to MiaAI-Lab/sparkDash,
deployments to other hosts, any external-facing exposure of :5555.

## 2. Production is sacred (:5555)

The live dashboard at :5555 is **production**. Rules:

1. **Promote-with-backup only.** Before any change touches the live instance:
   - snapshot the current running state (config + data dir backup, and the git commit/tag of the
     running build),
   - verify the rollback path works (previous build can be restored and serves :5555).
2. Never edit live files in place. Build/test in a worktree or scratch checkout, then promote.
3. A promote is not done until the new build is **verified serving on :5555** (HTTP 200 on `/`,
   API smoke on `/api/*`, WebSocket `/ws` connects).
4. Security posture stays fail-closed: loopback bind by default; non-loopback bind requires
   `SPARKDASH_TOKEN` + authenticated front door (Tailscale Serve / authenticated reverse proxy).
   Firewall-only exposure is not allowed.

## 3. Repository topology

| Remote | Repo | Role |
|---|---|---|
| `mike` | `MikeGibbsOnyx/sparkDash` | **Ours.** All work lands here (fork). |
| `origin` | `MiaAI-Lab/sparkDash` | Upstream — **read-only, untouched.** No pushes, ever. |

Conventions:

- Feature/fix branches: `onyx/<topic>-<date>` or `builder/<pr-topic>`.
- Merge to fork `main` only after the Definition of Done (§5) is met.
- Upstream sync (fetch-only) is fine; rebasing/merging upstream into our main is a deliberate,
  reviewed operation, not a routine.

## 4. Cadence & owners

- **Weekly ops-review card to Mike** — one Kanban card per week, assignee `nyx`, containing:
  - **Done** — shipped/verified items (with proof: commit, test run, live check);
  - **Blocked** — real blockers with kind (dependency / needs_input / capability / transient);
  - **Next** — the following week's plan.
- **Nyx** — program owner: charter, promotion gatekeeper, weekly report, board hygiene.
- **Mike** — final GO for: external exposure changes, spending, destructive actions, upstream
  interactions.
- Builder/builder-a/b/c profiles — implement children of program cards; they do not promote to
  production themselves.

## 5. Definition of Done

A change is **done** only when at least one of these is recorded:

- **Verified live on :5555** — the change is running in production and evidenced (HTTP check,
  API response, screenshot/CLI output in the card metadata); or
- **Recorded test gate** — named test/typecheck/build run passed, output attached to the card.

"Wrote code" is not done. PRs opened without a gate recorded are `not done`. Stalled work stays
visible on the board — it never rots silently in a branch.

## 6. Current state (2026-09-07)

- Live: node serving :5555, HTTP 200 verified at charter time (PID 25135, bound `*:5555` —
  open bind from the Tailscale promote branch `onyx/live-promote-2026-09-07`; token gate
  applies to mutations/WS per REMOTE-ACCESS.md).
- Active branch: `onyx/live-promote-2026-09-07` (8c6b21f).
- Open workstreams: `onyx/remediate-*` branches (security, durability, telemetry, validation,
  install-ops, product-ux) from the 2026-09-07 deep audit.

Charter changes require a commit to the fork and a note in the weekly card.
