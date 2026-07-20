import test from "node:test";
import assert from "node:assert/strict";
import {
  broadcastForLanIp,
  buildMagicPacket,
  normalizeMac,
} from "../server/wol.js";

test("normalizeMac accepts colon and hyphen forms", () => {
  assert.equal(normalizeMac("AA:BB:CC:DD:EE:FF"), "aa:bb:cc:dd:ee:ff");
  assert.equal(normalizeMac("aa-bb-cc-dd-ee-ff"), "aa-bb-cc-dd-ee-ff");
  assert.equal(normalizeMac("  aa:bb:cc:dd:ee:ff  "), "aa:bb:cc:dd:ee:ff");
});

test("normalizeMac rejects garbage", () => {
  assert.equal(normalizeMac(null), null);
  assert.equal(normalizeMac(""), null);
  assert.equal(normalizeMac("not-a-mac"), null);
  assert.equal(normalizeMac("aa:bb:cc:dd:ee"), null);
});

test("broadcastForLanIp derives /24 or falls back to limited broadcast", () => {
  assert.equal(broadcastForLanIp("192.168.1.42"), "192.168.1.255");
  assert.equal(broadcastForLanIp(""), "255.255.255.255");
  assert.equal(broadcastForLanIp(null), "255.255.255.255");
  assert.equal(broadcastForLanIp("not-an-ip"), "255.255.255.255");
});

test("buildMagicPacket is 6xFF followed by 16x MAC", () => {
  const pkt = buildMagicPacket("01:23:45:67:89:ab");
  assert.equal(pkt.length, 102);
  assert.ok(pkt.subarray(0, 6).every((b) => b === 0xff));
  for (let i = 0; i < 16; i++) {
    assert.deepEqual(
      [...pkt.subarray(6 + i * 6, 12 + i * 6)],
      [0x01, 0x23, 0x45, 0x67, 0x89, 0xab]
    );
  }
});
