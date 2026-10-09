/**
 * Intel Arc / Xe-driver discrete GPUs, read from sysfs + hwmon only (no vendor
 * tools). One probe script runs locally (in the host mount namespace) or in the
 * node's single SSH round trip; the parsers below are pure so they can be
 * unit-tested with fixtures.
 *
 * Only the `xe` driver is handled. Cards on PCI bus 00 are integrated and are
 * skipped; `i915` is not read (it exposes no comparable counters).
 */

/** PCI device id -> marketing name. Unknown ids fall back to a generic label. */
const INTEL_DEVICE_NAMES = {
  "0xe223": "Intel Arc Pro B70",
};

/** Baselines older than this are dropped (node unreachable, process paused). */
const MAX_SAMPLE_GAP_SEC = 600;
/** Two polls closer than this give a noisy delta; keep the previous reading. */
const MIN_SAMPLE_GAP_SEC = 0.5;

/**
 * POSIX sh. Prints "key value" lines, one block per card, headed by "@xe <pci>".
 * Every read tolerates a missing file, and the script ends with `true` so a
 * missing card or a denied sudo never fails the surrounding SSH command.
 * VRAM size/usage come from root-only debugfs: plain read, then `sudo -n`
 * unless INTEL_SUDO=0. The file is expected at `dri/<pci>/tile0/vram_mm`, but
 * that path is not confirmed on hardware, so every tile directory is tried
 * (the first size/usage pair wins) and a missing or differently shaped file
 * just leaves the card on its PCI BAR size. INTEL_VRAM=0 skips the debugfs
 * read altogether; the collector then reuses its cached reading (see
 * IntelVramCache). A sudo read that yields nothing prints "sudofail 1" so the
 * collector can stop retrying (see IntelSudoGate).
 * INTEL_PROBE_ROOT prefixes every path (tests point it at a fixture tree).
 */
export const INTEL_PROBE_SCRIPT = [
  'R="${INTEL_PROBE_ROOT:-}"',
  'for c in "$R"/sys/class/drm/card[0-9]*; do',
  '  case "${c##*/}" in *-*) continue;; esac',
  '  d="$c/device"; [ -e "$d/driver" ] || continue',
  '  [ "$(basename "$(readlink -f "$d/driver")")" = xe ] || continue',
  '  pci=$(basename "$(readlink -f "$d")")',
  '  case "$pci" in ????:00:*) continue;; esac',
  '  echo "@xe $pci"',
  '  echo "id $(cat "$d/device" 2>/dev/null)"',
  '  echo "up $(cut -d" " -f1 "$R/proc/uptime" 2>/dev/null)"',
  '  for h in "$d"/hwmon/hwmon*; do',
  '    [ "$(cat "$h/name" 2>/dev/null)" = xe ] || continue',
  '    echo "cap $(cat "$h/power1_cap" 2>/dev/null)"',
  '    echo "crit $(cat "$h/power1_crit" 2>/dev/null)"',
  '    echo "fan $(cat "$h/fan1_input" 2>/dev/null)"',
  '    for e in "$h"/energy*_input; do [ -e "$e" ] || continue; l=$(cat "${e%_input}_label" 2>/dev/null); echo "energy ${l:-$(basename "$e")} $(cat "$e" 2>/dev/null)"; done',
  '    for t in "$h"/temp*_input; do [ -e "$t" ] || continue; l=$(cat "${t%_input}_label" 2>/dev/null); case "$l" in vram_ch*) continue;; esac; echo "temp ${l:-$(basename "$t")} $(cat "$t" 2>/dev/null)"; done',
  "    break",
  "  done",
  '  echo "cur $(cat "$d/tile0/gt0/freq0/cur_freq" 2>/dev/null)"',
  '  echo "max $(cat "$d/tile0/gt0/freq0/max_freq" 2>/dev/null)"',
  '  echo "idle $(cat "$d/tile0/gt0/gtidle/idle_residency_ms" 2>/dev/null)"',
  '  head -6 "$d/resource" 2>/dev/null | sed "s/^/res /"',
  '  v="$R/sys/kernel/debug/dri/$pci"',
  '  o=""',
  '  if [ "${INTEL_VRAM:-1}" = 1 ]; then',
  '    o=$(cat "$v"/tile*/vram_mm 2>/dev/null)',
  '    if [ -z "$o" ] && [ "${INTEL_SUDO:-1}" = 1 ]; then o=$(sudo -n cat "$v/tile0/vram_mm" "$v/tile1/vram_mm" "$v/tile2/vram_mm" "$v/tile3/vram_mm" 2>/dev/null); [ -n "$o" ] || echo "sudofail 1"; fi',
  "  fi",
  '  [ -z "$o" ] || printf "%s\\n" "$o" | grep -E "^ *(size|usage):" | head -2 | sed "s/^ */vram /"',
  "done; true",
].join("\n");

