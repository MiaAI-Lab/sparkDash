/**
 * Programs sparkDash runs on a Spark for Tool Eval. Same approach as the model launchers
 * (llmlaunch/commands.js): the program is shipped base64-encoded so no quoting layer can
 * mangle it, and a benchmark run is DETACHED (setsid) with its output going to files under
 * ~/.cache/sparkdash/tooleval/<runId>/, so closing the browser or restarting sparkDash
 * never kills a long run, and the output can be re-attached later.
 *
 * Arguments reach the tool as a NUL-delimited, base64 list (argv, no shell). Secrets (API
 * key, header values) arrive on STDIN as `NAME=base64` lines and are exported only inside
 * the program, so they never appear on any command line.
 */

export const TE_EXIT = "__TEEXIT__";
export const RUN_ROOT = "$HOME/.cache/sparkdash/tooleval";
export const WORK_DIR = "$HOME/.local/share/sparkdash/tool-eval";
/** Where the tool is expected (uv tool install puts it in ~/.local/bin). */
const PATH_LINE = 'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"';

export function runDirRef(runId) {
  return `~/.cache/sparkdash/tooleval/${runId}`;
}

function wrap(program) {
  const b64 = Buffer.from(program, "utf8").toString("base64");
  return `bash -c "$(printf %s '${b64}' | base64 -d)"`;
}

/** Secrets arrive as `NAME=base64(value)` lines on stdin; a blank line ends the block. */
const READ_SECRETS = `
while IFS= read -r line; do
  [ -z "$line" ] && break
  k=\${line%%=*}; v=\${line#*=}
  case "$k" in TOOL_EVAL_API_KEY|TOOL_EVAL_HEADERS) export "$k=$(printf %s "$v" | base64 -d)";; esac
done
`;

/** stdin payload for a program that starts with READ_SECRETS. */
export function secretsPayload(env) {
  const lines = Object.entries(env || {})
    .filter(([k]) => k === "TOOL_EVAL_API_KEY" || k === "TOOL_EVAL_HEADERS")
    .map(([k, v]) => `${k}=${Buffer.from(String(v), "utf8").toString("base64")}`);
  return `${lines.join("\n")}\n\n`;
}

const HELPERS = `
alive() { kill -0 -- "-$PID" 2>/dev/null || kill -0 "$PID" 2>/dev/null; }
# Follow events (stderr JSONL) and output together; tail prints a "==> file <==" header whenever the source changes.
follow() {
  tail -n "$1" -F "$E" "$L" 2>/dev/null &
  T=$!
  while alive; do sleep 1; done
  sleep 1
  kill "$T" 2>/dev/null
  wait "$T" 2>/dev/null
}
`;

function dirs(runId) {
  return `
RD="${RUN_ROOT}/${runId}"; WD="${WORK_DIR}"
mkdir -p "$RD" "$WD" || exit 1
L="$RD/stdout.log"; E="$RD/events.jsonl"; R="$RD/result.json"; X="$RD/exit"; P="$RD/pid"
PID=$(cat "$P" 2>/dev/null || echo 0)
`;
}

/** Start a run (detached) and follow it. `argvB64` is the NUL-joined argument list, base64. */
export function buildRunProgram({ runId, argvB64, displayLine }) {
  const displayB64 = Buffer.from(displayLine, "utf8").toString("base64");
  return wrap(`
${READ_SECRETS}
${PATH_LINE}
${dirs(runId)}
${HELPERS}
BIN=$(command -v tool-eval-bench) || { echo "[sparkdash] tool-eval-bench is not installed on this Spark. Use Set up on the Tool Eval page to install it."; echo "${TE_EXIT}127"; exit 0; }
if [ "$PID" != 0 ] && alive; then echo "[sparkdash] this run is already running"; echo "${TE_EXIT}-1"; exit 0; fi
mapfile -d '' -t ARGS < <(printf %s '${argvB64}' | base64 -d)
for i in "\${!ARGS[@]}"; do case "\${ARGS[$i]}" in "~/"*) ARGS[$i]="$HOME/\${ARGS[$i]#\\~/}";; esac; done
cd "$WD" || exit 1
rm -f "$X" "$R"; : > "$L"; : > "$E"
printf '[sparkdash] %s\\n' "$(printf %s '${displayB64}' | base64 -d)" >> "$L"
setsid bash -c 'X="$1"; shift; "$@"; echo $? > "$X"' _ "$X" "$BIN" "\${ARGS[@]}" >> "$L" 2>> "$E" < /dev/null &
PID=$!
echo "$PID" > "$P"
follow "+1"
echo "${TE_EXIT}$(cat "$X" 2>/dev/null || echo -1)"
`);
}

/** Re-open the output of a run that is running (or finished). */
export function buildAttachProgram({ runId }) {
  return wrap(`
${dirs(runId)}
${HELPERS}
[ -f "$L" ] || { echo "[sparkdash] no output was recorded for this run on the Spark"; echo "${TE_EXIT}-1"; exit 0; }
if [ "$PID" != 0 ] && alive; then follow "+1"; else tail -n +1 "$E" "$L" 2>/dev/null; fi
echo "${TE_EXIT}$(cat "$X" 2>/dev/null || echo -1)"
`);
}

