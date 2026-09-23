import test from "node:test";
import assert from "node:assert/strict";
import { collectComfy } from "../comfy.js";

function http(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

function mockFetchComfy() {
  return async (url) => {
    const base = "http://127.0.0.1:8188";
    if (url === `${base}/system_stats`) {
      return http(
        200,
        JSON.stringify({
          system: { comfyui_version: "0.3.30", pytorch_version: "2.5.1" },
          devices: [{ type: "CUDA" }],
        })
      );
    }
    if (url === `${base}/queue`) {
      return http(
        200,
        JSON.stringify({
          queue_running: [
            [
              0,
              "prompt-1",
              { n1: { class_type: "KSampler" }, n2: { class_type: "VAEDecode" } },
              { extra_pnginfo: { workflow: { title: "Test workflow" } } },
            ],
          ],
          queue_pending: [
            [0, "prompt-2", {}, {}],
            [0, "prompt-3", {}, {}],
          ],
        })
      );
    }
    if (url.startsWith(`${base}/api/jobs`)) {
      return http(
        200,
        JSON.stringify({
          jobs: [
            {
              id: "j9",
              status: "completed",
              execution_start_time: 1000,
              execution_end_time: 3000,
            },
          ],
        })
      );
    }
    if (url === `${base}/models/checkpoints`) {
      return http(200, JSON.stringify(["sd_xl_base.safetensors", "flux1.safetensors"]));
    }
    if (url === `${base}/models/loras`) {
      return http(200, JSON.stringify(["lora_a.safetensors"]));
    }
    throw new Error("unexpected url: " + url);
  };
}

test("comfy: full probe parses system_stats + queue + jobs + models (ground truth)", async () => {
  const c = await collectComfy(8188, { fetch: mockFetchComfy() });
  assert.deepEqual(c, {
    port: 8188,
    version: "0.3.30",
    pytorchVersion: "2.5.1",
    deviceType: "CUDA",
    queueRunning: 1,
    queuePending: 2,
    activeJob: { id: "prompt-1", title: "Test workflow", nodeCount: 2 },
    pendingJobs: [
      { id: "prompt-2", title: null, nodeCount: 0 },
      { id: "prompt-3", title: null, nodeCount: 0 },
    ],
    lastJob: { id: "j9", status: "completed", durationMs: 2000 },
    modelsInstalled: {
      checkpoints: ["sd_xl_base.safetensors", "flux1.safetensors"],
      loras: ["lora_a.safetensors"],
    },
  });
});

test("comfy: /api/jobs down → /history fallback", async () => {
  const fetchHist = async (url) => {
    if (url.endsWith("/system_stats")) {
      return http(200, JSON.stringify({ system: { comfyui_version: "0.3.0" }, devices: [] }));
    }
    if (url.endsWith("/queue")) return http(200, JSON.stringify({ queue_running: [], queue_pending: [] }));
    if (url.startsWith("/api/jobs") || url.endsWith("api/jobs")) {
      return http(404, "{}");
    }
    if (url.includes("/history")) {
      return http(200, JSON.stringify({ hist7: { status: { status_str: "success" } } }));
    }
    throw new Error("unexpected url: " + url);
  };
  const c = await collectComfy(8188, { fetch: fetchHist });
  assert.equal(c.lastJob.id, "hist7");
  assert.equal(c.lastJob.durationMs, null);
});

test("comfy: returns null when /system_stats is unreachable", async () => {
  assert.equal(
    await collectComfy(8188, {
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
    null
  );
});

test("comfy: returns null on invalid port", async () => {
  const noFetch = async () => {
    throw new Error("fetch must not run for invalid ports");
  };
  assert.equal(await collectComfy(null, { fetch: noFetch }), null);
  assert.equal(await collectComfy(0, { fetch: noFetch }), null);
  assert.equal(await collectComfy(70000, { fetch: noFetch }), null);
  assert.equal(await collectComfy("8188x", { fetch: noFetch }), null);
  assert.equal(await collectComfy("81.5", { fetch: noFetch }), null);
});

test("comfy: 404 /system_stats → null", async () => {
  assert.equal(
    await collectComfy(8188, {
      fetch: async () => http(404, "{}"),
    }),
    null
  );
});
