import test from "node:test";
import assert from "node:assert/strict";
import { TailscaleProbe, parseTailscaleStatus } from "../TailscaleProbe.js";

/** Shape of a healthy `tailscale status --json`, trimmed to the fields we read. */
const HEALTHY = {
  BackendState: "Running",
  Version: "1.102.2-t6cac91817",
  Self: {
    HostName: "spark-1",
    DNSName: "spark-1.example.ts.net.",
    Online: true,
    TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
    Relay: "nyc",
    KeyExpiry: "2026-09-06T20:02:31Z",
    Expired: false,
  },
  Health: [],
};

test("parseTailscaleStatus reads a healthy node", () => {
  const p = parseTailscaleStatus(HEALTHY);
  assert.equal(p.available, true);
  assert.equal(p.online, true);
  assert.equal(p.backendState, "Running");
  assert.equal(p.hostName, "spark-1");
  // First IP only — the v4 address is what operators recognize.
  assert.equal(p.tailscaleIp, "100.64.0.1");
  assert.equal(p.relay, "nyc");
  assert.equal(p.keyExpired, false);
  assert.deepEqual(p.health, []);
});

test("parseTailscaleStatus surfaces the wedged-netmap case (healthy box, off tailnet)", () => {
  // The failure this probe exists for: tailscaled running, SSH fine, but no
  // session with the coordination server — invisible from off-LAN.
  const p = parseTailscaleStatus({
    ...HEALTHY,
    Self: { ...HEALTHY.Self, Online: false },
    Health: ["Tailscale hasn't received a network map from the coordination server in 2m7s."],
  });
  assert.equal(p.available, true);
  assert.equal(p.online, false);
  assert.equal(p.backendState, "Running");
  assert.equal(p.health.length, 1);
  assert.match(p.health[0], /coordination server/);
});

test("parseTailscaleStatus flags an expired key", () => {
  const p = parseTailscaleStatus({
    ...HEALTHY,
    Self: { ...HEALTHY.Self, Online: false, Expired: true },
  });
  assert.equal(p.keyExpired, true);
  assert.equal(p.online, false);
});

test("parseTailscaleStatus tolerates missing and malformed fields", () => {
  const p = parseTailscaleStatus({ Self: {} });
  assert.equal(p.available, true); // Self exists, just empty
  assert.equal(p.online, null); // absent boolean stays unknown, not false
  assert.equal(p.tailscaleIp, null);
  assert.equal(p.relay, null);
  assert.equal(p.keyExpiry, null);
  assert.equal(p.keyExpired, false);
  assert.deepEqual(p.health, []);

  const empty = parseTailscaleStatus({});
  assert.equal(empty.available, false);
  assert.equal(empty.online, null);

  // Non-string junk in Health must not reach the UI.
  const junk = parseTailscaleStatus({ Self: {}, Health: ["ok", "", 42, null] });
  assert.deepEqual(junk.health, ["ok"]);
});

test("parseTailscaleStatus blanks whitespace-only strings", () => {
  const p = parseTailscaleStatus({
    BackendState: "   ",
    Self: { HostName: "", Relay: "  ", Online: true },
  });
  assert.equal(p.backendState, null);
  assert.equal(p.hostName, null);
  assert.equal(p.relay, null);
});

test("TailscaleProbe returns default shape with error when the command fails", async () => {
  // isLocal avoids SSH; `false` exits non-zero, standing in for a missing
  // tailscale binary or a stopped tailscaled.
  const probe = new TailscaleProbe({ isLocal: true });
  probe._execLocal = async () => {
    throw new Error("tailscale: command not found");
  };
  const snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.equal(snap.online, null);
  assert.equal(snap.keyExpired, false);
  assert.deepEqual(snap.health, []);
  assert.match(snap.error, /command not found/);
  probe.dispose();
});

test("TailscaleProbe reports an error on unparseable output rather than throwing", async () => {
  const probe = new TailscaleProbe({ isLocal: true });
  probe._execLocal = async () => "not json at all";
  const snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.match(snap.error, /Unparseable/);
});

test("TailscaleProbe clears a stale error after recovery", async () => {
  const probe = new TailscaleProbe({ isLocal: true });
  probe._execLocal = async () => {
    throw new Error("boom");
  };
  assert.ok((await probe.probe()).error);

  probe._execLocal = async () => JSON.stringify(HEALTHY);
  const ok = await probe.probe();
  assert.equal(ok.error, null);
  assert.equal(ok.online, true);
});
