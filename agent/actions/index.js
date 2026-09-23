/**
 * index.js — public API of the node-agent actions layer (Batch 2A).
 *
 * Re-exports the docker actions and the audit log so the HTTP wiring
 * (agent/http.js POST /actions + GET /audit, landed by the orchestrator
 * after Batches 2A + 2B) can import one path:
 *
 *   import { startContainer, stopContainer, restartContainer,
 *            removeContainer, appendAudit, readAudit } from "./actions/index.js";
 *
 * Batch 2B (systemd + LLM switch) adds its modules to this file.
 */
export * from "./docker.js";
export * from "./audit.js";
