/**
 * Model discovery — the read-only scan behind "Discover on this Spark" in the
 * Add-a-model dialog. Finding a model folder by hand (and typing its absolute
 * path) is the single most common way the launcher gets mis-configured, so the
 * dialog offers to fill it from what is actually on the machine:
 *
 *   a) scripted   — folders holding a start.sh (or .ps1/.cmd/.bat) under the
 *                   configured scan roots,
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
 *
 * PLATFORMS: on a POSIX host the templates are bash; on the LOCAL Windows host
 * they become PowerShell equivalents (Get-ChildItem). The `windows` flag on
 * each builder / discoverModelCandidates selects the variant. Windows path
 * output (backslashes) is normalised to forward slashes by the parsers so the
 * existing POSIX-oriented readers keep working unchanged.
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

/**
 * Expand a POSIX-style root ($HOME/..., ~/...) for the target platform.
 * On Windows the user profile is $env:USERPROFILE and separators are backslashes.
 */
export function expandRoot(root, windows) {
  let r = String(root);
  if (windows) {
    if (r.startsWith("$HOME/")) r = "$env:USERPROFILE\\" + r.slice("$HOME/".length);
    else if (r === "$HOME") r = "$env:USERPROFILE";
    else if (r.startsWith("~/")) r = "$env:USERPROFILE\\" + r.slice(2);
    else if (r === "~") r = "$env:USERPROFILE";
    return r.replace(/\//g, "\\");
  }
  return r;
}

/**
 * A pruned recursive search (PowerShell). Unlike `-Recurse` (which would descend
 * into node_modules / venv / .git and explode on a wide root), this walks the
 * tree and skips dependency / build directories, emitting the full path of each
 * matching file up to the candidate cap.
 */
function psWalkCommand(roots, names) {
  const psRoots = (roots || []).map((r) => `'${expandRoot(r, true)}'`).join(", ");
  const nameList = names.map((n) => `'${n}'`).join(", ");
  const badList = [
    "node_modules", "venv", ".venv", ".git", "__pycache__", ".cache", "dist", "build", ".next", "out", "bin", "obj", "target",
    // The default scan root is $HOME; these huge user directories never hold a
    // model launcher and would otherwise dominate the walk on a real desktop.
    "AppData", "Documents", "Downloads", ".workbuddy", ".npm", ".nuget", ".cargo", ".rustup", ".conda", "miniconda3", "anaconda3", ".gradle", ".m2", ".vscode", ".vs", "OneDrive", "Pictures", "Music", "Videos", "Links", "Favorites", "Saved Games", "Contacts", "Searches", "3D Objects",
  ].map((n) => `'${n}'`).join(", ");
  return [
    `$ProgressPreference = "SilentlyContinue"`,
    `$names = @(${nameList})`,
    `$bad = @(${badList})`,
    `function Walk($dir, $depth) {`,
    `  if ($depth -gt 3) { return }`,
    `  Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name } | ForEach-Object { $_.FullName }`,
    `  Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue | Where-Object { $bad -notcontains $_.Name } | ForEach-Object { Walk $_.FullName ($depth + 1) }`,
    `}`,
    `Get-ChildItem -Path ${psRoots} -Directory -ErrorAction SilentlyContinue | ForEach-Object { Walk $_.FullName 0 } | Select-Object -First ${MAX_SCRIPTED_CANDIDATES}`,
    // A missing scan root makes Get-ChildItem exit 1 even with SilentlyContinue;
    // the data is on stdout, so always end 0 so the module reads "nothing found", not an error.
    `exit 0`,
    ``,
  ].join("\n");
}

/** `find <roots> ... -name start.*`  (bash on POSIX; pruned PowerShell on Windows). */
export function buildFindStartsCommand(roots, windows = false) {
  if (windows) return psWalkCommand(roots, ["start.ps1", "start.cmd", "start.bat", "start.sh"]);
  return `find ${roots.join(" ")} -maxdepth 3 -type f -name start.sh 2>/dev/null | head -${MAX_SCRIPTED_CANDIDATES}`;
}

/** Same bounded search, but for a stop script of any supported type. */
export function buildFindStopsCommand(roots, windows = false) {
  if (windows) return psWalkCommand(roots, ["stop.ps1", "stop.cmd", "stop.bat", "stop.sh"]);
  return `find ${roots.join(" ")} -maxdepth 3 -type f -name stop.sh 2>/dev/null | head -${MAX_SCRIPTED_CANDIDATES}`;
}

/** Container-state probe; a non-empty stdout (a container id) only when running. */
export function buildOllamaRunningCommand(windows = false) {
  if (windows) {
    // A Linux ollama engine container requires the Docker engine on the host.
    // Without it the probe must resolve to empty (== not running) silently. A
    // non-zero docker exit must not surface as a discovery failure, so end 0.
    return `if (Get-Command docker -ErrorAction SilentlyContinue) { docker ps -q -f "name=^${OLLAMA_ENGINE_CONTAINER}$" 2>$null | Select-Object -First 1 }; exit 0`;
  }
  return `docker ps -q -f name=^${OLLAMA_ENGINE_CONTAINER}$ 2>/dev/null | head -1`;
}

/** Fixed container exec; never carries any parsed model name. */
export function buildOllamaListCommand(windows = false) {
  if (windows) return `docker exec ${OLLAMA_ENGINE_CONTAINER} ollama list 2>$null`;
  return `docker exec ${OLLAMA_ENGINE_CONTAINER} ollama list 2>/dev/null`;
}

/** Fixed listing of the HF hub cache ($HOME expands on the host). */
export function buildHfCacheCommand(windows = false) {
  if (windows) {
    // Guard the (often absent) hub dir: Get-ChildItem exits 1 on a missing path
    // even with SilentlyContinue, which the module would misread as a failure.
    return `$ProgressPreference = "SilentlyContinue"; if (Test-Path '${expandRoot(HF_HUB_DIR, true)}') { Get-ChildItem -Path '${expandRoot(HF_HUB_DIR, true)}' -Name -ErrorAction SilentlyContinue | Select-Object -First ${MAX_SCRIPTED_CANDIDATES} }; exit 0`;
  }
  return `ls -1 $HOME/.cache/huggingface/hub 2>/dev/null | head -${MAX_SCRIPTED_CANDIDATES}`;
}

/** Normalise a path (Windows backslashes → forward slashes) for the parsers. */
function norm(p) {
  return String(p).replace(/\\/g, "/").replace(/\/+/g, "/");
}

/** Any path segment that marks a folder we never surface (dot-dirs, vendored deps). */
function isExcludedDir(directory) {
  return directory
    .split("/")
    .some((segment) => (segment.startsWith(".") && segment !== "." && segment !== "..") || segment === "node_modules");
}

const SCRIPT_BASENAMES = ["start.ps1", "start.cmd", "start.bat", "start.sh"];
const STOP_BASENAMES = ["stop.ps1", "stop.cmd", "stop.bat", "stop.sh"];
const baseNameOf = (p) => p.toLowerCase().slice(p.lastIndexOf("/") + 1);

/**
 * Map the start/stop listing output to scripted candidates. Accepts either
 * forward or backslash separators. Dedupes by directory and drops dot-dir and
 * node_modules hits. The stop script name mirrors the discovered start script's
 * extension so a .ps1 launcher pairs with a .ps1 stopper. Exported for tests.
 */
export function mapScriptedFindOutput(startsOutput, stopsOutput = "", windows = false) {
  const startLines = String(startsOutput ?? "").split("\n").map(norm).map((l) => l.trim()).filter(Boolean);
  const stopLines = String(stopsOutput ?? "").split("\n").map(norm).map((l) => l.trim()).filter(Boolean);
  const stopBaseByDir = new Map();
  for (const line of stopLines) {
    const dir = line.slice(0, line.lastIndexOf("/"));
    const base = baseNameOf(line);
    const stopName = STOP_BASENAMES.find((n) => base === n);
    if (dir && stopName && !stopBaseByDir.has(dir)) stopBaseByDir.set(dir, stopName);
  }
  const byDir = new Map();
  for (const hit of startLines) {
    const startBase = SCRIPT_BASENAMES.find((n) => baseNameOf(hit) === n) || "start.sh";
    const directory = hit.slice(0, hit.lastIndexOf("/"));
    if (!directory || directory === "/" || isExcludedDir(directory)) continue;
    if (byDir.has(directory)) continue;
    const name = directory.split("/").filter(Boolean).pop();
    if (!name) continue;
    byDir.set(directory, {
      kind: "scripted",
      name,
      directory: windows ? directory.replace(/\//g, "\\") : directory,
      startScript: startBase,
      stopScript: stopBaseByDir.get(directory) || null,
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
export function parseHfCacheListing(output, windows = false) {
  const out = [];
  for (const rawLine of String(output ?? "").split("\n")) {
    const entry = rawLine.trim();
    if (!entry) continue;
    const name = hfNameFromDirEntry(entry);
    if (!name) continue;
    out.push({ kind: "huggingface", name, directory: windows ? `${HF_HUB_DIR.replace(/\//g, "\\")}\\${entry}` : `${HF_HUB_DIR}/${entry}` });
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
 * @param {boolean} [opts.windows] build & parse for the Windows host.
 * @param {string} [opts.sshUser] the host user (POSIX only); validated, never spliced in.
 * @param {string[]} [opts.roots] scan roots (server config only).
 * @param {number} [opts.timeoutMs] per-command cap.
 * @returns {Promise<{ candidates: object[], scannedRoots: string[], notes: string[] }>}
 */
export async function discoverModelCandidates({
  execHost,
  sshUser,
  roots = MODEL_DISCOVERY_ROOTS,
  timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS,
  windows = false,
} = {}) {
  if (typeof execHost !== "function") {
    throw new TypeError("discoverModelCandidates requires an execHost(cmd, timeoutMs) function");
  }
  // sshUser is only meaningful on a POSIX host; skip validation when absent.
  if (!windows && sshUser != null && sshUser !== "" && !isValidSshUser(sshUser)) {
    throw new Error("Invalid SSH user for model discovery (allowed: letters, digits, . _ -)");
  }

  const candidates = [];
  const scannedRoots = [];
  const notes = [];

  // ── a) scripted: folders with a start script under the configured roots ──
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
      const startsOutput = await execHost(buildFindStartsCommand(safeRoots, windows), timeoutMs);
      let stopsOutput = "";
      try {
        stopsOutput = await execHost(buildFindStopsCommand(safeRoots, windows), timeoutMs);
      } catch {
        // stop script presence is a nicety; a missing listing only means no stopScript.
      }
      candidates.push(...mapScriptedFindOutput(startsOutput, stopsOutput, windows));
    }
  } catch (err) {
    notes.push(noteFromError("scripted", err));
  }

  // ── b) ollama: only while the engine container runs ──
  try {
    const running = await execHost(buildOllamaRunningCommand(windows), timeoutMs).catch(() => "");
    if (String(running).trim() !== "") {
      const listOutput = await execHost(buildOllamaListCommand(windows), timeoutMs);
      candidates.push(...parseOllamaList(listOutput));
    }
    // Not running (or docker absent): omit silently — nothing to launch from there.
  } catch (err) {
    notes.push(noteFromError("ollama", err));
  }

  // ── c) huggingface: repos in the hub cache ──
  try {
    const hfOutput = await execHost(buildHfCacheCommand(windows), timeoutMs);
    candidates.push(...parseHfCacheListing(hfOutput, windows));
  } catch (err) {
    notes.push(noteFromError("huggingface", err));
  }

  return { candidates, scannedRoots, notes };
}
