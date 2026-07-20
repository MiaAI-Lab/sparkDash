/**
 * Wake-on-LAN helpers: MAC validation, /24 broadcast derivation, magic packet send.
 */
import dgram from "node:dgram";

const MAC_RE = /^([0-9a-f]{2}[:\-]){5}[0-9a-f]{2}$/;

/** @param {unknown} mac */
export function normalizeMac(mac) {
  if (mac == null) return null;
  const clean = String(mac).trim().toLowerCase();
  if (!MAC_RE.test(clean)) return null;
  return clean;
}

/**
 * Derive a /24 directed broadcast from an IPv4 address, else global broadcast.
 * @param {unknown} lanIp
 */
export function broadcastForLanIp(lanIp) {
  if (typeof lanIp === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lanIp.trim())) {
    const parts = lanIp.trim().split(".");
    const nums = parts.map((p) => Number(p));
    if (nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      return `${nums[0]}.${nums[1]}.${nums[2]}.255`;
    }
  }
  return "255.255.255.255";
}

/**
 * Build a WoL magic packet for a normalized MAC (aa:bb:… or aa-bb-…).
 * @param {string} cleanMac
 */
export function buildMagicPacket(cleanMac) {
  const macBytes = cleanMac.split(/[:\-]/).map((b) => parseInt(b, 16));
  const magic = Buffer.alloc(6 + 16 * 6);
  magic.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) {
      magic[6 + i * 6 + j] = macBytes[j];
    }
  }
  return magic;
}

/**
 * Send one WoL magic packet. Settles exactly once (no hanging bind, no double settle).
 * @param {string} cleanMac normalized MAC
 * @param {string} [broadcastAddr]
 * @param {number} [port=9]
 * @returns {Promise<{ mac: string, broadcast: string }>}
 */
export function sendWol(cleanMac, broadcastAddr = "255.255.255.255", port = 9) {
  const magic = buildMagicPacket(cleanMac);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(result);
    };

    const sock = dgram.createSocket("udp4");
    sock.on("error", (err) => {
      finish(err);
    });

    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        sock.send(magic, 0, magic.length, port, broadcastAddr, (err) => {
          if (err) finish(err);
          else finish(null, { mac: cleanMac, broadcast: broadcastAddr });
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
