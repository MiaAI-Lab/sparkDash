import test from "node:test";
import assert from "node:assert/strict";
import { collectSystemd } from "../systemd.js";

const LIST_OUT = [
  "vllm.service    loaded active running  vLLM server",
  "ssh.service     loaded active running  OpenBSD SSH daemon",
].join("\n");

// /proc/uptime = 500s → 500,000,000 µs
const SHOW_OUT = [
  "vllm.service=100000000",
  "ssh.service=400000000",
].join("\n");

test("systemd: running services with monotonic-based uptime (ground truth)", async () => {
  const out = await collectSystemd({
    exec: async (cmd) => (cmd.includes("list-units") ? LIST_OUT : SHOW_OUT),
    readFile: async () => "500.000000 250.000000\n",
  });
  assert.deepEqual(out, [
    { name: "vllm.service", status: "running", uptimeSeconds: 400 }, // 500s − 100s
    { name: "ssh.service", status: "running", uptimeSeconds: 100 }, // 500s − 400s
  ]);
});

test("systemd: missing monotonic timestamps → uptimeSeconds null", async () => {
  const out = await collectSystemd({
    exec: async (cmd) => (cmd.includes("list-units") ? LIST_OUT : ""),
    readFile: async () => "500.000000 250.000000\n",
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].uptimeSeconds, null);
});

test("systemd: returns [] when systemctl fails", async () => {
  const exec = async () => {
    throw new Error("systemctl: not found");
  };
  assert.deepEqual(await collectSystemd({ exec, readFile: async () => "1.0 1.0\n" }), []);
});

test("systemd: returns [] with no running services", async () => {
  const out = await collectSystemd({
    exec: async (cmd) => (cmd.includes("list-units") ? "" : ""),
    readFile: async () => "500.000000 250.000000\n",
  });
  assert.deepEqual(out, []);
});
