/**
 * AMD GPUs on Linux, read from the amdgpu driver's own sysfs and hwmon files. No vendor
 * tool: this replaced the amd-smi path, which needed ROCm installed on every unit and still
 * answered "N/A" for utilization and socket power on gfx1151 (Strix Halo) while reporting
 * only the BAR carve-out as memory. The driver knows all of it, and reads without a
 * license, a daemon or a Python.
 *
 * Same shape as the Intel collector (intelGpu.js): one probe script runs in the node's
 * single SSH round trip, and locally the very same fields are read straight from sysfs in
 * this process — no shell, so a local poll costs a dozen small opens. The parsers are pure
 * and take a root path, so tests can point them at a fixture tree.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Above this, a "VRAM" that could be a BIOS carve-out is more likely a small discrete
 * card's own memory than an integrated one; the PCI class check decides those cases.
 */
const APU_CARVEOUT_MAX_BYTES = 16 * 1024 ** 3;

/** Domain:bus:device.function, e.g. 0000:c6:00.0 (the domain may be wider than 4 digits). */
const PCI_ADDRESS = /^[0-9a-f]{4,8}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i;

/**
 * The few device ids worth naming for themselves; sysfs carries no marketing name, so
 * anything else is named by the id the user can look up.
 */
const AMD_DEVICE_NAMES = {
  "0x1586": "Radeon 8060S", // Strix Halo (gfx1151)
  "0x1585": "Radeon 8050S", // Strix Point
  "0x13c0": "Radeon 780M", // Phoenix
};

const MB = 1048576;

/**
 * POSIX sh. Prints "key value" lines, one block per card headed by `@amd <pci>`. Every read
 * tolerates a missing file, and the script ends with `true` so a missing card never fails
 * the surrounding SSH command. No unquoted glob anywhere: a zsh login shell aborts on an
 * unmatched one, which is why the card list comes from `find` and the legacy `*_size` names
 * are read by `cat a b | head -1` rather than by a wildcard.
 *
 * `cat a b 2>/dev/null | head -1` is the "new name, else old name" idiom: kernels renamed
 * `mem_info_vram_size` to `mem_info_vram_total` (and the gtt/visible ones with it), and the
 * first file that answers wins.
 *
 * AMD_PROBE_ROOT prefixes every path (tests point it at a fixture tree).
 */
export const AMD_PROBE_SCRIPT = [
  'R="${AMD_PROBE_ROOT:-}"',
  'for n in $(find "$R/sys/class/drm" -maxdepth 1 -name \'card[0-9]*\' 2>/dev/null | sed \'s|.*/card||\' | grep -E \'^[0-9]+$\' | sort -n); do',
  '  d="$R/sys/class/drm/card$n/device"',
  '  [ -e "$d/driver" ] || continue',
  '  [ "$(basename "$(readlink -f "$d/driver")")" = amdgpu ] || continue',
  '  echo "@amd $(basename "$(readlink -f "$d")")"',
  '  echo "id $(cat "$d/device" 2>/dev/null)"',
  '  echo "class $(cat "$d/class" 2>/dev/null)"',
  '  echo "busy $(cat "$d/gpu_busy_percent" 2>/dev/null)"',
  '  echo "vram_used $(cat "$d/mem_info_vram_used" 2>/dev/null)"',
  '  echo "vram_total $(cat "$d/mem_info_vram_total" "$d/mem_info_vram_size" 2>/dev/null | head -1)"',
  '  echo "vis_used $(cat "$d/mem_info_vis_vram_used" 2>/dev/null)"',
  '  echo "vis_total $(cat "$d/mem_info_vis_vram_total" "$d/mem_info_vis_vram_size" 2>/dev/null | head -1)"',
  '  echo "gtt_used $(cat "$d/mem_info_gtt_used" 2>/dev/null)"',
  '  echo "gtt_total $(cat "$d/mem_info_gtt_total" "$d/mem_info_gtt_size" 2>/dev/null | head -1)"',
  '  for h in $(find "$d/hwmon" -mindepth 1 -maxdepth 1 -name \'hwmon*\' 2>/dev/null | sort); do',
  '    [ "$(cat "$h/name" 2>/dev/null)" = amdgpu ] || continue',
  '    echo "power $(cat "$h/power1_average" "$h/power1_input" 2>/dev/null | head -1)"',
  '    echo "cap $(cat "$h/power1_cap" 2>/dev/null)"',
  '    echo "capmax $(cat "$h/power1_max" 2>/dev/null)"',
  '    echo "fan $(cat "$h/fan1_input" 2>/dev/null)"',
  '    for t in $(find "$h" -maxdepth 1 -name \'temp*_input\' 2>/dev/null | sort); do l=$(cat "${t%_input}_label" 2>/dev/null); echo "temp ${l:-$(basename "$t")} $(cat "$t" 2>/dev/null)"; done',
  '    for f in $(find "$h" -maxdepth 1 -name \'freq*_input\' 2>/dev/null | sort); do l=$(cat "${f%_input}_label" 2>/dev/null); echo "freq ${l:-$(basename "$f")} $(cat "$f" 2>/dev/null)"; done',
  '    break',
  '  done',
  '  sed \'s/^/sclk /\' "$d/pp_dpm_sclk" 2>/dev/null',
  "done; true",
].join("\n");

