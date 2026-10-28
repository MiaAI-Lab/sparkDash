/**
 * Model discovery — the read-only scan behind "Discover on this Spark" in the
 * Add-a-model dialog. Finding a model folder by hand (and typing its absolute
 * path) is the single most common way the launcher gets mis-configured, so the
 * dialog offers to fill it from what is actually on the machine:
 *
 *   a) scripted   — folders holding a start.sh under the configured scan roots,
 *   b) ollama     — weights in the spark-ollama-engine container (when it runs),
 *   c) huggingface — repos in ~/.cache/huggingface/hub.
 *
 * SHELL-INJECTION POSTURE: every command this module runs is a FIXED template.
 * The only variable text is the scan-root list, which comes from server config
 * (config.js / MODEL_DISCOVERY_ROOTS), never from a request body, and each root
 * must pass the ROOT_CHARS allowlist before it is spliced in unquoted (it has
 * to stay unquoted so the host shell expands $HOME and the Qwen* glob). Names,
 * sizes and paths that come BACK from the host are treated as inert data: they
 * are parsed and returned, never concatenated into another command. The caller
 * (server/index.js) executes execHost through the launcher's host-user drop,
 * which refuses to run as root.
 */
import { MODEL_DISCOVERY_ROOTS, MODEL_DISCOVERY_TIMEOUT_MS } from "../config.js";
import { isValidSshUser } from "../validate.js";

export const OLLAMA_ENGINE_CONTAINER = "spark-ollama-engine";
export const HF_HUB_DIR = "~/.cache/huggingface/hub";
/** Cap on scripted candidates (the `head -30` on the find is the real cap). */
export const MAX_SCRIPTED_CANDIDATES = 30;

/**
 * Allowlist for a scan root spliced into a `find` template unquoted. Deliberately
 * excludes every shell metacharacter: whitespace, quotes, backtick, ; | & < > ( )
 * { } [ ] ! # ? \ and both assignment characters. $ and * stay legal because the
 * defaults need `$HOME` and `Qwen*`; a stray `$NAME` can only expand to a path.
 */
const ROOT_CHARS = /^[A-Za-z0-9_./~*$@+-]+$/;

/** True when a root is safe to splice into the fixed find templates. */
export function isSafeScanRoot(root) {
  return typeof root === "string" && root.length > 0 && root.length <= 512 && ROOT_CHARS.test(root) && !root.includes("..");
}

/** `find <roots> -maxdepth 3 -type f -name start.sh 2>/dev/null | head -30` */
export function buildFindStartsCommand(roots) {
  return `find ${roots.join(" ")} -maxdepth 3 -type f -name start.sh 2>/dev/null | head -${MAX_SCRIPTED_CANDIDATES}`;
}

/** Same bounded find, but listing stop.sh so a candidate's stop script can be confirmed. */
export function buildFindStopsCommand(roots) {
  return `find ${roots.join(" ")} -maxdepth 3 -type f -name stop.sh 2>/dev/null | head -${MAX_SCRIPTED_CANDIDATES}`;
}

/** Container-state probe; stdout is a container id (non-empty) only when the engine runs. */
export function buildOllamaRunningCommand() {
  return `docker ps -q -f name=^${OLLAMA_ENGINE_CONTAINER}$ 2>/dev/null | head -1`;
}

/** Fixed container exec; never carries any parsed model name. */
export function buildOllamaListCommand() {
  return `docker exec ${OLLAMA_ENGINE_CONTAINER} ollama list 2>/dev/null`;
}

/** Fixed listing of the HF hub cache ($HOME expands on the host, where the drop exports it). */
export function buildHfCacheCommand() {
  return `ls -1 $HOME/.cache/huggingface/hub 2>/dev/null | head -${MAX_SCRIPTED_CANDIDATES}`;
}

/** Any path segment that marks a folder we never surface (dot-dirs, vendored deps). */
function isExcludedDir(directory) {
  return directory
    .split("/")
    .some((segment) => (segment.startsWith(".") && segment !== "." && segment !== "..") || segment === "node_modules");
}

/**
 * Map `find ... -name start.sh` output to scripted candidates. Dedupes (the
 * default roots nest: $HOME contains $HOME/llms), drops dot-dir and
 * node_modules hits, and marks stopScript only when stop.sh was also listed.
 * Exported for tests.
 */
export function mapScriptedFindOutput(startsOutput, stopsOutput = "") {
  const stopDirs = new Set(
    String(stopsOutput ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith("/stop.sh"))
      .map((l) => l.slice(0, -"/stop.sh".length))
  );
  const byDir = new Map();
  for (const rawLine of String(startsOutput ?? "").split("\n")) {
    const hit = rawLine.trim();
    if (!hit || !hit.endsWith("/start.sh")) continue;
    const directory = hit.slice(0, -"/start.sh".length);
    if (!directory || directory === "/" || isExcludedDir(directory)) continue;
    if (byDir.has(directory)) continue;
    const name = directory.split("/").filter(Boolean).pop();
    if (!name) continue;
    byDir.set(directory, {
      kind: "scripted",
      name,
      directory,
      startScript: "start.sh",
      stopScript: stopDirs.has(directory) ? "stop.sh" : null,
    });
    if (byDir.size >= MAX_SCRIPTED_CANDIDATES) break;
  }
  return [...byDir.values()];
}

