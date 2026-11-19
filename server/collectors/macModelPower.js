/**
 * Wall-power floor for Apple Silicon desktops.
 *
 * Apple Silicon `powermetrics` reports only the CPU, GPU and ANE rails, so a Mac's
 * system draw leaves out memory, storage, networking, fans and supply losses, and
 * an idle box reads about 0 W while still pulling real power. Apple publishes wall
 * power per desktop model - "Idle" there is Finder only, no peripherals, 20.2 °C
 * ambient - so that published figure becomes the floor under the package number the
 * agent measured. Sources: https://support.apple.com/en-us/102027 (Mac Studio),
 * https://support.apple.com/en-us/103253 (Mac mini), and the matching Mac Pro
 * document.
 *
 * Every number this returns is an estimate, so the caller keeps `systemPowerSource`
 * next to the watts and the tile renders it as one. A wall meter
 * (config/power-meters.json) measures, and the Energy page prefers it.
 */

// Desktops, by firmware identifier. The `MacNN,N` prefix does not say which chassis a
// Mac is (Mac14,3 is a Mac mini, Mac14,9 a MacBook Pro, Mac14,13 a Mac Studio), so the
// desktops are named here one by one. Laptops and iMacs never get a floor: a laptop's
// wall draw follows charge state, lid and dock, and an iMac folds its display in. A
// desktop Apple ships later stays unestimated until its identifier lands here.
const DESKTOP_MODELS = new Set([
  "Macmini9,1", // Mac mini (M1, 2020)
  "Mac14,3",    // Mac mini (M2, 2023)
  "Mac14,12",   // Mac mini (M2 Pro, 2023)
  "Mac16,10",   // Mac mini (M4, 2024)
  "Mac16,11",   // Mac mini (M4 Pro, 2024)
  "Mac17,16",   // Mac mini (M5 Pro, 2026)
  "Mac18,5",    // Mac mini (M6, 2026)
  "Mac13,1",    // Mac Studio (M1 Max, 2022)
  "Mac13,2",    // Mac Studio (M1 Ultra, 2022)
  "Mac14,13",   // Mac Studio (M2 Max, 2023)
  "Mac14,14",   // Mac Studio (M2 Ultra, 2023)
  "Mac15,14",   // Mac Studio (M3 Ultra, 2025)
  "Mac16,9",    // Mac Studio (M4 Max, 2025)
  "Mac17,14",   // Mac Studio (M5 Max, 2026)
  "Mac17,15",   // Mac Studio (M5 Ultra, 2026)
  "Mac14,8",    // Mac Pro (M2 Ultra, 2023): takes its chip's Studio row
]);

/** Apple's published idle wall watts, keyed on the chip the agent reports. */
const APPLE_PUBLISHED_IDLE_W = {
  "M6": 4,        // Mac mini (M6)
  "M5 Max": 7,    // Mac Studio (M5 Max)
  "M5 Pro": 6,    // Mac mini (M5 Pro)
  "M5 Ultra": 9,  // Mac Studio (M5 Ultra)
  "M4": 4,        // Mac mini (2024)
  "M4 Pro": 5,    // Mac mini (2024)
  "M4 Max": 6,    // Mac Studio (2025)
  "M3 Ultra": 9,  // Mac Studio (2025)
  "M2": 7,        // Mac mini (2023)
  "M2 Pro": 7,    // Mac mini (2023)
  "M2 Max": 9,    // Mac Studio (2023)
  "M2 Ultra": 10, // Mac Studio (2023)
  "M1": 6.8,      // Mac mini (M1, 2020)
  "M1 Max": 11,   // Mac Studio (2022)
  "M1 Ultra": 13, // Mac Studio (2022)
};

// Mid-range of the published desktop figures above, for a chip Apple has not
// published a row for yet (a new release, or a chip string we do not recognise).
const DESKTOP_IDLE_FALLBACK_W = 8;

// Apple's idle figure already counts the SoC's own idle draw, so the package is added
// net of that share. Counting it twice would overstate every desktop.
const SOC_IDLE_SHARE_W = 2.5;

/**
 * Estimate total system draw from the SoC package figure plus the model's idle floor.
 *
 * @param {{ model?: string | null, chip?: string | null, packageW?: number | null }} reading
 *   firmware identifier (`hw.model`), chip name, and the measured package watts.
 * @returns {{ watts: number, source: "apple-idle" | "desktop-idle" } | null} null when
 *   there is no package figure to build on, or the machine is not a known desktop.
 */
export function estimateSystemPowerW({ model, chip, packageW } = {}) {
  if (!Number.isFinite(packageW) || packageW < 0) return null;
  if (typeof model !== "string" || !DESKTOP_MODELS.has(model.trim())) return null;
  const chipName = typeof chip === "string" ? chip.replace(/^Apple\s+/i, "").trim() : "";
  const published = Object.hasOwn(APPLE_PUBLISHED_IDLE_W, chipName);
  const idleW = published ? APPLE_PUBLISHED_IDLE_W[chipName] : DESKTOP_IDLE_FALLBACK_W;
  return {
    watts: round1(idleW + Math.max(0, packageW - SOC_IDLE_SHARE_W)),
    source: published ? "apple-idle" : "desktop-idle",
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
