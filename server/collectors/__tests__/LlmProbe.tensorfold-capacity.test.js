import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { LlmProbe } from "../LlmProbe.js";
import { SparkMonitor } from "../../sparks/SparkMonitor.js";
import { SystemCollector } from "../SystemCollector.js";
import { NATIVE_CAPACITY_SOURCE, NATIVE_TENSORFOLD_CAPACITY_PYTHON,
  nativeTensorFoldCapacityCommand, parseNativeTensorFoldCapacity } from "../tensorfoldCapacity.js";

const observation = (extra = {}) => ({ capacityTokens: 393216, pid: 123, startIdentity: "99",
  configSha256: "a".repeat(64), source: NATIVE_CAPACITY_SOURCE, observedAt: Date.now(), ...extra });
const ready = { status: "ok", warming: false };
const response = (body, status = 200) => ({ ok: status === 200, status,
  json: async () => body, text: async () => JSON.stringify(body) });
const models = { data: [{ id: "primary", owned_by: "tensorfold" }, { id: "alias", owned_by: "tensorfold" }] };

function probe(reader, health = ready) {
  const p = new LlmProbe({ id: "fixture", isLocal: true, platform: "linux" }, 8888,
    { readNativeSharedPool: reader });
  p.backendType = "tensorfold";
  p.serverIsOpenAI = true;
  p.authOpen = true;
  p._lastDetectAt = Date.now();
  p._fetch = async (url) => String(url).endsWith("/v1/models")
    ? response(models) : String(url).endsWith("/health") ? response(health) : response({}, 404);
  return p;
}

test("native capacity observations validate freshness/identity and strip unrelated output", () => {
  const good = observation();
  assert.deepEqual(parseNativeTensorFoldCapacity({ ...good, argv: "never expose" }), good);
  for (const change of [{ capacityTokens: 0 }, { capacityTokens: true }, { capacityTokens: 1.5 },
    { capacityTokens: Number.MAX_SAFE_INTEGER + 1 }, { source: "launcher" }, { pid: 0 },
    { startIdentity: "unknown" }, { configSha256: "bad" }, { observedAt: Date.now() - 11000 },
    { observedAt: Date.now() + 3000 }]) {
    assert.equal(parseNativeTensorFoldCapacity({ ...good, ...change }), null);
  }
  const separate = observation({ poolTokens: 655360 });
  assert.deepEqual(parseNativeTensorFoldCapacity(parseNativeTensorFoldCapacity(separate)), separate);
  assert.equal(parseNativeTensorFoldCapacity({ ...separate, poolTokens: 0 }), null);
  assert.equal(parseNativeTensorFoldCapacity("not json"), null);
  for (const [port, host] of [[0, "127.0.0.1"], [8888, "other.example"], [8888, "127.0.0.1; echo bad"]]) {
    assert.equal(nativeTensorFoldCapacityCommand(port, host), null);
  }
});

test("explicit healthy engine pool takes precedence; free counts are not invented", async () => {
  const p = probe(async () => assert.fail("engine reports capacity"), { ok: true, pool_tokens: 2000 });
  const actual = await p.getSharedPoolCapacity();
  assert.equal(actual.capacityTokens, 2000);
  assert.equal(actual.contextTokens, null);
  assert.equal(actual.availableTokens, null);
  assert.equal(actual.source, "tensorfold-health-pool");
  p._applyTensorFoldPool({ ok: true, pool_tokens: 2000, pool_free_tokens: 800 });
  assert.equal(p.kvCacheTokensAvailable, 800);
  assert.equal(p.kvCacheUsage, 0.6);
  p._applyTensorFoldPool({ ok: true, pool_tokens: 2000, pool_free_tokens: 2001 });
  assert.equal(p.kvCacheTokensAvailable, null);
});

