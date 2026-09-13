/**
 * Pure clock-cap control logic — no I/O. Everything the apply paths and the
 * tests need: the domain enum, bounds parsing from measured hardware output,
 * request clamping/validation, argv building for the privileged helper, and
 * exit-code interpretation. Exported for tests.
 */

/** The privileged host helper (installed by scripts/install-clock-helper.sh). */
export const CLOCK_HELPER_BIN = "/usr/local/bin/sparkdash-set-clock";

/**
 * Last-resort GPU graphics ceiling when `nvidia-smi -q -d CLOCK` is
 * unparseable. Documented constant (see config.js GPU_CLOCK_MAX_MHZ).
 */
export const CLOCK_DOMAIN_IDS = ["cpu-big", "cpu-little", "gpu"];

/** Human labels per domain id. */
export const CLOCK_DOMAIN_LABELS = {
  "cpu-big": "CPU X925",
  "cpu-little": "CPU A725",
  gpu: "GPU",
};

/**
 * Extract `cpuinfo_min_freq` / `cpuinfo_max_freq` values from a sysfs dump.
 * Input is the remote/local dump shape `cpuN:min_freq:max_freq` (one line per
 * core) — the same shape the clock-caps reader produces. A domain is a group
 * of cores sharing one `cpuinfo_max_freq`; the domain's hard bounds are that
 * max freq and the strictest (largest) min freq seen across its cores. Never
 * depend on `scaling_available_frequencies` — it does not exist on cppc_cpufreq.
 * @param {string} raw
 * @returns {Array<{minKhz: number, maxKhz: number}>} one per domain, sorted max desc
 */
export function parseCpuClockBounds(raw) {
  const domains = new Map();
  for (const line of String(raw ?? "").split("\n")) {
    const m = line.trim().match(/^cpu(\d+):(\d+):(\d+)$/);
    if (!m) continue;
    const minKhz = Number(m[2]);
    const maxKhz = Number(m[3]);
    if (!Number.isFinite(minKhz) || !Number.isFinite(maxKhz) || maxKhz <= 0) continue;
    if (!domains.has(maxKhz)) {
      domains.set(maxKhz, { minKhz, maxKhz });
    } else {
      // Keep the strictest floor across the domain's cores.
      const d = domains.get(maxKhz);
      if (minKhz > d.minKhz) d.minKhz = minKhz;
    }
  }
  return [...domains.values()].sort((a, b) => b.maxKhz - a.maxKhz);
}

/**
 * Parse the GPU graphics ceiling out of `nvidia-smi -q -d CLOCK`: the
 * "Default Applications Clock" section's "Graphics" value in MHz. Measured
 * GB10 output is `Default Applications Clock : Graphics : 3003 MHz`. Falls
 * back to null when the transcript does not contain a parseable value — the
 * caller then applies the documented GPU_CLOCK_MAX_MHZ fallback.
 * @param {string} raw
 * @returns {number | null} MHz
 */
