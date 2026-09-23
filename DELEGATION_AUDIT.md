# Multi-Spark Dashboard — Delegation Audit

**Date:** 2026-09-22
**Author:** Jarvis (orchestrator)
**Supersedes:** —
**Companion to:** `IMPLEMENTATION_PLAN.md` (master plan + register)

This audit decides, per capability, whether to DELEGATE (to a node agent), KEEP-DIRECT
(on the dashboard server), or CONSOLIDATE (merge into one place). The decision drives
the architecture: what runs on each Spark (node agent) vs. what runs on the dashboard
server (aggregation, UI).

---

## 0. Decision criteria

| Criterion | DELEGATE (node agent) | KEEP-DIRECT (dashboard server) | CONSOLIDATE |
|---|---|---|---|
| **Locality** | Needs local access (sysfs/proc/docker/systemctl/HTTP) | Needs fleet-wide view | Both |
| **Frequency** | High-frequency (2s poll) | Low-frequency (aggregate) | Both |
| **State** | Local state (running services, memory) | Fleet state (registry, topology) | Both |
| **Actions** | Local actions (start/stop/switch) | Fleet actions (deploy, PR) | Both |
| **Secrets** | Local secrets (API keys, SSH) | Fleet secrets (token) | Both |

**Rule:** if a capability needs local access + high frequency + local state → DELEGATE.
If it needs fleet-wide view + low frequency + fleet state → KEEP-DIRECT. If both → CONSOLIDATE.

---

## 1. Capability audit

| Capability | Decision | Rationale | Batch |
|---|---|---|---|
| **GPU telemetry** | DELEGATE | Local nvidia-smi; high frequency; local state | 1A |
| **CPU telemetry** | DELEGATE | Local /proc/stat; high frequency; local state | 1A |
| **Mem telemetry** | DELEGATE | Local /proc/meminfo; high frequency; local state | 1A |
| **Disk telemetry** | DELEGATE | Local df + iostat; high frequency; local state | 1A |
| **Net telemetry** | DELEGATE | Local /proc/net/dev; high frequency; local state | 1A |
| **Docker telemetry** | DELEGATE | Local docker ps + stats + inspect; high frequency; local state | 1A |
| **Systemd telemetry** | DELEGATE | Local systemctl list-units; high frequency; local state | 1A |
| **LLM telemetry** | DELEGATE | Local HTTP to LLM servers; high frequency; local state | 1A |
| **ComfyUI telemetry** | DELEGATE | Local HTTP to ComfyUI; high frequency; local state | 1A |
| **Versions (live)** | DELEGATE | Local docker inspect + /get_server_info; high frequency; local state | 1A |
| **Recipe catalog** | DELEGATE | Local recipes.json; low frequency; local state | 1B |
| **Memory budgeting** | DELEGATE | Local footprints + free; low frequency; local state | 1B |
| **Service registry** | DELEGATE | Local recipes + live state; low frequency; local state | 1B |
| **Docker actions** | DELEGATE | Local docker start/stop/restart/rm; low frequency; local state | 2A |
| **Audit log** | DELEGATE | Local audit log; low frequency; local state | 2A |
| **Systemd actions** | DELEGATE | Local systemctl start/stop; low frequency; local state | 2B |
| **LLM switch** | DELEGATE | Local LLM stop/start/canary; low frequency; local state | 2B |
| **Node registry** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 3A |
| **Fleet connection** | KEEP-DIRECT | Fleet-wide poll + WS fan-out; high frequency; fleet state | 3A |
| **Requests aggregation** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 3B |
| **Topology model** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 3B |
| **Overview UI** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 4A |
| **Per-node UI** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 4A |
| **Topology UI** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 4A |
| **Service Manager UI** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 4B |
| **Requests UI** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 4B |
| **Memory UI** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 4B |
| **Media catalog** | DELEGATE | Local media recipes; low frequency; local state | 5A |
| **E2E wiring** | CONSOLIDATE | Both local (node agent) + fleet-wide (dashboard) | 5B |
| **Deploy scripts** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 5B |
| **Docs** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 5B |
| **PR prep** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 5B |
| **Live verification** | KEEP-DIRECT | Fleet-wide view; low frequency; fleet state | 6 |

---

## 2. Direct-manipulation audit

**Question:** can the dashboard server manipulate local state directly (vs. via node agent)?

| Capability | Direct manipulation? | Rationale |
|---|---|---|
| **GPU/CPU/Mem/Disk/Net telemetry** | No | Needs local sysfs/proc; dashboard server is remote |
| **Docker telemetry** | No | Needs local docker; dashboard server is remote |
| **Systemd telemetry** | No | Needs local systemctl; dashboard server is remote |
| **LLM/Com** | No | Needs local HTTP; dashboard server is remote |
| **Versions** | No | Needs local docker inspect + /get_server_info; dashboard server is remote |
| **Recipe catalog** | No | Needs local recipes.json; dashboard server is remote |
| **Memory budgeting** | No | Needs local footprints + free; dashboard server is remote |
| **Service registry** | No | Needs local recipes + live state; dashboard server is remote |
| **Docker actions** | No | Needs local docker; dashboard server is remote |
| **Audit log** | No | Needs local audit log; dashboard server is remote |
| **Systemd actions** | No | Needs local systemctl; dashboard server is remote |
| **LLM switch** | No | Needs local LLM; dashboard server is remote |
| **Node registry** | Yes | Fleet-wide view; dashboard server owns it |
| **Fleet connection** | Yes | Fleet-wide poll + WS fan-out; dashboard server owns it |
| **Requests aggregation** | Yes | Fleet-wide view; dashboard server owns it |
| **Topology model** | Yes | Fleet-wide view; dashboard server owns it |
| **Overview UI** | Yes | Fleet-wide view; dashboard server owns it |
| **Per-node UI** | Yes | Fleet-wide view; dashboard server owns it |
| **Topology UI** | Yes | Fleet-wide view; dashboard server owns it |
| **Service Manager UI** | Yes | Fleet-wide view; dashboard server owns it |
| **Requests UI** | Yes | Fleet-wide view; dashboard server owns it |
| **Memory UI** | Yes | Fleet-wide view; dashboard server owns it |
| **Media catalog** | No | Needs local media recipes; dashboard server is remote |
| **E2E wiring** | Both | Local (node agent) + fleet-wide (dashboard) |
| **Deploy scripts** | Yes | Fleet-wide view; dashboard server owns it |
| **Docs** | Yes | Fleet-wide view; dashboard server owns it |
| **PR prep** | Yes | Fleet-wide view; dashboard server owns it |
| **Live verification** | Yes | Fleet-wide view; dashboard server owns it |

