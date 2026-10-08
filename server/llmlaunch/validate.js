/**
 * Validation for user-registered LLM launchers (a directory holding start.sh /
 * stop.sh). Everything that reaches a shell is checked against a strict
 * allow-list here, so the command builders can embed values in single quotes
 * without any escaping: no quotes, spaces, `$`, backticks or `..` get through.
 */

const DIR_RE = /^(~\/|\/)[A-Za-z0-9._@+=,/-]*$/;
const SCRIPT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const MAX_LAUNCHERS_PER_SPARK = 24;

/** @returns {string|null} error message, or null when valid. */
export function validateDir(dir) {
  if (typeof dir !== "string" || !dir.trim()) return "Directory is required";
  const d = dir.trim();
  if (d.length > 300) return "Directory path is too long";
  if (!DIR_RE.test(d)) {
    return "Directory must be an absolute path (or start with ~/) using letters, digits and . _ - @ + = , /";
  }
  if (d.split("/").some((seg) => seg === "..")) return "Directory must not contain ..";
  return null;
}

export function validateScriptName(name, label) {
  if (typeof name !== "string" || !SCRIPT_RE.test(name)) {
    return `${label} must be a file name like start.sh (letters, digits, . _ -)`;
  }
  return null;
}

export function isValidLauncherId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

/** URL-safe slug for an id derived from a display name. */
export function slugify(name) {
  const s = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "model";
}

/**
 * Normalize + validate user input for a launcher.
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function normalizeLauncherInput(input) {
  const body = input && typeof input === "object" ? input : {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "Name is required" };
  if (name.length > 80) return { ok: false, error: "Name is too long (80 characters max)" };
  const dir = typeof body.dir === "string" ? body.dir.trim() : "";
  const dirErr = validateDir(dir);
  if (dirErr) return { ok: false, error: dirErr };
  const startScript = typeof body.startScript === "string" && body.startScript.trim() ? body.startScript.trim() : "start.sh";
  const stopScript = typeof body.stopScript === "string" && body.stopScript.trim() ? body.stopScript.trim() : "stop.sh";
  const startErr = validateScriptName(startScript, "Start script");
  if (startErr) return { ok: false, error: startErr };
  const stopErr = validateScriptName(stopScript, "Stop script");
  if (stopErr) return { ok: false, error: stopErr };
  let port = null;
  if (body.port !== undefined && body.port !== null && body.port !== "") {
    const p = Number(body.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: "Port must be 1-65535" };
    port = p;
  }
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 300) : "";
  return { ok: true, value: { name, dir, startScript, stopScript, port, notes } };
}