export function parseDefaultApplicationsGraphicsClock(raw) {
  const text = String(raw ?? "");
  // Anchor to the Default Applications Clock block so "Max Clock" / "SM App"
  // Graphics values elsewhere in the transcript cannot win.
  const block = text.match(/Default\s+Applications\s+Clock([\s\S]*?)(?:\n\s*\n|$)/i);
  const scope = block ? block[1] : "";
  const m = scope.match(/Graphics\s*:\s*(\d+)\s*MHz/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Clamp a requested MHz value into the domain's live hardware bounds.
 * Used on the values the UI slider already clamps (defense in depth) and on
 * the preset/boot-unit values a unit may carry. Non-finite input passes
 * through (validation rejects it; clamping is not normalization).
 * @param {number | null} value
 * @param {number} hardMinMHz
 * @param {number} hardMaxMHz
 * @param {{ warnings?: string[] }} [out] receives a warning when clamped
 * @returns {number | null}
 */
export function clampClockCap(value, hardMinMHz, hardMaxMHz, out = {}) {
  if (value == null) return null;
  if (!Number.isFinite(value)) return value;
  const warnings = out.warnings;
  let v = value;
  if (hardMaxMHz != null && v > hardMaxMHz) {
    v = hardMaxMHz;
    if (warnings) {
      warnings.push(`Requested ${value} MHz is above the hardware maximum ${hardMaxMHz} MHz; clamped to ${hardMaxMHz} MHz`);
    }
  }
  if (hardMinMHz != null && v < hardMinMHz) {
    v = hardMinMHz;
    if (warnings) {
      warnings.push(`Requested ${value} MHz is below the hardware minimum ${hardMinMHz} MHz; clamped to ${hardMinMHz} MHz`);
    }
  }
  return v;
}

/**
 * Validate a POST /api/sparks/:id/clocks body against live domain bounds.
 * Rules (D1/D2): domain must be in the enum; maxMHz must be null (remove the
 * cap) or an integer within [hardMinMHz, hardMaxMHz]; persist must be boolean
 * (defaults false). Returns { ok, value, error }.
 * @param {unknown} body
 * @param {Array<{id: string, hardMinMHz: number, hardMaxMHz: number}>} domains
 */
export function validateClockCapRequest(body, domains) {
  const b = body && typeof body === "object" ? body : {};
  const domain = b.domain;
  if (typeof domain !== "string" || !CLOCK_DOMAIN_IDS.includes(domain)) {
    return { ok: false, error: `domain must be one of: ${CLOCK_DOMAIN_IDS.join(", ")}` };
  }
  const d = domains.find((x) => x.id === domain);
  if (!d) {
    return { ok: false, error: `domain ${domain} is not available on this Spark` };
  }
  const persist = b.persist;
  if (persist !== undefined && typeof persist !== "boolean") {
    return { ok: false, error: "persist must be a boolean" };
  }
  const maxMHz = b.maxMHz;
  if (maxMHz == null) {
    return { ok: true, value: { domain, maxMHz: null, persist: Boolean(persist) } };
  }
  if (typeof maxMHz === "string" || !Number.isInteger(maxMHz)) {
    return { ok: false, error: "maxMHz must be an integer or null" };
  }
  if (maxMHz < d.hardMinMHz || maxMHz > d.hardMaxMHz) {
    return {
      ok: false,
      error: `maxMHz ${maxMHz} is outside the ${domain} hardware range ${d.hardMinMHz}–${d.hardMaxMHz} MHz`,
    };
  }
  return { ok: true, value: { domain, maxMHz, persist: Boolean(persist) } };
}

/**
 * Build the SSH command that runs the privileged clock helper (D4). Mirrors
 * SHUTDOWN_REMOTE_CMD in server/index.js: verify the helper exists (exit 127),
 * verify passwordless sudo (exit 126), then invoke it. Distinct exit codes let
 * the UI name the real cause instead of a generic failure.
 * @param {{ domain: string, maxMHz: number | null, persist: boolean }} req
 * @param {{ helperBin?: string }} [opts]
 */
export function buildClockHelperArgv(req, opts = {}) {
  const helperBin = opts.helperBin || CLOCK_HELPER_BIN;
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const args = [
    `test -x ${helperBin} || { echo "missing ${helperBin}" >&2; exit 127; }`,
    `sudo -n true || { echo "sudo -n required for ${helperBin}" >&2; exit 126; }`,
  ];
  const parts = [`sudo -n ${helperBin}`, `--domain ${q(req.domain)}`];
  if (req.maxMHz == null) {
    parts.push("--unlock");
  } else {
    parts.push(`--max-mhz ${Number(req.maxMHz)}`);
  }
  parts.push(req.persist ? "--persist" : "--no-persist");
  args.push(parts.join(" "));
  return args.join("; ");
}

/**
 * Interpret the SSH/helper failure and return the HTTP status + UI-facing
 * cause. D4/D1: 127 → helper not installed (423 with install hint), 126 →
 * passwordless sudo missing (423), transport timeouts → 503, everything else
 * → 502.
 * @param {unknown} err SSH error (message carries stderr from sshExec)
 * @returns {{ status: number, reason: string }}
 */
export function interpretHelperExit(err) {
  const msg = String((err && err.message) || err || "");
  if (/\b127\b|missing .*sparkdash-set-clock/.test(msg)) {
    return {
      status: 423,
      reason: "clock helper not installed — run scripts/install-clock-helper.sh on the host",
    };
  }
  if (/\b126\b|sudo -n required/.test(msg)) {
    return {
      status: 423,
      reason: "passwordless sudo for the clock helper is not configured — run scripts/install-clock-helper.sh",
    };
  }
  if (/timed out|connection refused|unreachable|no route|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return { status: 503, reason: "SSH transport failure" };
  }
  return { status: 502, reason: msg || "clock helper failed" };
}

/**
 * Parse a `cpuN:cpuinfo_min_freq:cpuinfo_max_freq` bounds dump into a
 * core → maxKhz map (the domain membership key: cores are grouped by their
 * cpuinfo_max_freq, never by hardcoded indices).
 * @param {string} raw
 * @returns {Map<string, number>}
 */
export function parseCpuCoreMaxKhz(raw) {
  const byCore = new Map();
  for (const line of String(raw ?? "").split("\n")) {
    const m = line.trim().match(/^cpu(\d+):(\d+):(\d+)$/);
    if (!m) continue;
    const maxKhz = Number(m[3]);
    if (!Number.isFinite(maxKhz) || maxKhz <= 0) continue;
    byCore.set(`cpu${m[1]}`, maxKhz);
  }
  return byCore;
}

/**
 * Expand a sysfs cpu token from a systemd unit ExecStart: `cpu5` → [cpu5],
 * `cpu{5..9,15..19}` → [cpu5..cpu9, cpu15..cpu19]. Returns [] for anything
 * unparsable (we never guess core identities).
 * @param {string} token
 * @returns {string[]}
 */
export function expandCpuToken(token) {
  const m = String(token ?? "").match(/^cpu\{(.+)\}$/);
  if (!m) return /^cpu\d+$/.test(String(token ?? "")) ? [String(token)] : [];
  const out = [];
  for (const part of m[1].split(",")) {
    const range = part.match(/^(\d+)\.\.(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 1024) continue;
      for (let i = lo; i <= hi; i++) out.push(`cpu${i}`);
    } else if (/^\d+$/.test(part)) {
      out.push(`cpu${part}`);
    }
  }
  return out;
}

/**
 * Parse the CPU boot unit (cpu-clock-cap.service) ExecStart into per-domain
 * boot-default MHz values — the "Boot defaults" preset of D7, derived from
 * what the unit actually installs (never hardcoded). Handles both explicit
 * per-core echoes and systemd brace-range forms. A core whose cpuinfo_max_freq
 * is unknown is skipped. Values are kHz in the unit → MHz out.
 * @param {string} raw unit file text
 * @param {Map<string, number>} coreMaxKhz core → cpuinfo_max_freq (kHz)
 * @returns {{ 'cpu-big'?: number, 'cpu-little'?: number }}
 */
export function parseCpuBootUnitDefaults(raw, coreMaxKhz) {
  const out = {};
  const text = String(raw ?? "");
  const re = /echo\s+(\d+)\s*>\s*\/sys\/devices\/system\/cpu\/([^\s/]+)\/cpufreq\/max_perf/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const khz = Number(m[1]);
    if (!Number.isFinite(khz) || khz <= 0) continue;
    for (const cpuN of expandCpuToken(m[2])) {
      const maxKhz = coreMaxKhz?.get(cpuN);
      if (!maxKhz) continue;
      const id = maxKhz >= 3_000_000 ? "cpu-big" : "cpu-little";
      out[id] = Math.round(khz / 1000);
    }
  }
  return out;
}

/**
 * Map a live read (cpuDomains + gpuLock from _getClockCaps) plus discovered
 * bounds into the client-facing ClockCapDomain list (D1). `writable` mirrors
 * the apply paths: local units are writable via the container root path;
 * remote units need the provisioned helper.
 * @param {object} p
 * @returns {Array<{id: string, label: string, currentMHz: number|null, hardMinMHz: number, hardMaxMHz: number, stepMHz: number, presets: number[], unitPath: string|null, writable: boolean, reason?: string}>}
 */
export function buildClockCapDomains({
  cpuDomains,
  gpuLock,
  cpuBounds,
  gpuCeilingMHz,
  helperAvailable,
  helperChecked,
  cpuBootDefaults,
  gpuBootDefaultMHz,
}) {
  const out = [];
  const helperUp = helperChecked ? Boolean(helperAvailable) : false;
  const bootDefaults = cpuBootDefaults || {};

  // CPU domains — big first (sorted max desc by both parsers).
  const bounds = Array.isArray(cpuBounds) ? cpuBounds : [];
  const domains = Array.isArray(cpuDomains) ? cpuDomains : [];
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i];
    const live = domains[i];
    // Parsers sort the same way; when the live read is missing/degenerate,
    // fall back to the bounds identity so the row still renders honestly.
    const capMHz = live && live.maxMHz === Math.round(b.maxKhz / 1000) ? live.capMHz : null;
    const id = b.maxKhz >= 3_000_000 ? "cpu-big" : "cpu-little";
    // D7 presets: Boot default (what the boot unit installs, when readable)
    // and No cap (= this domain's hardware maximum).
    const presets = [];
    if (bootDefaults[id] != null) presets.push({ label: "Boot default", value: bootDefaults[id] });
    presets.push({ label: "No cap", value: Math.round(b.maxKhz / 1000) });
    out.push({
      id,
      label: CLOCK_DOMAIN_LABELS[id],
      currentMHz: capMHz,
      hardMinMHz: Math.round(b.minKhz / 1000),
      hardMaxMHz: Math.round(b.maxKhz / 1000),
      stepMHz: 25,
      presets,
      unitPath: "/etc/systemd/system/cpu-clock-cap.service",
      writable: helperUp,
      reason: helperUp ? undefined : "clock helper not installed on the host",
    });
  }

  // GPU domain.
  if (gpuCeilingMHz != null) {
    const presets = [];
    if (gpuBootDefaultMHz != null) presets.push({ label: "Boot default", value: gpuBootDefaultMHz });
    presets.push({ label: "No cap", value: null });
    out.push({
      id: "gpu",
      label: CLOCK_DOMAIN_LABELS.gpu,
      currentMHz: gpuLock ? gpuLock.maxMHz : null,
      hardMinMHz: 0,
      hardMaxMHz: gpuCeilingMHz,
      stepMHz: 25,
      presets,
      unitPath: "/etc/systemd/system/gpu-clock-lock.service",
      writable: helperUp,
      reason: helperUp ? undefined : "clock helper not installed on the host",
    });
  }

  return out;
}