---

## 3. Internal duplication scan

**Question:** is any capability implemented in both node agent and dashboard server?

| Capability | Node agent | Dashboard server | Duplication? |
|---|---|---|---|
| **GPU/CPU/Mem/Disk/Net telemetry** | ✅ | ❌ | No (node agent only) |
| **Docker telemetry** | ✅ | ❌ | No (node agent only) |
| **Systemd telemetry** | ✅ | ❌ | No (node agent only) |
| **LLM/ComfyUI telemetry** | ✅ | ❌ | No (node agent only) |
| **Versions** | ✅ | ❌ | No (node agent only) |
| **Recipe catalog** | ✅ | ❌ | No (node agent only) |
| **Memory budgeting** | ✅ | ❌ | No (node agent only) |
| **Service registry** | ✅ | ❌ | No (node agent only) |
| **Docker actions** | ✅ | ❌ | No (node agent only) |
| **Audit log** | ✅ | ❌ | No (node agent only) |
| **Systemd actions** | ✅ | ❌ | No (node agent only) |
| **LLM switch** | ✅ | ❌ | No (node agent only) |
| **Node registry** | ❌ | ✅ | No (dashboard server only) |
| **Fleet connection** | ❌ | ✅ | No (dashboard server only) |
| **Requests aggregation** | ❌ | ✅ | No (dashboard server only) |
| **Topology model** | ❌ | ✅ | No (dashboard server only) |
| **Overview UI** | ❌ | ✅ | No (dashboard server only) |
| **Per-node UI** | ❌ | ✅ | No (dashboard server only) |
| **Topology UI** | ❌ | ✅ | No (dashboard server only) |
| **Service Manager UI** | ❌ | ✅ | No (dashboard server only) |
| **Requests UI** | ❌ | ✅ | No (dashboard server only) |
| **Memory UI** | ❌ | ✅ | No (dashboard server only) |
| **Media catalog** | ✅ | ❌ | No (node agent only) |
| **E2E wiring** | ✅ | ✅ | Yes (both; CONSOLIDATE) |
| **Deploy scripts** | ❌ | ✅ | No (dashboard server only) |
| **Docs** | ❌ | ✅ | No (dashboard server only) |
| **PR prep** | ❌ | ✅ | No (dashboard server only) |
| **Live verification** | ❌ | ✅ | No (dashboard server only) |

**Note:** E2E wiring is CONSOLIDATE — both node agent (local) and dashboard server (fleet-wide)
need to be wired. This is expected; the seam contract (shared/types.ts) ensures they agree.

---

## 4. Consequences

1. **Node agent owns all local state + high-frequency telemetry + local actions.**
   - Batch 1A: collectors (gpu/cpu/mem/disk/net/docker/systemd/llm/comfy) + telemetry + http + versions
   - Batch 1B: recipe catalog + memory budgeting + service registry
   - Batch 2A: docker actions + audit log
   - Batch 2B: systemd actions + LLM switch
   - Batch 5A: media catalog

2. **Dashboard server owns all fleet-wide view + low-frequency aggregation + fleet actions.**
   - Batch 3A: node registry + fleet connection
   - Batch 3B: requests aggregation + topology model
   - Batch 4A: Overview UI + per-node UI + topology UI
   - Batch 4B: Service Manager UI + requests UI + memory UI
   - Batch 5B: e2e wiring + deploy scripts + docs + PR prep
   - Batch 6: live verification

3. **Seam contract (shared/types.ts) ensures node agent and dashboard server agree.**
   - Batch 0: scaffolding + seam contract
   - All batches: validate against shared/types.ts

4. **No duplication (except E2E wiring, which is CONSOLIDATE).**
   - Each capability is implemented in one place (node agent or dashboard server)
   - Seam contract ensures they agree

---

## 5. Verdict summary

| Decision | Capabilities |
|---|---|
| **DELEGATE** (node agent) | GPU/CPU/Mem/Disk/Net telemetry, Docker telemetry, Systemd telemetry, LLM/ComfyUI telemetry, Versions, Recipe catalog, Memory budgeting, Service registry, Docker actions, Audit log, Systemd actions, LLM switch, Media catalog |
| **KEEP-DIRECT** (dashboard server) | Node registry, Fleet connection, Requests aggregation, Topology model, Overview UI, Per-node UI, Topology UI, Service Manager UI, Requests UI, Memory UI, E2E wiring, Deploy scripts, Docs, PR prep, Live verification |
| **CONSOLIDATE** (both) | E2E wiring |
