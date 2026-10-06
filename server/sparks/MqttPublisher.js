import mqtt from "mqtt";

const RATE_LIMIT_MS = 2000;
const LOG_THROTTLE_MS = 60_000;

/**
 * Publishes per-Spark temperatures to MQTT for the sparkfan ESP32 controller.
 * Topics: `<base>/temps/<sparkId>` retained, payload {"cpu_c":n,"gpu_c":n}
 * (field omitted when null). Never throws into the broadcast path; reconnects
 * are handled internally by mqtt.js.
 */
export class MqttPublisher {
  constructor({ url, username, password, base = "sparkfan" }) {
    this.base = base || "sparkfan";
    this.lastSent = new Map(); // sparkId -> Date.now() of last publish
    this.lastLog = 0;
    this.client = mqtt.connect(url, {
      username: username || undefined,
      password: password || undefined,
      reconnectPeriod: 5000,
    });
    this.client.on("error", (err) => this._log(`mqtt error: ${err.message}`));
  }

  /**
   * Accepts the JSON string returned by buildSnapshotPayload() (or an array of
   * snapshot objects). Rate-limits to one publish per spark per 2 s.
   */
  publishSnapshots(payload) {
    try {
      let snapshots = payload;
      if (typeof payload === "string") snapshots = JSON.parse(payload).sparks ?? [];
      if (!Array.isArray(snapshots)) return;
      const now = Date.now();
      for (const s of snapshots) {
        const id = s?.id ?? s?.sparkId ?? s?.name;
        if (id == null) continue;
        const m = s?.metrics;
        const cpuC = numOrNull(m?.cpu?.temperature);
        const gpuC = maxNum([
          m?.gpu?.temperature,
          ...(Array.isArray(m?.gpu?.gpus) ? m.gpu.gpus.map((g) => g?.temperature) : []),
        ]);
        if (cpuC === null && gpuC === null) continue;
        const last = this.lastSent.get(id) ?? 0;
        if (now - last < RATE_LIMIT_MS) continue;
        this.lastSent.set(id, now);
        const body = {};
        if (cpuC !== null) body.cpu_c = cpuC;
        if (gpuC !== null) body.gpu_c = gpuC;
        this.client.publish(`${this.base}/temps/${id}`, JSON.stringify(body), {
          retain: true,
          qos: 0,
        });
      }
    } catch (err) {
      this._log(`publishSnapshots failed: ${err?.message ?? err}`);
    }
  }

  _log(msg) {
    const now = Date.now();
    if (now - this.lastLog < LOG_THROTTLE_MS) return;
    this.lastLog = now;
    console.log(`[MqttPublisher] ${msg}`);
  }
}

function numOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

function maxNum(values) {
  let best = null;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}
