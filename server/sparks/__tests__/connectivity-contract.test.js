import test from "node:test";
import assert from "node:assert/strict";
import { buildConnectivityPlan, summarizeConnectivity } from "../../connectivity.js";

test("connectivity plan requires only enabled capabilities and uses local collectors", () => {
  const plan = buildConnectivityPlan({
    isLocal: true,
    role: "standalone",
    llmMonitoring: false,
    comfyMonitoring: true,
    hermesMonitoring: false,
    tailscaleMonitoring: true,
  });

  assert.deepEqual(plan, [
    { id: "host", label: "Local collectors", required: true, enabled: true },
    { id: "llm", label: "LLM API", required: false, enabled: false },
    { id: "comfy", label: "ComfyUI", required: true, enabled: true },
    { id: "hermes", label: "Hermes Agent", required: false, enabled: false },
    { id: "tailnet", label: "Tailnet", required: true, enabled: true },
  ]);
});

test("connectivity summary is honest per capability", () => {
  const plan = buildConnectivityPlan({ isLocal: false, role: "head" });
  const result = summarizeConnectivity(plan, {
    host: { ok: false, message: "SSH timed out" },
    llm: { ok: true, message: "Model: test" },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.capabilities, [
    {
      id: "host",
      label: "Remote SSH",
      status: "fail",
      required: true,
      message: "SSH timed out",
      recovery: "Check the host address, SSH user, key/password, and network route.",
    },
    {
      id: "llm",
      label: "LLM API",
      status: "pass",
      required: true,
      message: "Model: test",
      recovery: null,
    },
    {
      id: "comfy",
      label: "ComfyUI",
      status: "skipped",
      required: false,
      message: "Disabled",
      recovery: null,
    },
    {
      id: "hermes",
      label: "Hermes Agent",
      status: "skipped",
      required: false,
      message: "Disabled",
      recovery: null,
    },
    {
      id: "tailnet",
      label: "Tailnet",
      status: "skipped",
      required: false,
      message: "Disabled",
      recovery: null,
    },
  ]);
});