test("warming, failed, malformed and absent health do not publish stale capacity", async () => {
  const p = probe(async () => assert.fail("invalid health must not inspect process"));
  for (const health of [{ status: "error", pool_tokens: 2000 }, { ok: true, warming: true, pool_tokens: 2000 },
    { pool_tokens: 2000 }, { status: "ok", ok: false, pool_tokens: 2000 },
    { status: "ok", warming: false, pool_tokens: "bad" }, null]) {
    p._applyTensorFoldPool({ ok: true, pool_tokens: 5000 });
    p._fetch = async () => response(health);
    assert.equal(await p.getSharedPoolCapacity(), null);
    assert.equal(p.kvCacheTokens, 5000, "independent policy read does not change the poll snapshot");
    p._applyTensorFoldPool(health);
    assert.equal(p.kvCacheTokens, null);
    assert.equal(p.kvCacheTokensSource, null);
  }
  p.authOpen = false;
  assert.equal(await p.getSharedPoolCapacity(), null);
  p.authOpen = true;
  p._fetch = async () => response({}, 503);
  assert.equal(await p.getSharedPoolCapacity(), null);
});

test("native argv gives request context across aliases without inferring pool capacity", async () => {
  let result = observation();
  let calls = 0;
  const p = probe(async () => { calls++; return result; });
  const snap = await p.probe();
  assert.equal(snap.contextLength, 393216);
  assert.equal(snap.kvCacheTokens, null);
  assert.equal(snap.kvCacheTokensAvailable, null);
  assert.equal(snap.kvCacheTokensSource, null);
  assert.equal(Object.hasOwn(snap, "pid"), false);
  const actual = await p.getSharedPoolCapacity();
  assert.equal(actual, null);
  assert.equal(calls, 2); // Getter never reuses the previous poll.
  result = null;
  const failed = await p.probe();
  assert.equal(failed.contextLength, null);
  assert.equal(failed.kvCacheTokens, null);
  assert.equal(failed.kvCacheTokensSource, null);
});

test("the cache group reports different pool and request limits without a host lookup", async () => {
  const health = { ...ready, live: { cache: {
    schema_version: 1,
    consistent: true,
    context_limit_positions: 524288,
    pool: { capacity_positions: 655360, active_reserved_positions: 524288,
      retained_prefix_positions: 0, retained_growth_positions: 0, unclaimed_positions: 131072 },
  } } };
  let reads = 0;
  const p = probe(async () => { reads++; return null; }, health);
  const snapshot = await p.probe();
  assert.equal(snapshot.contextLength, 524288);
  assert.equal(snapshot.kvCacheTokens, 655360);
  assert.equal(snapshot.kvCacheTokensAvailable, null);
  const actual = await p.getSharedPoolCapacity();
  assert.equal(actual.capacityTokens, 655360);
  assert.equal(actual.contextTokens, 524288);
  assert.equal(actual.source, "tensorfold-health-cache");
  assert.equal(reads, 0);

  health.live.cache.pool.unclaimed_positions--;
  assert.equal(await p.getSharedPoolCapacity(), null);
  assert.equal(reads, 0);
});

test("listener context supplements matching engine capacity without overwriting free space", async () => {
  const health = { ...ready, pool_tokens: 655360, pool_free_tokens: 100000 };
  let result = observation({ capacityTokens: 524288, poolTokens: 655360 });
  const p = probe(async () => result, health);
  const snapshot = await p.probe();
  assert.equal(snapshot.contextLength, 524288);
  assert.equal(snapshot.kvCacheTokens, 655360);
  assert.equal(snapshot.kvCacheTokensAvailable, 100000);
  assert.equal((await p.getSharedPoolCapacity()).contextTokens, 524288);
  for (result of [observation({ poolTokens: 524288 }), observation(), null]) {
    const actual = await p.getSharedPoolCapacity();
    assert.equal(actual.capacityTokens, 655360);
    assert.equal(actual.availableTokens, 100000);
    assert.equal(actual.contextTokens, null);
  }
});

test("optional native lookup rejection preserves valid engine capacity", async () => {
  const p = probe(async () => { throw new Error("host unavailable"); }, { ...ready, pool_tokens: 655360 });
  const actual = await p.getSharedPoolCapacity();
  assert.equal(actual.capacityTokens, 655360);
  assert.equal(actual.contextTokens, null);
  assert.equal((await p.probe()).kvCacheTokens, 655360);
});

