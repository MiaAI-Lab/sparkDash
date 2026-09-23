/**
 * index.js — public API of the node-agent actions layer.
 *
 * Re-exports all action modules so the HTTP wiring (agent/http.js
 * POST /actions + GET /audit) can import one path:
 *
 *   import { startContainer, stopContainer, restartContainer,
 *            removeContainer, appendAudit, readAudit, startUnit,
 *            stopUnit, restartUnit, canaryProbe, switchLlm } from
 *            "./actions/index.js";
 *
 * Batch 2A: docker.js + audit.js. Batch 2B: systemd.js + llm-switch.js.
 */
export * from "./docker.js";
export * from "./audit.js";
export * from "./systemd.js";
export * from "./llm-switch.js";
