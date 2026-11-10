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

// Desktops only, by firmware identifier: Mac17,14 is a Mac Studio, Mac16,10 a mini.
// A laptop's wall draw depends on charge state, lid and dock, and an iMac folds its
// display in, so neither gets a static floor.
const DESKTOP_MODEL = /^Mac\d/;

/** Apple's published idle wall watts, keyed on the chip the agent reports. */
const APPLE_PUBLISHED_IDLE_W = {
  "M6": 4,        // Mac mini (M6)
  "M5 Max": 7,    // Mac Studio (M5 Max), Mac17,14
  "M5 Pro": 6,    // Mac mini (M5 Pro)
  "M5 Ultra": 9,  // Mac Studio (M5 Ultra), Mac17,15
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

/**
 * Estimate total system draw from the SoC package figure plus the model's idle floor.
 *
 * @param {{ model?: string | null, chip?: string | null, packageW?: number | null }} reading
 *   firmware identifier (`hw.model`), chip name, and the measured package watts.
 * @returns {{ watts: number, source: "apple-idle" | "desktop-idle" } | null} null when
 *   there is no package figure to build on, or the machine is not a published desktop.
 */
export function estimateSystemPowerW({ model, chip, packageW } = {}) {
  if (!Number.isFinite(packageW) || packageW < 0) return null;
  if (typeof model !== "string" || !DESKTOP_MODEL.test(model)) return null;
  const chipName = typeof chip === "string" ? chip.replace(/^Apple\s+/i, "").trim() : "";
  if (chipName in APPLE_PUBLISHED_IDLE_W) {
    return { watts: round1(packageW + APPLE_PUBLISHED_IDLE_W[chipName]), source: "apple-idle" };
  }
  return { watts: round1(packageW + DESKTOP_IDLE_FALLBACK_W), source: "desktop-idle" };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