/** Trimmed file contents, or null when the file is missing, unreadable or empty. */
function readText(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/** Same, as an integer; sysfs writes plain decimal numbers. */
function readNumber(file) {
  const raw = readText(file);
  if (raw == null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** First integer found, so a kernel that kept the older `*_size` name is still read. */
function readFirst(...files) {
  for (const file of files) {
    const value = readNumber(file);
    if (value != null) return value;
  }
  return null;
}

/** hwmon sensors of one kind (`temp`, `freq`) as `{ label, value }`, labelled by the driver's `*_label`. */
function readLabeled(hwmon, kind) {
  let names = [];
  try {
    names = fs.readdirSync(hwmon);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const m = new RegExp(`^${kind}(\\d+)_input$`).exec(name);
    if (!m) continue;
    const value = readNumber(path.join(hwmon, name));
    if (value == null) continue;
    rows.push({ label: (readText(path.join(hwmon, `${kind}${m[1]}_label`)) ?? name).toLowerCase(), value });
  }
  return rows;
}

/**
 * `pp_dpm_sclk` lists the graphics clock steps one per line (`1: 2883Mhz *`), the star
 * marking the step in use. hwmon exposes only the current frequency, so this is where the
 * ceiling comes from — without it the panel cannot say how far below boost a card sits.
 */
function parseSclkSteps(text) {
  const steps = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*(\d+):\s*(\d+)\s*Mhz\s*(\*)?\s*$/i.exec(line);
    if (!m) continue;
    const mhz = Number.parseInt(m[2], 10);
    if (Number.isFinite(mhz)) steps.push({ mhz, current: Boolean(m[3]) });
  }
  return steps;
}

/** A card before its derived fields are computed. Missing files leave null, never 0. */
function emptyCard() {
  return {
    pci: null,
    deviceId: null,
    displayClass: false,
    busy: null,
    powerUw: null,
    capUw: null,
    capMaxUw: null,
    fanRpm: null,
    temps: [],
    freqs: [],
    sclkSteps: [],
    vramUsed: null,
    vramTotal: null,
    visVramUsed: null,
    visVramTotal: null,
    gttUsed: null,
    gttTotal: null,
  };
}

/**
 * Add the numbers the panel wants to a raw card: the one temperature to show, the power cap
 * (hwmon writes 0 for "no limit", which is not a limit), and the current and maximum
 * graphics clock.
 */
function finishCard(card) {
  const hottest = (rows) => (rows.length ? Math.max(...rows.map((row) => row.value)) : null);
  const withLabel = (rows, labels) => {
    for (const label of labels) {
      const hit = rows.find((row) => row.label === label);
      if (hit) return hit.value;
    }
    return null;
  };
  // "edge" is what amd-smi reported and what the vendor specs quote; "junction" is the
  // hotspot on cards without an edge sensor; anything else is the hottest of what is there.
  const tempMilli = withLabel(card.temps, ["edge", "junction"]) ?? hottest(card.temps);
  const sclk = withLabel(card.freqs, ["sclk", "gfxclk"]);
  const currentStep = card.sclkSteps.find((step) => step.current)?.mhz ?? null;
  const maxStep = hottest(card.sclkSteps.map((step) => ({ value: step.mhz })));
  // hwmon's freq is the current clock; pp_dpm_sclk is the only place the ceiling is stated.
  return {
    ...card,
    tempMilli,
    powerCapUw: card.capUw > 0 ? card.capUw : card.capMaxUw > 0 ? card.capMaxUw : null,
    // hwmon reports the clock in hertz; the panel and pp_dpm_sclk both speak megahertz.
    sclkMHz: sclk != null ? Math.round(sclk / 1e6) : currentStep,
    sclkMaxMHz: maxStep,
  };
}

/** One amdgpu card's device directory, read straight from sysfs (the local unit). */
function readCard(deviceDir) {
  const card = emptyCard();
  try {
    card.pci = path.basename(fs.realpathSync(deviceDir));
  } catch {
    // A fixture tree without a resolvable device path simply carries no PCI address.
  }
  card.deviceId = readText(path.join(deviceDir, "device"));
  // 0x0380 is "display controller"; a discrete card is 0x0300 "VGA". AMD's integrated parts
  // are the ones that report the display class, which is what separates them from a
  // discrete card whose resizable BAR maps all of its VRAM (and so also reports
  // visible == total).
  card.displayClass = /^0x0380/i.test(readText(path.join(deviceDir, "class")) ?? "");
  card.busy = readNumber(path.join(deviceDir, "gpu_busy_percent"));
  card.vramUsed = readNumber(path.join(deviceDir, "mem_info_vram_used"));
  card.vramTotal = readFirst(
    path.join(deviceDir, "mem_info_vram_total"),
    path.join(deviceDir, "mem_info_vram_size")
  );
  card.visVramUsed = readNumber(path.join(deviceDir, "mem_info_vis_vram_used"));
  card.visVramTotal = readFirst(
    path.join(deviceDir, "mem_info_vis_vram_total"),
    path.join(deviceDir, "mem_info_vis_vram_size")
  );
  card.gttUsed = readNumber(path.join(deviceDir, "mem_info_gtt_used"));
  card.gttTotal = readFirst(
    path.join(deviceDir, "mem_info_gtt_total"),
    path.join(deviceDir, "mem_info_gtt_size")
  );
  card.sclkSteps = parseSclkSteps(readText(path.join(deviceDir, "pp_dpm_sclk")));

  let entries = [];
  try {
    entries = fs.readdirSync(path.join(deviceDir, "hwmon"));
  } catch {
    entries = [];
  }
  const hwmon = entries
    .sort()
    .map((name) => path.join(deviceDir, "hwmon", name))
    .find((dir) => readText(path.join(dir, "name")) === "amdgpu");
  if (!hwmon) return finishCard(card);

  card.powerUw = readFirst(path.join(hwmon, "power1_average"), path.join(hwmon, "power1_input"));
  card.capUw = readNumber(path.join(hwmon, "power1_cap"));
  card.capMaxUw = readNumber(path.join(hwmon, "power1_max"));
  card.fanRpm = readNumber(path.join(hwmon, "fan1_input"));
  card.temps = readLabeled(hwmon, "temp");
  card.freqs = readLabeled(hwmon, "freq");
  return finishCard(card);
}

/**
 * Every amdgpu-bound card under a sysfs mount (`/sys`, or the host's under a container
 * bind mount), in `card<N>` order. Cards bound to another driver (nvidia, i915, xe) and
 * connector directories (`card0-DP-1`) are skipped, and a missing or unreadable
 * `<root>/class/drm` is simply no cards.
 */
export function collectAmdSysfs({ root = "/sys" } = {}) {
  const drm = path.join(root, "class/drm");
  let names = [];
  try {
    names = fs.readdirSync(drm);
  } catch {
    return [];
  }
  return names
    .map((name) => /^card(\d+)$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => path.join(drm, `card${m[1]}`, "device"))
    .filter((deviceDir) => {
      try {
        return path.basename(fs.readlinkSync(path.join(deviceDir, "driver"))) === "amdgpu";
      } catch {
        return false;
      }
    })
    .map(readCard);
}

const int = (text) => {
  const n = Number.parseInt(String(text ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse the probe output into finished card readings. Only a real PCI address opens a card
 * block — the address comes from the node, and lines under any other header are ignored.
 */
export function parseAmdProbe(output) {
  const cards = [];
  let cur = null;
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+)\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    if (key === "@amd") {
      const pci = rest.trim();
      // The address comes from the node: only a real PCI address opens a card block, and
      // the lines under any other header are ignored.
      if (!PCI_ADDRESS.test(pci)) {
        cur = null;
        continue;
      }
      cur = emptyCard();
      cur.pci = pci;
      cards.push(cur);
      continue;
    }
    if (!cur) continue;
    if (key === "id") cur.deviceId = rest.trim() || null;
    else if (key === "class") cur.displayClass = /^0x0380/i.test(rest.trim());
    else if (key === "busy") cur.busy = int(rest);
    else if (key === "power") cur.powerUw = int(rest);
    else if (key === "cap") cur.capUw = int(rest);
    else if (key === "capmax") cur.capMaxUw = int(rest);
    else if (key === "fan") cur.fanRpm = int(rest);
    else if (key === "vram_used") cur.vramUsed = int(rest);
    else if (key === "vram_total") cur.vramTotal = int(rest);
    else if (key === "vis_used") cur.visVramUsed = int(rest);
    else if (key === "vis_total") cur.visVramTotal = int(rest);
    else if (key === "gtt_used") cur.gttUsed = int(rest);
    else if (key === "gtt_total") cur.gttTotal = int(rest);
    else if (key === "temp" || key === "freq") {
      const [label, value] = rest.split(/\s+/);
      const n = int(value);
      if (label && n != null) (key === "temp" ? cur.temps : cur.freqs).push({ label: label.toLowerCase(), value: n });
    } else if (key === "sclk") {
      cur.sclkSteps.push(...parseSclkSteps(rest));
    }
  }
  return cards.map(finishCard);
}

/**
 * The memory pool to show for a card, in bytes, or null when nothing is known.
 *
 * An APU owns no memory: `mem_info_vram_*` is the BIOS carve-out mapped through the BAR,
 * and what a workload really allocates is GTT (system RAM). Showing 512 MB on a 128 GB
 * Strix Halo is worse than useless, so such a card is reported as one pool — carve-out and
 * GTT together. A discrete card keeps its own VRAM; its GTT is only an aperture into system
 * RAM and must never be added to it.
 *
 * Told apart by what the driver reports, not by a size guess: a card with no VRAM at all is
 * integrated by definition; otherwise an APU maps its whole "VRAM" through the BAR (visible
 * equals total), carries a much larger GTT behind it, and reports the display PCI class. A
 * wrong call only changes which pool is shown, never invents a number.
 */
export function amdMemoryPool(card) {
  const vramUsed = card.vramUsed ?? 0;
  const vramTotal = card.vramTotal ?? 0;
  const gttUsed = card.gttUsed ?? 0;
  const gttTotal = card.gttTotal ?? 0;
  if (vramTotal === 0 && gttTotal > 0) return { used: gttUsed, total: gttTotal, source: "gtt" };
  const carveOut =
    vramTotal > 0 &&
    vramTotal <= APU_CARVEOUT_MAX_BYTES &&
    card.visVramTotal === vramTotal &&
    gttTotal > 4 * vramTotal &&
    card.displayClass;
  if (carveOut) return { used: vramUsed + gttUsed, total: vramTotal + gttTotal, source: "gtt" };
  if (vramTotal > 0) return { used: vramUsed, total: vramTotal, source: "sysfs" };
  return null;
}

/**
 * Card readings as device entries, the shape the collector's per-device list uses (it adds
 * the AMD index range and the throttle view). A number that could not be read is reported
 * unavailable instead of zero, so the panel shows "—" rather than a confident 0.
 */
export function amdDevicesFromCards(cards) {
  return cards.map((card, i) => {
    const pool = amdMemoryPool(card);
    const temperature = card.tempMilli != null ? Math.round(card.tempMilli / 100) / 10 : null;
    const powerDraw = card.powerUw != null ? Math.round(card.powerUw / 1e4) / 100 : null;
    const powerLimit = card.powerCapUw != null ? Math.round(card.powerCapUw / 1e4) / 100 : null;
    const used = pool ? Math.round(pool.used / MB) : null;
    const total = pool ? Math.round(pool.total / MB) : null;
    return {
      index: i,
      physicalIndex: i,
      name: AMD_DEVICE_NAMES[card.deviceId] ?? (card.deviceId ? `AMD GPU [${card.deviceId.replace(/^0x/i, "")}]` : "AMD GPU"),
      uuid: null,
      vendor: "amd",
      pci: card.pci,
      temperature: temperature ?? 0,
      usage: card.busy ?? 0,
      powerDraw: powerDraw ?? 0,
      powerLimit: powerLimit ?? 0,
      power: { draw: powerDraw ?? 0, limit: powerLimit ?? 0 },
      vram: {
        used: used ?? 0,
        total: total ?? 0,
        percentage: total > 0 && used != null ? Math.min(100, Math.round((used / total) * 100)) : 0,
        available: used != null && total != null ? Math.max(0, total - used) : 0,
      },
      vramSource: pool?.source ?? null,
      fanRpm: card.fanRpm,
      smClockMHz: card.sclkMHz,
      smClockMaxMHz: card.sclkMaxMHz,
      metricAvailability: {
        temperature: temperature != null,
        usage: card.busy != null,
        powerDraw: powerDraw != null,
        powerLimit: powerLimit != null,
        vramUsed: used != null,
        vramTotal: total != null && total > 0,
      },
      processes: [],
    };
  });
}
