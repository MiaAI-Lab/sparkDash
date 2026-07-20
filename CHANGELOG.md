# Changelog

All notable changes to **sparkDash** are documented here.  
The README [Latest version changelog](./README.md#latest-version-changelog) always reflects only the current release; this file keeps the full history.

Format: version sections are listed newest first.

---

## [1.1.0] — 2026-07-20

### Added
- **Power management**
  - Per-Spark **Shutdown** and **Wake** controls in the Spark header
  - Overview **Shutdown All** (online Sparks only) and **Wake All**
  - Shutdown runs over SSH: `sudo -n /usr/local/bin/spark-shutdown` (install that script on each host with passwordless sudo for it)
  - Shared Wake-on-LAN helper (`server/wol.js`): MAC validation, `/24` broadcast from LAN IP (fallback `255.255.255.255`), single-settlement UDP send
- **Wake-on-LAN MAC**
  - Auto-detect MAC of the **enP7s7** interface during network polls (local + remote)
  - Persist as `detectedMacAddress` for use when the node is offline
  - Optional **MAC override** in Edit Spark (`macAddress`); Wake uses override → detected → request body
- **Worker node**
  - Edit Spark checkbox **Worker node** (with info tooltip)
  - When set: LLM panels and “Add LLM port” are hidden; LLM ports are not probed
  - **Worker node** badge in the Spark header
- Unit tests for WoL helpers (`test/wol.test.mjs`); `npm test` runs `node --test test/*.test.mjs`
- README notes for power controls and LAN trust model for power APIs

### Notes
- Power APIs are unauthenticated like the rest of the dashboard — keep port **5555** on a trusted network only.

---

## [1.0.5] — 2026-07-20

### Added
- **Multiple LLM ports** — monitor several LLM servers on different ports simultaneously (each port gets its own panel and backend detection)
- **GPU processes** — top GPU processes by VRAM usage (name, PID, memory) in the GPU panel
- **Spark uptime** — system uptime badge inline on each Spark header

### Backend (summary)
- `SparkRegistry`: `llmPorts` array with migration from legacy `llmPort`
- `SparkMonitor`: `Map<port, LlmProbe>` for parallel multi-port polling
- `SystemCollector`: process list via `nvidia-smi`
- API: `PUT` / `POST` / `DELETE` LLM port endpoints

---

## Earlier releases

Versions before **1.0.5** were not recorded in a dedicated changelog. See git history for prior commits (e.g. themes, Docker layout, multi-Spark UI, encrypted SSH secrets).
