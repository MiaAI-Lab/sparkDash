import { test } from "node:test";
import { strict as assert } from "node:assert";
import net from "net";
import os from "os";
import path from "path";
import fs from "fs";
import {
  allocateLocalPort,
  onceClose,
  probeLlmHttp,
  resolveLlmHttpTarget,
  waitForTcp,
} from "../llmTunnel.js";
import { DecodeBenchManager } from "../DecodeBench.js";

test("onceClose runs the inner fn only once", () => {
  let n = 0;
  const close = onceClose(() => {
    n += 1;
  });
  close();
  close();
  assert.equal(n, 1);
});

test("allocateLocalPort + waitForTcp round-trip", async () => {
  const port = await allocateLocalPort();
  assert.ok(port > 0);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  try {
    await waitForTcp("127.0.0.1", port, 2000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("waitForTcp times out on a closed port", async () => {
  const port = await allocateLocalPort();
  await assert.rejects(() => waitForTcp("127.0.0.1", port, 200), /did not become ready/);
});

test("probeLlmHttp treats 200 as reachable and fetch errors as not", async () => {
  const ok = await probeLlmHttp("127.0.0.1", 9, {
    timeoutMs: 50,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(ok, true);
  const auth = await probeLlmHttp("127.0.0.1", 9, {
    timeoutMs: 50,
    fetchImpl: async () => ({ status: 401 }),
  });
  assert.equal(auth, true);
  const missing = await probeLlmHttp("127.0.0.1", 9, {
    timeoutMs: 50,
    fetchImpl: async () => ({ status: 404 }),
  });
  assert.equal(missing, false);
  const down = await probeLlmHttp("127.0.0.1", 9, {
    timeoutMs: 50,
    fetchImpl: async () => {
      throw new Error("econnrefused");
    },
  });
  assert.equal(down, false);
});

test("resolveLlmHttpTarget: local uses loopback without probing", async () => {
  let probed = 0;
  const t = await resolveLlmHttpTarget(
    { isLocal: true, lanIp: "192.168.1.151" },
    8888,
    {
      probe: async () => {
        probed += 1;
        return true;
      },
      openTunnel: async () => {
        throw new Error("should not tunnel");
      },
    }
  );
  assert.equal(t.host, "127.0.0.1");
  assert.equal(t.port, 8888);
  assert.equal(t.via, "direct");
  assert.equal(probed, 0);
});

test("resolveLlmHttpTarget: remote uses LAN when probe succeeds", async () => {
  const t = await resolveLlmHttpTarget(
    { isLocal: false, lanIp: "192.168.1.143" },
    8888,
    {
      probe: async () => true,
      openTunnel: async () => {
        throw new Error("should not tunnel");
      },
    }
  );
  assert.equal(t.host, "192.168.1.143");
  assert.equal(t.port, 8888);
  assert.equal(t.via, "direct");
});

test("resolveLlmHttpTarget: remote falls back to SSH tunnel when LAN is closed", async () => {
  let tunneled = 0;
  const t = await resolveLlmHttpTarget(
    {
      isLocal: false,
      lanIp: "192.168.1.143",
      ssh: { host: "192.168.1.143", user: "mia", auth: "key" },
    },
    8888,
    {
      probe: async () => false,
      openTunnel: async (_spark, port) => {
        tunneled += 1;
        assert.equal(port, 8888);
        return {
          host: "127.0.0.1",
          port: 41234,
          via: "ssh-tunnel",
          close: () => {},
        };
      },
    }
  );
  assert.equal(tunneled, 1);
  assert.equal(t.host, "127.0.0.1");
  assert.equal(t.port, 41234);
  assert.equal(t.via, "ssh-tunnel");
});

test("resolveLlmHttpTarget: combines LAN + tunnel errors", async () => {
  await assert.rejects(
    () =>
      resolveLlmHttpTarget(
        { isLocal: false, lanIp: "192.168.1.212", ssh: { user: "zurih", auth: "key" } },
        8888,
        {
          probe: async () => false,
          openTunnel: async () => {
            throw new Error("SSH config missing");
          },
        }
      ),
    /192\.168\.1\.212:8888[\s\S]*SSH config missing/
  );
});

test("DecodeBench closes resolveTarget when the LLM is down", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decode-bench-"));
  const mgr = new DecodeBenchManager(
    path.join(dir, "hist.json"),
    path.join(dir, "active.json")
  );
  let closed = 0;
  const started = mgr.start({
    sparkId: "remote-1",
    lanIp: "127.0.0.1",
    port: 1,
    modelId: "m",
    concurrencies: [1],
    maxTokens: 64,
    resolveTarget: async () => ({
      host: "127.0.0.1",
      port: 1,
      via: "direct",
      close: () => {
        closed += 1;
      },
    }),
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const job = mgr.getJob(started.benchId);
        if (job && job.status !== "running") {
          assert.equal(closed, 1);
          return;
        }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("decode bench did not finish");
});
