import test from "node:test";
import assert from "node:assert/strict";
import {
  ComfyProbe,
  summarizeComfyPrompt,
  estimateQueueEtaMs,
} from "../ComfyProbe.js";
import { reduceComfyProgressMessage } from "../ComfyProgressSocket.js";

test("ComfyProbe defaults when host unreachable", async () => {
  const probe = new ComfyProbe({ isLocal: true, lanIp: "127.0.0.1" }, 1);
  const snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.equal(snap.port, 1);
  assert.equal(snap.queueRunning, 0);
  assert.equal(snap.activeJob, null);
  assert.ok(snap.openUrl.includes(":1"));
  assert.ok(snap.error);
  probe.dispose();
});

test("ComfyProbe setTarget updates port and host", () => {
  const probe = new ComfyProbe({ isLocal: false, lanIp: "10.0.0.5" }, 8188);
  assert.match(probe.baseUrl, /10\.0\.0\.5:8188/);
  probe.setTarget({ isLocal: true, lanIp: "10.0.0.5" }, 9001);
  assert.equal(probe.port, 9001);
  assert.match(probe.baseUrl, /127\.0\.0\.1:9001/);
  probe.dispose();
});

test("summarizeComfyPrompt extracts models and footprint", () => {
  const summary = summarizeComfyPrompt({
    "3": {
      class_type: "KSampler",
      inputs: { steps: 20, sampler_name: "euler", model: ["4", 0] },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "models/checkpoints/v1-5.safetensors" },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: 512, height: 768, batch_size: 2 },
    },
  });
  assert.equal(summary.nodeCount, 3);
  assert.equal(summary.steps, 20);
  assert.equal(summary.width, 512);
  assert.deepEqual(summary.models, ["v1-5.safetensors"]);
  assert.equal(summary.nodeLabels["3"], "KSampler");
});

test("estimateQueueEtaMs uses progress and pending", () => {
  const eta = estimateQueueEtaMs({
    avgDurationMs: 100_000,
    queuePending: 2,
    running: true,
    progressPercent: 50,
  });
  // 50% remaining of 100s + 2 * 100s = 250s
  assert.equal(eta, 250_000);
});

test("reduceComfyProgressMessage handles progress and executing", () => {
  let st = null;
  st = reduceComfyProgressMessage(st, {
    type: "executing",
    data: { node: "3", prompt_id: "abc" },
  }, { "3": "KSampler" });
  assert.equal(st.nodeLabel, "KSampler");
  st = reduceComfyProgressMessage(st, {
    type: "progress",
    data: { value: 5, max: 20, prompt_id: "abc", node: "3" },
  }, { "3": "KSampler" });
  assert.equal(st.percent, 25);
  st = reduceComfyProgressMessage(st, {
    type: "execution_success",
    data: { prompt_id: "abc" },
  });
  assert.equal(st, null);
});

test("ComfyProbe parses running queue into activeJob + openUrl", async () => {
  const prompt = {
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "flux1-dev.safetensors" },
    },
    "3": {
      class_type: "KSampler",
      inputs: { steps: 28, sampler_name: "euler" },
    },
  };
  const queueItem = [
    0,
    "a1b2c3d4-e5f6-7a89-b0c1-d2e3f4a5b6c7",
    prompt,
    {
      create_time: Date.now() - 5000,
      extra_pnginfo: { workflow: { title: "Portrait run" } },
    },
    [],
  ];

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/system_stats")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          system: { comfyui_version: "0.29.0", pytorch_version: "2.13.0+cpu" },
          devices: [{ type: "cpu" }],
        }),
      };
    }
    if (u.includes("/queue") && !u.includes("api")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ queue_running: [queueItem], queue_pending: [] }),
      };
    }
    if (u.includes("/api/jobs")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jobs: [
            {
              id: "prev",
              status: "completed",
              workflow_id: "Upscale pass",
              execution_start_time: 1000,
              execution_end_time: 31000,
            },
          ],
        }),
      };
    }
    if (u.includes("/models/")) {
      return { ok: true, status: 200, json: async () => ["a.safetensors"] };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  try {
    const probe = new ComfyProbe({ isLocal: true }, 8188);
    const snap = await probe.probe();
    assert.equal(snap.available, true);
    assert.equal(snap.activeJob.title, "Portrait run");
    assert.deepEqual(snap.activeJob.models, ["flux1-dev.safetensors"]);
    assert.equal(snap.lastJob?.title, "Upscale pass");
    assert.equal(snap.lastJob?.durationMs, 30000);
    assert.equal(snap.modelsInstalled?.checkpoints?.[0], "a.safetensors");
    assert.ok(snap.queueEtaMs > 0);
    assert.ok(snap.progress); // estimate while running
    // openUrl prefers LAN IP for browser deep links (not loopback probe host)
    assert.equal(snap.openUrl, "http://127.0.0.1:8188"); // no lanIp on this spark
    probe.dispose();
    // Allow any in-flight WS handshake to settle without failing the suite
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("openUrl prefers lanIp over localhost probe host", () => {
  const probe = new ComfyProbe(
    { isLocal: true, lanIp: "192.168.1.50", ssh: { host: "192.168.1.50" } },
    8188
  );
  assert.equal(probe.openUrl(), "http://192.168.1.50:8188");
  assert.match(probe.baseUrl, /127\.0\.0\.1:8188/); // probe still loopback when local
  probe.dispose();
});