test("generic tokenizer/model context and pinned other hosts cannot establish shared capacity", async () => {
  const p = probe(async () => assert.fail("pinned target is not the collector host"));
  p.contextLength = 524288;
  p.spark = { ...p.spark, llmHost: "192.0.2.50" };
  assert.equal(await p.getSharedPoolCapacity(), null);
  assert.equal(p.kvCacheTokens, null);
});

test("a target change while a native lookup is in flight cannot publish its result", async () => {
  let finish;
  const p = probe(() => new Promise((resolve) => { finish = resolve; }));
  const pending = p.getSharedPoolCapacity();
  await new Promise(setImmediate);
  assert.equal(typeof finish, "function");
  p.spark = { ...p.spark, lanIp: "192.0.2.51" };
  finish(observation());
  assert.equal(await pending, null);
  assert.equal(p.kvCacheTokens, null);
});

test("a poll discards health fetched before the unit target changes", async () => {
  let finishHealth;
  let startHealth;
  const started = new Promise((resolve) => { startHealth = resolve; });
  let nativeReads = 0;
  const p = probe(async () => { nativeReads++; return observation({ poolTokens: 655360 }); });
  const fetch = p._fetch;
  p._fetch = (url) => String(url).endsWith("/health") ? new Promise((resolve) => {
    finishHealth = resolve;
    startHealth();
  }) : fetch(url);
  const pending = p.probe();
  await started;
  p.spark = { ...p.spark, lanIp: "192.0.2.51" };
  finishHealth(response({ ...ready, pool_tokens: 655360 }));
  const snapshot = await pending;
  assert.equal(snapshot.kvCacheTokens, null);
  assert.equal(snapshot.contextLength, null);
  assert.equal(nativeReads, 0);
});

test("updating a monitored target keeps probe options and switches the HTTP host", async () => {
  const unit = { id: "capacity-test", lanIp: "192.0.2.50", llmPorts: [8888], llmMonitoring: true,
    comfyMonitoring: false, platform: "linux" };
  const liveDecodeTps = () => 8;
  const monitor = new SparkMonitor(unit, { llmProbeOptions: () => ({ liveDecodeTps }) });
  const probe = monitor.llmProbes.get(8888);
  assert.equal(probe._liveDecodeTps, liveDecodeTps);
  assert.equal(probe.baseUrl, "http://192.0.2.50:8888");
  monitor.updateConfig({ ...unit, lanIp: "192.0.2.51", llmPorts: [8888, 9999] });
  assert.equal(monitor.llmProbes.get(8888), probe);
  assert.equal(probe.baseUrl, "http://192.0.2.51:8888");
  const added = monitor.llmProbes.get(9999);
  assert.equal(added._liveDecodeTps, liveDecodeTps);
  monitor.collector.probeNativeTensorFoldCapacity = async (port) => port;
  assert.equal(await added._readNativeSharedPool(9999), 9999);
});

test("collector uses existing host transport, rejects unsupported hosts and changed configuration", async () => {
  const c = new SystemCollector({ id: "fixture", isLocal: true, platform: "linux" });
  let calls = 0;
  c._execOnHostNet = async (command, options) => {
    calls++;
    assert.ok(command.includes("NoRedirect"));
    assert.equal(options.allowContainerFallback, false);
    assert.equal(options.timeout, 4000);
    return JSON.stringify(observation());
  };
  assert.equal((await c.probeNativeTensorFoldCapacity(8888)).capacityTokens, 393216);
  for (const change of [{ platform: "windows" }, { platform: "darwin" }, { llmHost: "192.0.2.5" }]) {
    c.spark = { id: "fixture", isLocal: true, platform: "linux", ...change };
    assert.equal(await c.probeNativeTensorFoldCapacity(8888), null);
  }
  assert.equal(calls, 1);
  c.spark = { id: "fixture", isLocal: true, platform: "linux" };
  c._execOnHostNet = async () => {
    c.spark = { ...c.spark, lanIp: "192.0.2.10" };
    return JSON.stringify(observation());
  };
  assert.equal(await c.probeNativeTensorFoldCapacity(8888), null);
});