/** Ask a running benchmark to stop: TERM its process group, KILL after a grace period. */
export function buildStopProgram({ runId }) {
  return wrap(`
${dirs(runId)}
${HELPERS}
# A run that was only just started may not have written its pid yet: give it a moment before concluding "not running".
for i in 1 2 3 4 5 6 7 8 9 10; do [ -f "$P" ] || [ -f "$X" ] && break; sleep 0.5; done
PID=$(cat "$P" 2>/dev/null || echo 0)
if [ "$PID" = 0 ] || ! alive; then echo "not running"; exit 0; fi
kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null
for i in 1 2 3 4 5 6 7 8; do alive || break; sleep 1; done
if alive; then kill -KILL -- "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null; echo "killed"; else echo "stopped"; fi
`);
}

/** One-shot (non-detached) tool call with argv from the same encoding, e.g. --probe / --dry-run / --version. */
export function buildOnceProgram({ argvB64, wantStdin = false }) {
  return wrap(`
${wantStdin ? READ_SECRETS : ""}
${PATH_LINE}
BIN=$(command -v tool-eval-bench) || { echo "tool-eval-bench is not installed"; echo "${TE_EXIT}127"; exit 0; }
mapfile -d '' -t ARGS < <(printf %s '${argvB64}' | base64 -d)
for i in "\${!ARGS[@]}"; do case "\${ARGS[$i]}" in "~/"*) ARGS[$i]="$HOME/\${ARGS[$i]#\\~/}";; esac; done
mkdir -p "${WORK_DIR}" && cd "${WORK_DIR}" || exit 1
timeout 90 "$BIN" "\${ARGS[@]}" 2>&1 < /dev/null
echo "${TE_EXIT}$?"
`);
}

/** Is the tool installed, which version, and what could install it? Key=value lines. */
export function buildStatusProgram() {
  return wrap(`
${PATH_LINE}
BIN=$(command -v tool-eval-bench); echo "BIN=\${BIN:-}"
if [ -n "$BIN" ]; then echo "VERSION=$(timeout 20 "$BIN" --version 2>&1 | head -n 1)"; fi
echo "UV=$(command -v uv || true)"
echo "PYTHON=$(command -v python3 || true)"
if command -v python3 >/dev/null 2>&1; then echo "PYTHON_VERSION=$(python3 --version 2>&1)"; fi
echo "WORKDIR=${WORK_DIR}"
`);
}

export const INSTALL_SOURCE = "git+https://github.com/SeraphimSerapis/tool-eval-bench.git";
export const ALLOWED_EXTRAS = ["perf", "hf"];

/** The install / upgrade command line, shown to the user before they confirm. */
export function installCommandLine({ extras = [], upgrade = false } = {}) {
  const ex = extras.filter((e) => ALLOWED_EXTRAS.includes(e));
  if (upgrade) return "uv tool upgrade tool-eval-bench";
  const target = ex.length ? `tool-eval-bench[${ex.join(",")}] @ ${INSTALL_SOURCE}` : INSTALL_SOURCE;
  return `uv tool install --force "${target}"`;
}

export function buildInstallProgram({ extras = [], upgrade = false } = {}) {
  const cmd = installCommandLine({ extras, upgrade });
  return wrap(`
${PATH_LINE}
command -v uv >/dev/null 2>&1 || { echo "[sparkdash] uv is not installed on this Spark."; echo "[sparkdash] Install it first (https://docs.astral.sh/uv/), then retry."; echo "${TE_EXIT}127"; exit 0; }
echo "[sparkdash] $ ${cmd.replace(/"/g, '\\"')}"
${cmd} 2>&1 < /dev/null
echo "${TE_EXIT}$?"
`);
}

/** Print the result file (size-guarded) so the server can read it. */
export function buildReadResultProgram({ runId, maxBytes = 30 * 1024 * 1024 }) {
  return wrap(`
R="${RUN_ROOT}/${runId}/result.json"
[ -f "$R" ] || { echo "__NORESULT__"; exit 0; }
SZ=$(wc -c < "$R")
[ "$SZ" -le ${maxBytes} ] || { echo "__TOOBIG__$SZ"; exit 0; }
cat "$R"
`);
}

export function buildDeleteRunProgram({ runId }) {
  return wrap(`rm -rf "${RUN_ROOT}/${runId}"; echo ok`);
}

/** Is a run still alive, and how did it end? Prints ALIVE or EXIT=<code> (or GONE). */
export function buildCheckProgram({ runId }) {
  return wrap(`
${dirs(runId)}
${HELPERS}
[ -d "$RD" ] || { echo GONE; exit 0; }
if [ "$PID" != 0 ] && alive; then echo ALIVE; else echo "EXIT=$(cat "$X" 2>/dev/null || echo -1)"; fi
`);
}
