# Multi-Spark Dashboard — Master Orchestrator

**Date:** 2026-09-22
**Author:** Jarvis (orchestrator)
**Master Plan Reference:** `IMPLEMENTATION_PLAN.md`
**Session:** agent:main:dashboard:d3982d76-ceee-43c9-8e6b-9134c205ed3e

## Tool Policy Status

| Tool | Status | Verified At | Verified By |
|---|---|---|---|
| exec | ✓ | 2026-09-22 | orchestrator |
| read | ✓ | 2026-09-22 | orchestrator |
| write | ✓ | 2026-09-22 | orchestrator |
| edit | ✓ | 2026-09-22 | orchestrator |
| ls | ✓ | 2026-09-22 | orchestrator |
| web_search | ✓ | 2026-09-22 | orchestrator |
| web_fetch | ✓ | 2026-09-22 | orchestrator |
| sessions_spawn | ✓ | 2026-09-22 | orchestrator |
| sessions_yield | ✓ | 2026-09-22 | orchestrator |
| subagents | ✓ | 2026-09-22 | orchestrator |

## Required Tools per Sub-Batch

| Sub-Batch | Required Tools | Dependencies |
|---|---|---|
| 0 (in-house) | exec, read, write, edit, ls | — |
| 1A | exec, read, write, edit | Batch 0 (shared/types.ts, shared/api.schema.json) |
| 1B | exec, read, write, edit | Batch 0 (shared/types.ts, shared/recipe.schema.json) |
| 2A | exec, read, write, edit | Batch 1A (telemetry.js, http.js) |
| 2B | exec, read, write, edit | Batch 1A (telemetry.js, http.js), Batch 1B (services.js) |
| 3A | exec, read, write, edit | Batch 0 (shared/types.ts, shared/api.schema.json) |
| 3B | exec, read, write, edit | Batch 0 (shared/types.ts, shared/api.schema.json) |
| 4A | exec, read, write, edit | Batch 3A (registry.js, connection.js) |
| 4B | exec, read, write, edit | Batch 3A (registry.js, connection.js) |
| 5A | exec, read, write, edit | Batch 1B (recipes.js, memory.js) |
| 5B | exec, read, write, edit | Batch 3A/3B, Batch 4A/4B, Batch 5A |
| 6 | exec, read, write, edit | All batches |

## Active Dispatch Log

| Batch | Spawn | Status | Commits | Notes |
|---|---|---|---|---|
| 0 | in-house | DONE | 05e27fa | Planning docs + seam contracts + scaffolding |
| 1A | 2026-09-22 20:50 | DONE | 16a6b3d | Node-agent collectors + telemetry + http + versions; 101/101 tests pass; live smoke on Narthex |
| 1B | 2026-09-22 20:50 | DONE | 7258098 | Recipe catalog + memory budgeting; 40/40 tests pass |
| 2A | 2026-09-22 22:30 | DONE | 0cfc831 | Docker actions + audit log; 126 tests (with 2B) |
| 2B | 2026-09-22 22:30 | DONE | a5a97f8 | Systemd actions + LLM switch; 57 tests; 183/183 full suite |
| 3A | 2026-09-23 07:40 | DONE | 1399835 | Node registry + fleet connection; 48 tests |
| 3B | 2026-09-23 07:40 | DONE | 9849245 | Requests aggregation + topology; 15 tests; 63/63 full fleet suite |
| 4A | 2026-09-23 08:40 | PENDING | — | Overview/fleet + per-node detail + roles/RoCE diagram |
| 4B | 2026-09-23 08:40 | PENDING | — | Service Manager tab + requests viz + memory budgeting UI |

## Gate Findings Log

| Batch | Defect | Severity | Decision | Durable rule |
|---|---|---|---|---|
| 0 | — | — | — | — |

## Standing Dispatch Rules

1. Sequential dispatch only (parallel requires declared disjoint sets).
2. Worker context budget: enumerated read-list, ≤ ~2,000 lines / 10 files.
3. Orchestrator-only DONE: verified commit + orchestrator-run gate (≥3×).
4. Flaky gate = failed gate.
5. Semantic gate: green tests ≠ correctness. Known-answer test required.
6. State-mutation gate: idempotency, content preservation, append-not-overwrite.
7. Dead-wiring: every knob proven; every fallback exercised.
7. Fix cycles: red-then-green witness per defect; orchestrator claim-audits.
9. Worker pre-gate self-review: artifact required; orchestrator claim-audits.
10. Workers forbidden destructive git (no git clean, git reset --hard, git checkout .).
11. One tracked plan (IMPLEMENTATION_PLAN.md) is also the register.
12. Specify the METHOD not just the invariant.
13. Specify the SEAM CONTRACT (input/output format between batches).
14. When a seam changes, enumerate ALL consumers.

## Recovery

- **Check uncommitted work:** `git status --short` in the repo.
- **Check dispatch log:** `ORCHESTRATION.md` → Active Dispatch Log.
- **Check gate findings:** `ORCHESTRATION.md` → Gate Findings Log.
- **Check running log:** `IMPLEMENTATION_PLAN.md` → §6 Running log.
- **Check open register:** `IMPLEMENTATION_PLAN.md` → §3a Open register.

## Worker Model

Both workers run on the 256k-context local qwen38 endpoint:
- **Model:** `vllm/qwen3.8-27b`
- **Base URL:** `http://gx10-1c2c:8081/v1` (keepalive proxy fronting :8080)
- **Context:** 262144 tokens
- **Max tokens:** 65536
- **Reasoning:** true
- **Key:** `/home/steve/.config/qwen38/api-key` (32-char)

## Parallel Safety

Within each batch, the two workers own **disjoint directories**:
- **Batch 1:** 1A: `agent/collectors/`, `agent/telemetry.js`, `agent/http.js` · 1B: `agent/catalog/`, `agent/config/`
- **Batch 2:** 2A: `agent/actions/docker.js`, `agent/actions/audit.js` · 2B: `agent/actions/systemd.js`, `agent/actions/llm-switch.js`
- **Batch 3:** 3A: `server/fleet/registry.js`, `server/fleet/connection.js` · 3B: `server/fleet/aggregate.js`, `server/fleet/topology.js`
- **Batch 4:** 4A: `src/components/OverviewPage/`, `src/components/SparkPage/`, `src/components/Topology/` · 4B: `src/components/ServiceManager/`, `src/components/Requests/`
- **Batch 5:** 5A: `agent/catalog/media.js`, `agent/config/media-recipes.json` · 5B: `deploy/`, `docs/`, `docker-compose.yml`

**Shared scaffolding** (Batch 0) is committed before dispatch:
- `shared/types.ts`, `shared/api.schema.json`, `shared/recipe.schema.json`, `shared/README.md`
- `agent/package.json`, `agent/main.js`
- `IMPLEMENTATION_PLAN.md`, `TEST_PLAN.md`, `DELEGATION_AUDIT.md`, `ORCHESTRATION.md`