const python = ["python3", "python"].find((exe) => spawnSync(exe, ["--version"]).status === 0);
const execute = promisify(execFile);

test("native helper reads only the socket owner's family and rejects replacement/readiness races",
  { skip: process.platform === "win32" || !python }, async (t) => {
    async function fixture(change, onHealth, health = ready) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-capacity-"));
      const proc = path.join(dir, "proc");
      const pid = path.join(proc, "123");
      fs.mkdirSync(path.join(proc, "net"), { recursive: true });
      fs.mkdirSync(path.join(pid, "fd"), { recursive: true });
      fs.mkdirSync(path.join(pid, "root", "model"), { recursive: true });
      fs.mkdirSync(path.join(dir, "bin"));
      const executable = path.join(dir, "bin", "tensorfold-native");
      fs.writeFileSync(executable, "synthetic executable metadata");
      fs.symlinkSync(executable, path.join(pid, "exe"));
      fs.symlinkSync("socket:[4321]", path.join(pid, "fd", "5"));
      const config = path.join(pid, "root", "model", "config.json");
      fs.writeFileSync(config, JSON.stringify({ model_type: "deepseek_v41", architectures: ["DeepseekV41ForCausalLM"] }));
      const stat = (start) => `123 (tensorfold-native) ${["S", ...Array(18).fill("0"), start].join(" ")}\n`;
      fs.writeFileSync(path.join(pid, "stat"), stat("99"));
      const server = http.createServer((req, res) => {
        onHealth?.({ pid, proc, config, stat });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(health));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const argv = ["/bin/tensorfold-native", "serve", "/model", "--backend", "cuda", "--port", String(port), "--context", "393216"];
      fs.writeFileSync(path.join(pid, "cmdline"), argv.join("\0") + "\0");
      fs.writeFileSync(path.join(proc, "net", "tcp"), `header\n0: 00000000:${port.toString(16).padStart(4, "0")} 00000000:0000 0A 0:0 00:0 0 0 0 4321\n`);
      // An unrelated process has no readable cmdline at all; its argv is unnecessary.
      fs.mkdirSync(path.join(proc, "456", "fd"), { recursive: true });
      try {
        change?.({ pid, proc, config, argv });
        const { stdout } = await execute(python, ["-c", NATIVE_TENSORFOLD_CAPACITY_PYTHON, String(port), "127.0.0.1", proc], { timeout: 5000 });
        return JSON.parse(stdout);
      } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    await t.test("actual listener yields explicit request context", async () => {
      assert.equal((await fixture()).capacityTokens, 393216);
    });
    await t.test("listener returns a separately measured pool with the context", async () => {
      const actual = await fixture(null, null, { ...ready, pool_tokens: 655360 });
      assert.equal(actual.capacityTokens, 393216);
      assert.equal(actual.poolTokens, 655360);
      assert.equal(await fixture(null, null, { ...ready, pool_tokens: null }), null);
    });
    await t.test("unsupported family stays unknown", async () => {
      assert.equal(await fixture(({ config }) => fs.writeFileSync(config, JSON.stringify({ model_type: "other" }))), null);
    });
    await t.test("duplicate context option stays unknown", async () => {
      assert.equal(await fixture(({ pid, argv }) => fs.writeFileSync(path.join(pid, "cmdline"), [...argv, "--context", "10"].join("\0") + "\0")), null);
    });
    await t.test("a second listener owner is ambiguous", async () => {
      assert.equal(await fixture(({ proc }) => fs.symlinkSync("socket:[4321]", path.join(proc, "456", "fd", "8"))), null);
    });
    await t.test("PID replacement during health stays unknown", async () => {
      assert.equal(await fixture(null, ({ pid, stat }) => fs.writeFileSync(path.join(pid, "stat"), stat("100"))), null);
    });
    await t.test("model changes during health stay unknown", async () => {
      assert.equal(await fixture(null, ({ config }) => fs.writeFileSync(config, "{}")), null);
    });
  });
