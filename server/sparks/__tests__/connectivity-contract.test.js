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
      i18n: { label: { key: "server.connection.label.host.remote" }, message: { key: "server.connection.raw", params: { detail: "SSH timed out" } }, recovery: { key: "server.connection.recovery.hostRemote" } },
    },
    {
      id: "llm",
      label: "LLM API",
      status: "pass",
      required: true,
      message: "Model: test",
      recovery: null,
      i18n: { label: { key: "server.connection.label.llm" }, message: { key: "server.connection.model", params: { model: "test" } } },
    },
    {
      id: "comfy",
      label: "ComfyUI",
      status: "skipped",
      required: false,
      message: "Disabled",
      recovery: null,
      i18n: { label: { key: "server.connection.label.comfy" }, message: { key: "server.connection.disabled" } },
    },
    {
      id: "hermes",
      label: "Hermes Agent",
      status: "skipped",
      required: false,
      message: "Disabled",
      recovery: null,
      i18n: { label: { key: "server.connection.label.hermes" }, message: { key: "server.connection.disabled" } },
    },
    {
      id: "tailnet",
      label: "Tailnet",
      status: "skipped",
      required: false,
      message: "Disabled",
      recovery: null,
      i18n: { label: { key: "server.connection.label.tailnet" }, message: { key: "server.connection.disabled" } },
    },
  ]);
});
