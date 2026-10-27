/**
 * GET/POST /api/memory-mode — the Qwen ⇄ Ollama exclusive-stack switcher.
 * Registered after the auth and Host/Origin middleware, so a token (when
 * SPARKDASH_TOKEN is set) is required exactly as for power actions; nothing here
 * re-implements auth. A switch runs host scripts and the docker CLI as the host
 * user, so it uses the destructive-action limiters, and every attempt — success
 * or failure — lands in the Activity log with the server's honest per-step
 * message.
 */
export function registerMemoryModeRoutes(app, { manager, recordEvent, allowChange, rejectLimited }) {
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      // Errors from the manager carry a status and a curated message; anything else stays generic.
      const known = Number.isInteger(err?.status);
      res.status(known ? err.status : 500).json({ error: known ? err.message : "Memory mode action failed", code: err?.code });
    }
  };

  app.get(
    "/api/memory-mode",
    handle(async (_req, res) => {
      res.json(await manager.getStatus());
    })
  );

  app.post(
    "/api/memory-mode",
    handle(async (req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many memory-mode switches, try again in a minute");
      // Validate the mode first: a typo is a 400 whether or not the feature is on,
      // exactly like the tool-eval route rejects an unknown benchmark type.
      const mode = req.body?.mode;
      if (mode !== "qwen" && mode !== "ollama") {
        return res.status(400).json({ error: `Unknown mode "${String(mode).slice(0, 40)}" — expected "qwen" or "ollama"` });
      }
      if (!manager.enabled) {
        return res.status(409).json({
          error: manager.problem
            ? `Memory mode is misconfigured and disabled: ${manager.problem}`
            : "Memory mode switcher is disabled (set MEMORY_MODE_ENABLED=1)",
        });
      }
      if (manager.busy) return res.status(409).json({ error: "A memory-mode switch is already running" });
      const out = await manager.switchTo(mode);
      recordEvent({
        type: "memory.mode.switch",
        severity: out.status === "success" ? "info" : "warning",
        message: `Memory mode → ${mode}: ${out.message}`,
      });
      res.json(out);
    })
  );
}
