/**
 * Persist generation-token counters across LLM process restarts.
 * A drop in the live counter banks the previous value.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../config/token-bank.json"
);

function bankPath() {
  return process.env.TOKEN_BANK_PATH || DEFAULT_PATH;
}

function load() {
  try {
    const raw = readFileSync(bankPath(), "utf8");
    const j = JSON.parse(raw);
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function save(obj) {
  try {
    const p = bankPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(obj)}\n`);
  } catch {
    /* never crash the poller */
  }
}

/**
 * @param {string} key sparkId:port
 * @param {number} live current engine counter
 * @returns {{ lifetime: number, banked: number, live: number }}
 */
export function applyTokenBank(key, live) {
  const n = typeof live === "number" && Number.isFinite(live) && live >= 0 ? live : 0;
  const k = String(key || "").trim() || "unknown";
  const store = load();
  const rec = store[k] && typeof store[k] === "object" ? store[k] : { banked: 0, lastLive: 0 };
  let banked = Number(rec.banked) || 0;
  const lastLive = Number(rec.lastLive) || 0;
  if (n < lastLive) banked += lastLive;
  store[k] = { banked, lastLive: n };
  save(store);
  return { lifetime: banked + n, banked, live: n };
}
