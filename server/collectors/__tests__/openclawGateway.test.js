/**
 * OpenClaw gateway WS RPC (sessions.list + config.get).
 * Injected identity — does not persist secrets. Loopback mock only.
 * Run: node --test server/collectors/__tests__/openclawGateway.test.js
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { defaultOpenClawGatewayRpc, gatewayWsUrl } from "../openclawGateway.js";

test("gatewayWsUrl maps http(s) origin without path", () => {
  assert.equal(gatewayWsUrl("http://127.0.0.1:18789/"), "ws://127.0.0.1:18789");
  assert.equal(gatewayWsUrl("https://example.com:8443/ui"), "wss://example.com:8443");
});

test("defaultOpenClawGatewayRpc lists sessions and providers over WebSocket", async () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const identity = {
    deviceId: "a".repeat(64),
    publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const port = await new Promise((resolve) => {
    server.on("listening", () => resolve(server.address().port));
  });
  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n1", ts: 1 } })
    );
    socket.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === "connect") {
        assert.equal(msg.params?.client?.id, "cli");
        assert.ok(msg.params?.device?.signature);
        socket.send(
          JSON.stringify({ type: "res", id: msg.id, ok: true, payload: { type: "hello-ok", protocol: 4 } })
        );
      }
      if (msg.method === "sessions.list") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            payload: {
              sessions: [
                {
                  key: "agent:main:telegram:topic:1",
                  label: "World Cup",
                  modelProvider: "spark",
                  hasActiveRun: false,
                },
              ],
            },
          })
        );
      }
      if (msg.method === "config.get") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            payload: {
              config: { models: { providers: { spark: { baseUrl: "http://127.0.0.1:4000/v1" } } } },
            },
          })
        );
      }
    });
  });
  try {
    const result = await defaultOpenClawGatewayRpc(`http://127.0.0.1:${port}`, "tok", {
      deviceIdentity: identity,
      timeoutMs: 2000,
    });
    assert.equal(result.sessions[0].label, "World Cup");
    assert.equal(result.providers.spark.baseUrl, "http://127.0.0.1:4000/v1");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