/** Probe script with the sudo fallback and the debugfs VRAM read switched on or off. */
export function buildIntelProbeScript({ sudo = true, vram = true } = {}) {
  return (vram ? "" : "INTEL_VRAM=0\n") + (sudo ? "" : "INTEL_SUDO=0\n") + INTEL_PROBE_SCRIPT;
}

/**
 * Remembers, per host, that `sudo -n` could not read the debugfs VRAM file, so
 * a node without passwordless sudo is not retried on every poll (each failed
 * attempt writes a line to the host's auth log). Retries after `ttlMs`.
 */
export class IntelSudoGate {
  constructor({ now = Date.now, ttlMs = 10 * 60 * 1000 } = {}) {
    this._now = now;
    this._ttlMs = ttlMs;
    this._failedAt = null;
  }

  /** True when the next probe may use sudo. */
  get allowed() {
    if (this._failedAt == null) return true;
    if (this._now() - this._failedAt >= this._ttlMs) {
      this._failedAt = null;
      return true;
    }
    return false;
  }

  /** Feed parsed probe cards; a card that reported a sudo failure closes the gate. */
  observe(cards) {
    if (cards.some((c) => c.sudoFailed)) this._failedAt = this._now();
  }
}

/**
 * Keeps the last good debugfs VRAM reading per card for `ttlMs`, so even with
 * working passwordless sudo a host sees one `sudo -n` per window instead of
 * one per poll (each call writes sudo/PAM lines to its auth log). Only the
 * VRAM read is skipped; temperature, power and clocks come from the probe on
 * every poll. A card that appears without a cached reading expires the cache
 * so it is read on the next poll.
 */
export class IntelVramCache {
  constructor({ now = Date.now, ttlMs = 45 * 1000 } = {}) {
    this._now = now;
    this._ttlMs = ttlMs;
    this._at = null;
    this._byPci = new Map();
  }

  /** True when the next probe should read debugfs (cache empty or expired). */
  get stale() {
    return this._at == null || this._now() - this._at >= this._ttlMs;
  }

  /**
   * Feed the parsed cards of a probe; `read` says whether that probe read
   * debugfs. A read refreshes the cache from the cards that returned size and
   * usage; a skipped read fills the cards from the cache instead.
   */
  apply(cards, read) {
    if (read) {
      const fresh = new Map();
      for (const c of cards) {
        if (c.vramSizeBytes != null && c.vramUsageBytes != null) {
          fresh.set(c.pci, { size: c.vramSizeBytes, usage: c.vramUsageBytes });
        }
      }
      this._byPci = fresh;
      this._at = fresh.size ? this._now() : null;
      return;
    }
    let missing = false;
    for (const c of cards) {
      const hit = this._byPci.get(c.pci);
      if (hit) {
        c.vramSizeBytes = hit.size;
        c.vramUsageBytes = hit.usage;
      } else {
        missing = true;
      }
    }
    if (missing) this._at = null;
  }
}