/**
 * Parse `ollama list` (NAME/SIZE/MODIFIED columns) into ollama candidates.
 * The header line and anything without a leading name + byte-size pair is
 * skipped — a partially-written table row must not become a candidate.
 * Exported for tests.
 */
export function parseOllamaList(output) {
  const out = [];
  for (const rawLine of String(output ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || /^NAME\b/i.test(line)) continue;
    const m = /^(\S+)\s+([0-9][0-9.]*\s*(?:[KMGTPE]i?B|[KMGTPE]B))\b/i.exec(line);
    if (!m) continue;
    out.push({ kind: "ollama", name: m[1], size: m[2].replace(/\s+/g, " ") });
  }
  return out;
}

/**
 * Convert an HF hub cache folder name (`models--org--name`) to `org/name`, or
 * null when the entry is not a model repo (`version.txt`, `datasets--…`, …).
 * The repo name may itself contain single hyphens, so only the FIRST `--`
 * separates org from name. Exported for tests.
 */
export function hfNameFromDirEntry(entry) {
  if (typeof entry !== "string" || !entry.startsWith("models--")) return null;
  const rest = entry.slice("models--".length);
  const sep = rest.indexOf("--");
  if (sep <= 0 || sep + 2 >= rest.length) return null;
  const org = rest.slice(0, sep);
  const name = rest.slice(sep + 2);
  if (!org || !name || org.includes("/") || name.includes("/")) return null;
  return `${org}/${name}`;
}

/** Map the hub-cache listing to huggingface candidates. Exported for tests. */
export function parseHfCacheListing(output) {
  const out = [];
  for (const rawLine of String(output ?? "").split("\n")) {
    const entry = rawLine.trim();
    if (!entry) continue;
    const name = hfNameFromDirEntry(entry);
    if (!name) continue;
    out.push({ kind: "huggingface", name, directory: `${HF_HUB_DIR}/${entry}` });
  }
  return out;
}

function noteFromError(prefix, err) {
  const msg = String(err?.message ?? err ?? "").trim().slice(0, 200);
  return `${prefix}: ${msg || "command failed"}`;
}

/**
 * Scan the dashboard's own Spark for model candidates. NEVER throws: a source
 * that fails degrades to a `notes[]` entry so the dialog can show what was
 * scanned and what did not answer. The ollama source is omitted silently when
 * the engine container is not running — that is the normal desktop state, not
 * a failure worth a warning.
 *
 * @param {object} opts
 * @param {(cmd: string, timeoutMs: number) => Promise<string>} opts.execHost
 *   runs ONE of this module's fixed templates on the host and resolves stdout.
 *   Supplied by the caller (index.js wires it to the launcher's host-user drop).
 * @param {string} [opts.sshUser] the host user the drop runs as; validated, and
 *   deliberately never spliced into a command.
 * @param {string[]} [opts.roots] scan roots (server config only; defaults to
 *   config.js MODEL_DISCOVERY_ROOTS).
 * @param {number} [opts.timeoutMs] per-command cap.
 * @returns {Promise<{ candidates: object[], scannedRoots: string[], notes: string[] }>}
 */
export async function discoverModelCandidates({
  execHost,
  sshUser,
  roots = MODEL_DISCOVERY_ROOTS,
  timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS,
} = {}) {
  if (typeof execHost !== "function") {
    throw new TypeError("discoverModelCandidates requires an execHost(cmd, timeoutMs) function");
  }
  if (sshUser != null && sshUser !== "" && !isValidSshUser(sshUser)) {
    throw new Error("Invalid SSH user for model discovery (allowed: letters, digits, . _ -)");
  }

  const candidates = [];
  const scannedRoots = [];
  const notes = [];

  // ── a) scripted: folders with a start.sh under the configured roots ──
  try {
    const safeRoots = [];
    for (const root of Array.isArray(roots) ? roots : []) {
      if (isSafeScanRoot(root)) safeRoots.push(root);
      else notes.push(`scripted: skipped scan root with unsupported characters: ${String(root).slice(0, 80)}`);
    }
    if (safeRoots.length === 0) {
      notes.push("scripted: no usable scan roots configured");
    } else {
      scannedRoots.push(...safeRoots);
      const startsOutput = await execHost(buildFindStartsCommand(safeRoots), timeoutMs);
      let stopsOutput = "";
      try {
        stopsOutput = await execHost(buildFindStopsCommand(safeRoots), timeoutMs);
      } catch {
        // stop.sh presence is a nicety; a missing listing only means no stopScript.
      }
      candidates.push(...mapScriptedFindOutput(startsOutput, stopsOutput));
    }
  } catch (err) {
    notes.push(noteFromError("scripted", err));
  }

  // ── b) ollama: only while the engine container runs ──
  try {
    const running = await execHost(buildOllamaRunningCommand(), timeoutMs).catch(() => "");
    if (String(running).trim() !== "") {
      const listOutput = await execHost(buildOllamaListCommand(), timeoutMs);
      candidates.push(...parseOllamaList(listOutput));
    }
    // Not running (or docker absent): omit silently — nothing to launch from there.
  } catch (err) {
    notes.push(noteFromError("ollama", err));
  }

  // ── c) huggingface: repos in the hub cache ──
  try {
    const hfOutput = await execHost(buildHfCacheCommand(), timeoutMs);
    candidates.push(...parseHfCacheListing(hfOutput));
  } catch (err) {
    notes.push(noteFromError("huggingface", err));
  }

  return { candidates, scannedRoots, notes };
}
