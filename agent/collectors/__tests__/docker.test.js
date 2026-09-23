import test from "node:test";
import assert from "node:assert/strict";
import { collectDocker } from "../docker.js";

const PS_RAW = [
  JSON.stringify({
    Names: "vllm",
    Image: "lmsysorg/sglang:v1.2.0",
    State: "running",
    Status: "Up 2 hours",
    Ports: "0.0.0.0:8080->8080/tcp",
  }),
  JSON.stringify({
    Names: "/oldbox",
    Image: "alpine:3.19",
    State: "exited",
    Status: "Exited (1) 3 days ago",
    Ports: "",
  }),
].join("\n");

const STATS_RAW = JSON.stringify([
  {
    CONTAINER: "abc123",
    NAME: "vllm",
    "CPU %": "12.50%",
    "MEM USAGE": "8.00GiB / 128GiB",
    "MEM %": "6.25%",
    "NET I/O": "0B / 0B",
    "BLOCK I/O": "0B / 0B",
    PIDs: 2,
  },
]);

const INSPECT_VLLM = JSON.stringify({
  ImageID: "sha256:abcdef0123456789",
  State: { Status: "running", StartedAt: "2026-09-22T10:00:00Z" },
  HostConfig: { PortBindings: { "8080/tcp": [{ HostIp: "", HostPort: "8080" }] } },
});

const INSPECT_OLD = JSON.stringify({
  ImageID: "sha256:0000",
  State: { Status: "exited", StartedAt: "2026-09-19T10:00:00Z" },
  HostConfig: { PortBindings: null },
  Config: { ExposedPorts: { "22/tcp": {} } },
});

function mockExec() {
  return async (cmd) => {
    if (cmd.includes("docker ps")) return PS_RAW;
    if (cmd.includes("docker stats")) return STATS_RAW;
    if (cmd.includes("docker inspect")) {
      return cmd.includes('"vllm"') ? INSPECT_VLLM : INSPECT_OLD;
    }
    throw new Error("unexpected command: " + cmd);
  };
}

const NOW = Date.parse("2026-09-22T12:00:00Z");

test("docker: assembles ContainerInfo[] from ps + stats + inspect (ground truth)", async () => {
  const out = await collectDocker({ exec: mockExec(), now: () => NOW });
  assert.equal(out.length, 2);

  const vllm = out.find((c) => c.name === "vllm");
  assert.deepEqual(vllm, {
    name: "vllm",
    image: "lmsysorg/sglang:v1.2.0",
    imageDigest: "sha256:abcdef0123456789",
    status: "running",
    uptimeSeconds: 7200, // 10:00Z → 12:00Z
    ports: ["8080:8080"],
    memUsedMB: 8192, // 8.00GiB
    memLimitMB: 131072, // 128GiB
    cpuPercent: 12.5,
  });

  const old = out.find((c) => c.name === "oldbox");
  assert.deepEqual(old, {
    name: "oldbox",
    image: "alpine:3.19",
    imageDigest: "sha256:0000",
    status: "exited",
    uptimeSeconds: null, // not running
    ports: ["22"], // exposed-only fallback
    memUsedMB: null,
    memLimitMB: null,
    cpuPercent: null,
  });
});

test("docker: NDJSON docker stats variant is parsed", async () => {
  const exec = async (cmd) => {
    if (cmd.includes("docker ps")) return PS_RAW;
    if (cmd.includes("docker stats"))
      return JSON.stringify({
        CONTAINER: "abc123",
        NAME: "vllm",
        "CPU %": "5.00%",
        "MEM USAGE": "1.00GiB / 2.00GiB",
      });
    if (cmd.includes("docker inspect")) return INSPECT_VLLM;
    throw new Error("unexpected command: " + cmd);
  };
  const out = await collectDocker({ exec, now: () => NOW });
  assert.equal(out[0].memUsedMB, 1024);
  assert.equal(out[0].memLimitMB, 2048);
  assert.equal(out[0].cpuPercent, 5);
});

test("docker: returns [] when docker is unavailable", async () => {
  const exec = async () => {
    throw new Error("docker: command not found");
  };
  assert.deepEqual(await collectDocker({ exec }), []);
});

test("docker: returns [] with no containers", async () => {
  const exec = async (cmd) => (cmd.includes("docker ps") ? "" : "[]");
  assert.deepEqual(await collectDocker({ exec, now: () => NOW }), []);
});

test("docker: stats/inspect failure degrades to nulls, not []", async () => {
  const exec = async (cmd) => {
    if (cmd.includes("docker ps"))
      return JSON.stringify({ Names: "solo", Image: "img:1", State: "running" });
    throw new Error("no daemon");
  };
  const out = await collectDocker({ exec, now: () => NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "solo");
  assert.equal(out[0].memUsedMB, null);
  assert.equal(out[0].imageDigest, null);
  assert.equal(out[0].uptimeSeconds, null);
});