const num = (s) => {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

/** Size in bytes of the largest PCI BAR, from "<start> <end> <flags>" rows. */
function largestBarBytes(rows) {
  let best = 0;
  for (const r of rows) {
    const [start, end] = r.trim().split(/\s+/);
    if (!/^0x[0-9a-f]+$/i.test(start ?? "") || !/^0x[0-9a-f]+$/i.test(end ?? "")) continue;
    const size = Number(BigInt(end) - BigInt(start) + 1n);
    if (size > best) best = size;
  }
  return best || null;
}

/** Parse the probe output into raw per-card readings (sysfs units). */
export function parseIntelProbe(output) {
  const cards = [];
  let cur = null;
  for (const line of String(output ?? "").split("\n")) {
    const m = line.trim().match(/^(\S+)\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    if (key === "@xe") {
      cur = {
        pci: rest.trim(), deviceId: null, uptimeSec: null, capUw: null, critUw: null, fanRpm: null,
        energyUj: {}, temps: {}, freqMHz: null, freqMaxMHz: null, idleMs: null,
        res: [], vramSizeBytes: null, vramUsageBytes: null, sudoFailed: false,
      };
      cards.push(cur);
      continue;
    }
    if (!cur) continue;
    if (key === "id") cur.deviceId = /^0x[0-9a-f]+$/i.test(rest.trim()) ? rest.trim().toLowerCase() : null;
    else if (key === "up") cur.uptimeSec = num(rest);
    else if (key === "cap") cur.capUw = num(rest);
    else if (key === "crit") cur.critUw = num(rest);
    else if (key === "fan") cur.fanRpm = num(rest);
    else if (key === "cur") cur.freqMHz = num(rest);
    else if (key === "max") cur.freqMaxMHz = num(rest);
    else if (key === "idle") cur.idleMs = num(rest);
    else if (key === "res") cur.res.push(rest);
    else if (key === "sudofail") cur.sudoFailed = true;
    else if (key === "energy" || key === "temp") {
      const [label, value] = rest.split(/\s+/);
      const v = num(value);
      if (label && v != null) (key === "energy" ? cur.energyUj : cur.temps)[label] = v;
    } else if (key === "vram") {
      const v = rest.match(/^(size|usage):\s*(\d+)/);
      if (v) cur[v[1] === "size" ? "vramSizeBytes" : "vramUsageBytes"] = Number(v[2]);
    }
  }
  return cards;
}

/**
 * Turn raw readings into device entries. `prev` maps PCI address -> last
 * sample. Power comes from the card energy-counter delta, usage from the GT
 * idle-residency delta. The first sample reads 0; a counter that went
 * backwards keeps the last good value; a reboot or stale baseline re-baselines.
 * Returns `{ devices, next }` (`next` is the state for the following call).
 */
export function sampleIntelCards(cards, prev = new Map(), fallbackNowSec = Date.now() / 1000) {
  const next = new Map();
  const devices = cards.map((c) => {
    const t = c.uptimeSec ?? fallbackNowSec;
    const energy = c.energyUj.card ?? Object.values(c.energyUj)[0] ?? null;
    const p = prev.get(c.pci);
    let power = p?.power ?? 0;
    let usage = p?.usage ?? 0;
    let base = { t, energy, idle: c.idleMs };
    if (p) {
      const dt = t - p.t;
      if (dt >= 0 && dt < MIN_SAMPLE_GAP_SEC) {
        base = p;
      } else if (dt < 0 || dt > MAX_SAMPLE_GAP_SEC) {
        power = 0;
        usage = 0;
      } else {
        if (energy != null && p.energy != null && energy >= p.energy) {
          power = (energy - p.energy) / 1e6 / dt;
        }
        if (c.idleMs != null && p.idle != null && c.idleMs >= p.idle) {
          usage = Math.min(100, Math.max(0, (1 - (c.idleMs - p.idle) / 1000 / dt) * 100));
        }
      }
    }
    next.set(c.pci, { t: base.t, energy: base.energy, idle: base.idle, power, usage });

    const temps = Object.values(c.temps);
    const tempMilli = c.temps.pkg ?? (temps.length ? Math.max(...temps) : 0);
    const limitUw = c.capUw > 0 ? c.capUw : c.critUw > 0 ? c.critUw : 0;
    const totalBytes = c.vramSizeBytes ?? largestBarBytes(c.res);
    const measured = c.vramSizeBytes != null && c.vramUsageBytes != null;
    return {
      vendor: "intel",
      pci: c.pci,
      name: INTEL_DEVICE_NAMES[c.deviceId] ?? (c.deviceId ? `Intel GPU [${c.deviceId.slice(2)}]` : "Intel GPU"),
      temperature: Math.round(tempMilli / 100) / 10,
      usage: Math.round(usage),
      powerDraw: Math.round(power * 100) / 100,
      powerLimit: Math.round(limitUw / 1e4) / 100,
      fanRpm: c.fanRpm,
      smClockMHz: c.freqMHz,
      smClockMaxMHz: c.freqMaxMHz,
      vramUsedMB: measured ? Math.round(c.vramUsageBytes / 1048576) : 0,
      vramTotalMB: totalBytes ? Math.round(totalBytes / 1048576) : 0,
      vramSource: measured ? "debugfs" : "pci-bar",
    };
  });
  return { devices, next };
}
