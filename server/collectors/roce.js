/**
 * RoCE / RDMA monitoring for multi-Spark setups, from data every Spark already
 * has: the kernel's RDMA sysfs tree, ethtool and mlnx_qos. No switch integration
 * and no root: every read below works as a normal user on a DGX Spark.
 *
 * Two scripts run on the unit (locally in the host namespace, or over SSH):
 *  - FAST (every ~5 s): link state/rate, RDMA hw_counters, netdev byte/error counters.
 *  - SLOW (every ~30 s): ethtool -S (discards, CRC, pause), ethtool -a, mlnx_qos
 *    (trust mode, PFC, DSCP map). Its netdev names come from the FAST output.
 * Units without RDMA devices answer with nothing and are re-checked every 10 minutes.
 */

export const ROCE_FAST_SCRIPT = [
  'for d in /sys/class/infiniband/*; do',
  '  [ -d "$d" ] || continue',
  '  n=$(basename "$d"); p="$d/ports/1"',
  '  nd=$(ls "$d/device/net" 2>/dev/null | head -1)',
  '  echo "DEV|$n|$(cat $p/state 2>/dev/null)|$(cat $p/phys_state 2>/dev/null)|$(cat $p/rate 2>/dev/null)|$(cat $p/link_layer 2>/dev/null)|$nd"',
  // One grep for all counters ("path:value" lines), instead of a cat and a basename each.
  '  grep -H "" "$p"/hw_counters/* 2>/dev/null | sed "s#^.*/#CNT|$n|#; s#:#|#"',
  '  if [ -n "$nd" ]; then',
  '    s="/sys/class/net/$nd"',
  '    echo "NET|$nd|$(cat $s/operstate 2>/dev/null)|$(cat $s/mtu 2>/dev/null)|$(cat $s/speed 2>/dev/null)|$(cat $s/statistics/rx_bytes 2>/dev/null)|$(cat $s/statistics/tx_bytes 2>/dev/null)|$(cat $s/statistics/rx_errors 2>/dev/null)|$(cat $s/statistics/tx_errors 2>/dev/null)|$(cat $s/statistics/rx_dropped 2>/dev/null)|$(cat $s/statistics/tx_dropped 2>/dev/null)"',
  "  fi",
  "done",
].join("\n");

const NETDEV_RE = /^[A-Za-z0-9._-]{1,15}$/;

/** SLOW script for the given netdevs (names are validated: they end up in a shell command). */
export function roceSlowScript(netdevs) {
  const names = [...new Set(netdevs)].filter((n) => NETDEV_RE.test(n));
  if (names.length === 0) return null;
  return [
    `for n in ${names.join(" ")}; do`,
    '  echo "ETH|$n"',
    "  ethtool -S \"$n\" 2>/dev/null | grep -E '^ +(rx_discards_phy|tx_discards_phy|rx_crc_errors_phy|rx_symbol_err_phy|rx_pause_ctrl_phy|tx_pause_ctrl_phy|rx_prio[0-7]_pause|tx_prio[0-7]_pause|rx_prio[0-7]_discards|rx_out_of_buffer):'",
    '  echo "FC|$n|$(ethtool -a "$n" 2>/dev/null | tr \'\\n\' \' \')"',
    '  echo "QOS|$n"',
    '  mlnx_qos -i "$n" 2>/dev/null | head -80',
    '  echo "ENDQOS"',
    "done",
  ].join("\n");
}

/** RDMA counters whose rise means packets were lost or a transfer failed. */
export const LOSS_COUNTERS = [
  "out_of_buffer",
  "packet_seq_err",
  "local_ack_timeout_err",
  "rnr_nak_retry_err",
  "implied_nak_seq_err",
  "req_transport_retries_exceeded",
  "rx_icrc_encapsulated",
];
/** ethtool counters that count dropped or corrupted frames at the port. */
export const ETH_LOSS_COUNTERS = ["rx_discards_phy", "tx_discards_phy", "rx_crc_errors_phy", "rx_out_of_buffer"];

