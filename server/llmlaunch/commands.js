/**
 * Shell programs the dashboard runs on a Spark to start / stop a user-registered
 * LLM. Inputs are pre-validated (see validate.js), so they are embedded in single
 * quotes; the whole program is shipped base64-encoded, which sidesteps any
 * quoting differences between the remote login shell and ours.
 *
 * START runs the user's script DETACHED (setsid) with output going to a log file
 * on the Spark, then streams that file. Closing the browser, restarting
 * sparkDash or dropping SSH therefore never kills the model, and a later job can
 * re-attach to the same log. STOP runs the user's stop script attached.
 */

export const EXIT_MARKER = "__SDEXIT__";
export const LOG_DIR = '$HOME/.cache/sparkdash/llm';

function dirExpr(dir) {
  return dir.startsWith("~/") ? `"$HOME"/'${dir.slice(2)}'` : `'${dir}'`;
}

function wrap(program) {
  const b64 = Buffer.from(program, "utf8").toString("base64");
  return `bash -c "$(printf %s '${b64}' | base64 -d)"`;
}

const HELPERS = `
# Is anything from the detached start script still alive? setsid makes $PID the
# leader of its own process group, so the group outlives a wrapper that was killed
# while the model server it launched keeps running.
alive() { kill -0 -- "-$PID" 2>/dev/null || kill -0 "$PID" 2>/dev/null; }
follow() {  # $1: tail -n argument. Streams the log until the script group is gone.
  tail -n "$1" -F "$L" 2>/dev/null &
  T=$!
  while alive; do sleep 1; done
  sleep 0.6
  kill "$T" 2>/dev/null
  wait "$T" 2>/dev/null
}
`;

function paths(id) {
  return [
    `LD="${LOG_DIR}"; mkdir -p "$LD" || exit 1`,
    `L="$LD/${id}.log"; X="$LD/${id}.exit"; P="$LD/${id}.pid"`,
    `PID=$(cat "$P" 2>/dev/null || echo 0)`,
    HELPERS,
  ].join("\n");
}

export function buildStartCommand({ id, dir, script }) {
  const program = `
${paths(id)}
ATTACH=
if [ "$PID" != 0 ] && alive; then
  echo "[sparkdash] already running (pid $PID); showing its output"
  ATTACH=1
fi
if [ -z "$ATTACH" ]; then
  cd ${dirExpr(dir)} 2>/dev/null || { echo "[sparkdash] cannot open directory ${dir}"; echo "${EXIT_MARKER}127"; exit 0; }
  [ -f './${script}' ] || { echo "[sparkdash] ${script} not found in ${dir}"; echo "${EXIT_MARKER}127"; exit 0; }
  rm -f "$X"; : > "$L"
  echo "[sparkdash] starting ${dir}/${script} as $(id -un)" >> "$L"
  setsid bash -c 'if [ -x "./$1" ]; then "./$1"; else bash "./$1"; fi; echo $? > "$2"' _ '${script}' "$X" >> "$L" 2>&1 < /dev/null &
  PID=$!
  echo "$PID" > "$P"
  FROM="+1"
else
  FROM="500"
fi
follow "$FROM"
echo "${EXIT_MARKER}$(cat "$X" 2>/dev/null || echo -1)"
`;
  return wrap(program);
}

/** Show the log of an already-running start script (or the last run's log). */
export function buildAttachCommand({ id }) {
  const program = `
${paths(id)}
if [ ! -f "$L" ]; then echo "[sparkdash] no output recorded yet for this model"; echo "${EXIT_MARKER}-1"; exit 0; fi
if [ "$PID" != 0 ] && alive; then
  follow 500
else
  tail -n 500 "$L"
fi
echo "${EXIT_MARKER}$(cat "$X" 2>/dev/null || echo -1)"
`;
  return wrap(program);
}

export function buildStopCommand({ dir, script }) {
  const program = `
cd ${dirExpr(dir)} 2>/dev/null || { echo "[sparkdash] cannot open directory ${dir}"; echo "${EXIT_MARKER}127"; exit 0; }
[ -f './${script}' ] || { echo "[sparkdash] ${script} not found in ${dir}"; echo "${EXIT_MARKER}127"; exit 0; }
echo "[sparkdash] running ${dir}/${script} as $(id -un)"
if [ -x './${script}' ]; then './${script}'; else bash './${script}'; fi
echo "${EXIT_MARKER}$?"
`;
  return wrap(program);
}

/** One line per launcher id: "<id> RUNNING|STOPPED". */
export function buildStatusCommand(ids) {
  const body = ids
    .map(
      (id) =>
        `PID=$(cat "$HOME/.cache/sparkdash/llm/${id}.pid" 2>/dev/null || echo 0); if [ "$PID" != 0 ] && { kill -0 -- "-$PID" 2>/dev/null || kill -0 "$PID" 2>/dev/null; }; then echo "${id} RUNNING"; else echo "${id} STOPPED"; fi`
    )
    .join("\n");
  return wrap(body || "true");
}