const toInt = (v) => {
  const n = Number.parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
};

/** "4: ACTIVE" -> "ACTIVE", "5: LinkUp" -> "LinkUp". */
const afterColon = (v) => String(v ?? "").replace(/^\s*\d+:\s*/, "").trim() || null;

/** "200 Gb/sec (2X NDR)" -> 200 */
function rateGbps(v) {
  const m = String(v ?? "").match(/([\d.]+)\s*Gb\/sec/i);
  return m ? Number(m[1]) : null;
}

/** @returns {{ devices: Array<object>, netdevs: Map<string, object> }} */
export function parseRoceFast(output) {
  const devices = new Map();
  const netdevs = new Map();
  for (const raw of String(output ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const p = line.split("|");
    if (p[0] === "DEV" && p.length >= 7) {
      devices.set(p[1], {
        name: p[1],
        state: afterColon(p[2]),
        physState: afterColon(p[3]),
        rateGbps: rateGbps(p[4]),
        linkLayer: p[5] || null,
        netdev: p[6] || null,
        counters: {},
      });
    } else if (p[0] === "CNT" && p.length >= 4) {
      const d = devices.get(p[1]);
      const v = toInt(p[3]);
      if (d && v != null) d.counters[p[2]] = v;
    } else if (p[0] === "NET" && p.length >= 11) {
      netdevs.set(p[1], {
        name: p[1],
        operstate: p[2] || null,
        mtu: toInt(p[3]),
        speedMbps: (() => {
          const s = toInt(p[4]);
          return s != null && s > 0 ? s : null;
        })(),
        rxBytes: toInt(p[5]),
        txBytes: toInt(p[6]),
        rxErrors: toInt(p[7]),
        txErrors: toInt(p[8]),
        rxDropped: toInt(p[9]),
        txDropped: toInt(p[10]),
      });
    }
  }
  return { devices: [...devices.values()], netdevs };
}

/** mlnx_qos -i output -> { trust, pfc: number[], cableLen, dscp } */
export function parseMlnxQos(text) {
  const out = { trust: null, pfcPriorities: null, cableLen: null, dscpMap: null };
  const lines = String(text ?? "").split(/\r?\n/);
  const dscp = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = line.match(/Priority trust state:\s*(\w+)/i);
    if (m) out.trust = m[1].toLowerCase();
    m = line.match(/Cable len:\s*(\d+)/i);
    if (m) out.cableLen = Number(m[1]);
    if (/^\s*PFC configuration:/i.test(line)) {
      // "priority 0 1 .. 7" then "enabled 0 0 1 ..."
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const e = lines[j].match(/^\s*enabled\s+((?:\d\s*)+)$/i);
        if (e) {
          out.pfcPriorities = e[1]
            .trim()
            .split(/\s+/)
            .map((v, idx) => (v === "1" ? idx : -1))
            .filter((idx) => idx >= 0);
          break;
        }
      }
    }
    // "prio:3 dscp:30,31,32,33,34,35,36,37," (DSCP trust mode)
    m = line.match(/prio:(\d+)\s+dscp:([\d,]+)/i);
    if (m) dscp[m[1]] = m[2].split(",").filter(Boolean).map(Number);
  }
  if (Object.keys(dscp).length > 0) out.dscpMap = dscp;
  return out;
}

/** @returns {Map<string, { eth: Record<string, number>, flowControl: {rx:boolean|null,tx:boolean|null}, qos: object }>} */
export function parseRoceSlow(output) {
  const result = new Map();
  let current = null;
  let qos = null;
  for (const raw of String(output ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    let m = line.match(/^ETH\|(.+)$/);
    if (m) {
      current = { eth: {}, flowControl: { rx: null, tx: null }, qos: parseMlnxQos("") };
      result.set(m[1].trim(), current);
      continue;
    }
    if (!current) continue;
    m = line.match(/^FC\|[^|]*\|(.*)$/);
    if (m) {
      const rx = m[1].match(/\bRX:\s*(on|off)\b/i);
      const tx = m[1].match(/\bTX:\s*(on|off)\b/i);
      current.flowControl = { rx: rx ? rx[1].toLowerCase() === "on" : null, tx: tx ? tx[1].toLowerCase() === "on" : null };
      continue;
    }
    if (/^QOS\|/.test(line)) {
      qos = [];
      continue;
    }
    if (/^ENDQOS/.test(line)) {
      if (qos) current.qos = parseMlnxQos(qos.join("\n"));
      qos = null;
      continue;
    }
    if (qos) {
      qos.push(line);
      continue;
    }
    m = line.match(/^\s+(\w+):\s+(\d+)\s*$/);
    if (m) current.eth[m[1]] = Number(m[2]);
  }
  return result;
}

export const FAST_INTERVAL_MS = 4_500;
export const SLOW_INTERVAL_MS = 30_000;
export const NO_RDMA_RECHECK_MS = 10 * 60_000;
/** Samples in a row with rising RDMA loss counters before a finding is raised. */
export const LOSS_STREAK_FOR_FINDING = 3;
/** Slow (30 s) samples in a row with rising port discards / CRC errors before a finding. */
export const ETH_LOSS_STREAK_FOR_FINDING = 2;
/** Failed or empty reads in a row before the last good sample is dropped. */
export const STALE_AFTER_FAILURES = 4;
/** After a failed read, wait this long before running the script again. */
export const RETRY_AFTER_FAILURE_MS = 15_000;

/**
 * Keeps the baselines between samples (rates, counter deltas, "was this port ever up").
 * `run(script)` executes a shell script on the unit and resolves with its stdout.
 */
export class RoceSampler {
  constructor({ run, now = Date.now } = {}) {
    this._run = run;
    this._now = now;
    this._last = null; // last result returned
    this._lastAt = 0;
    this._noRdmaUntil = 0;
    this._prev = new Map(); // rdma device -> { at, rx, tx, counters, eth }
    this._everActive = new Set();
    this._lossStreak = new Map();
    this._slow = { at: 0, byNetdev: new Map(), prevEth: new Map(), ethStreak: new Map() };
    this._everSawDevices = false;
    this._failures = 0;
    this._retryAt = 0;
    this._pending = null;
  }

  /**
   * @returns {Promise<null | { available: true, sampledAt: number, devices: object[] }>}
   * Never runs two reads at once: a call while one is in flight shares it. Throws only
   * after STALE_AFTER_FAILURES failed reads in a row (until then the last good sample stands).
   */
  sample() {
    if (this._pending) return this._pending;
    this._pending = this._sample().finally(() => {
      this._pending = null;
    });
    return this._pending;
  }

  async _sample() {
    const now = this._now();
    if (now < this._noRdmaUntil) return null;
    if (this._last && now - this._lastAt < FAST_INTERVAL_MS) return this._last;
    if (now < this._retryAt) return this._failures >= STALE_AFTER_FAILURES ? null : this._last;

    let fast;
    try {
      fast = parseRoceFast(await this._run(ROCE_FAST_SCRIPT));
    } catch (error) {
      return this._noteFailure(now, error);
    }
    if (fast.devices.length === 0) {
      if (this._everSawDevices) {
        // The devices vanished (driver reload, transient empty output): keep the last good
        // sample for a few reads instead of flapping, and keep asking at the normal pace.
        return this._noteFailure(now, null);
      }
      this._noRdmaUntil = now + NO_RDMA_RECHECK_MS;
      this._last = null;
      return null;
    }
    this._everSawDevices = true;
    this._failures = 0;

    if (now - this._slow.at >= SLOW_INTERVAL_MS) {
      await this._refreshSlow(fast, now);
    }

    const devices = fast.devices
      .map((d) => this._device(d, fast.netdevs.get(d.netdev ?? ""), now))
      .sort((a, b) => (a.netdev ?? a.name).localeCompare(b.netdev ?? b.name));
    this._last = { available: true, sampledAt: now, devices };
    this._lastAt = now;
    return this._last;
  }

  _noteFailure(now, error) {
    this._failures += 1;
    this._retryAt = now + RETRY_AFTER_FAILURE_MS;
    if (this._failures >= STALE_AFTER_FAILURES) {
      this._last = null;
      if (error) throw error;
      return null;
    }
    return this._last;
  }

  async _refreshSlow(fast, now) {
    const script = roceSlowScript(fast.devices.map((d) => d.netdev).filter(Boolean));
    if (!script) return;
    try {
      const parsed = parseRoceSlow(await this._run(script));
      for (const [name, info] of parsed) {
        const before = this._slow.prevEth.get(name);
        if (before) {
          const rose = ETH_LOSS_COUNTERS.some((key) => (info.eth[key] ?? 0) > (before[key] ?? 0));
          // One entry per slow sample: consecutive samples with a rise build the streak.
          this._slow.ethStreak.set(name, rose ? (this._slow.ethStreak.get(name) ?? 0) + 1 : 0);
        }
        this._slow.prevEth.set(name, { ...info.eth });
      }
      this._slow.byNetdev = parsed;
      this._slow.at = now;
    } catch {
      /* the slow facts are optional; keep the previous ones */
      this._slow.at = now;
    }
  }

  _device(d, net, now) {
    const active = d.state === "ACTIVE";
    if (active) this._everActive.add(d.name);

    const prev = this._prev.get(d.name);
    const dt = prev ? (now - prev.at) / 1000 : 0;
    const rate = (cur, before) => (prev && dt > 0 && cur != null && before != null ? Math.max(0, (cur - before) / dt) : null);

    const deltas = {};
    const rising = [];
    if (prev) {
      for (const [k, v] of Object.entries(d.counters)) {
        const delta = Math.max(0, v - (prev.counters[k] ?? v));
        deltas[k] = delta;
        if (delta > 0 && LOSS_COUNTERS.includes(k)) rising.push(k);
      }
    }
    const slow = net ? this._slow.byNetdev.get(net.name) : null;
    const ethStreak = net ? (this._slow.ethStreak.get(net.name) ?? 0) : 0;
    const streak = rising.length > 0 ? (this._lossStreak.get(d.name) ?? 0) + 1 : 0;
    this._lossStreak.set(d.name, streak);

    this._prev.set(d.name, { at: now, counters: { ...d.counters }, rx: net?.rxBytes ?? null, tx: net?.txBytes ?? null });

    return {
      name: d.name,
      netdev: d.netdev,
      state: d.state,
      physState: d.physState,
      active,
      everActive: this._everActive.has(d.name),
      rateGbps: d.rateGbps,
      linkLayer: d.linkLayer,
      operstate: net?.operstate ?? null,
      mtu: net?.mtu ?? null,
      speedMbps: net?.speedMbps ?? null,
      rxBps: prev ? rate(net?.rxBytes ?? null, prev.rx) : null,
      txBps: prev ? rate(net?.txBytes ?? null, prev.tx) : null,
      rxErrors: net?.rxErrors ?? null,
      txErrors: net?.txErrors ?? null,
      rxDropped: net?.rxDropped ?? null,
      txDropped: net?.txDropped ?? null,
      counters: d.counters,
      deltas,
      loss: { rising: ethStreak > 0 ? [...rising, "port discards"] : rising, streak, ethStreak },
      eth: slow?.eth ?? null,
      flowControl: slow?.flowControl ?? null,
      qos: slow?.qos ?? null,
    };
  }
}
