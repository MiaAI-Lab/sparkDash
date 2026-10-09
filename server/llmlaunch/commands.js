/**
 * Shell programs the dashboard runs on a Spark to start / stop a user-registered
 * LLM. Inputs are pre-validated (see validate.js), so they are embedded in single
 * quotes; the whole program is shipped base64-encoded, which sidesteps any
 * quoting differences between the remote login shell and ours.
 *
 * START runs the user's script DETACHED (setsid) with output going to a log file
 * on the Spark, then streams that file. Closing the browser, restarting
 * sparkDash or dropping SSH therefore never kills the model, and a later job can
 * re-attach to the same log. STOP runs the user's stop script attached (and kills
 * it if the controlling connection disappears).
 *
 * Safety checks run on the Spark before anything executes: the directory must
 * resolve inside the user's home and not be world-writable, and the script must
 * be a regular, non-symlink file owned by the user and not world-writable.
 *
 * Protocol: the final line of a job is `__SDEXIT__<nonce>:<code>` where the nonce
 * is random per job, so script output can not forge the end of a job.
 */

export const EXIT_MARKER = "__SDEXIT__";
export const LOG_DIR = '$HOME/.cache/sparkdash/llm';
export const LOG_MAX_BYTES = 32 * 1024 * 1024;
export const LOG_KEEP_BYTES = 8 * 1024 * 1024;

const NONCE_RE = /^[0-9a-f]{8,64}$/;

/** The line prefix that carries the exit code of a job. */
export function exitPrefix(nonce) {
  return `${EXIT_MARKER}${nonce}:`;
}

function assertNonce(nonce) {
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) throw new Error("invalid job nonce");
}

function dirExpr(dir) {
  return dir.startsWith("~/") ? `"$HOME"/'${dir.slice(2)}'` : `'${dir}'`;
}

function wrap(program) {
  const b64 = Buffer.from(program, "utf8").toString("base64");
  return `bash -c "$(printf %s '${b64}' | base64 -d)"`;
}

function markerFn(nonce) {
  // Leading newline: guarantees the marker starts a line even when the log ended mid-line.
  return `mark() { printf '\\n%s%s:%s\\n' '${EXIT_MARKER}' '${nonce}' "$1"; }`;
}

const HELPERS = `
# Start time (clock ticks since boot) of a pid: guards against pid reuse.
pstart() { sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }
ppidof() { sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f2; }
# pid file holds "<pid> <starttime>" of the setsid leader.
loadpid() {
  PID=0; PST=
  { read -r PID PST < "$P"; } 2>/dev/null
  case "$PID" in ''|*[!0-9]*) PID=0; PST= ;; esac
}
# Is anything from the detached start script still alive? setsid makes $PID the leader of
# its own process group, so the group outlives a wrapper that was killed while the model
# server it launched keeps running. While the leader pid exists its start time must match
# the recorded one (a reused pid is not ours); once it is gone only the group counts (the
# kernel never hands out a pid that is still a live group id).
alive() {
  [ "\${PID:-0}" != 0 ] || return 1
  if [ -d "/proc/$PID" ]; then
    [ -z "$PST" ] && { kill -0 -- "-$PID" 2>/dev/null || kill -0 "$PID" 2>/dev/null; return; }
    [ "$(pstart "$PID")" = "$PST" ]
    return
  fi
  kill -0 -- "-$PID" 2>/dev/null
}
# $1: tail -n argument. Streams the log until the script group is gone, or until the
# process that started us (sshd / the dashboard) goes away, so an abandoned job never
# leaves a follow loop behind.
follow() {
  P0=$(ppidof $$)
  tail -n "$1" -F "$L" 2>/dev/null &
  T=$!
  trap 'kill "$T" 2>/dev/null' EXIT
  GONE=
  while alive; do
    if [ "$(ppidof $$)" != "$P0" ]; then GONE=1; break; fi
    kill -0 "$T" 2>/dev/null || break
    sleep 1
  done
  if [ -n "$GONE" ]; then kill "$T" 2>/dev/null; exit 0; fi
  sleep 0.6
  kill "$T" 2>/dev/null
  wait "$T" 2>/dev/null
  alive || rm -f "$P"
}
# World-writable? (also true when the mode cannot be read)
wwrite() { m=$(stat -c %a -- "$1" 2>/dev/null) || return 0; [ $(( 8#\${m: -1} & 2 )) -ne 0 ]; }
# Run inside the launcher directory. $1: script file name.
check_script() {
  H=$(cd "$HOME" 2>/dev/null && pwd -P) || { echo "[sparkdash] cannot resolve the home directory"; return 1; }
  D=$(pwd -P)
  case "$D/" in "$H"/*) ;; *) echo "[sparkdash] refusing: $D is not inside $H"; return 1 ;; esac
  if wwrite .; then echo "[sparkdash] refusing: directory $D is world-writable"; return 1; fi
  if [ ! -f "./$1" ] || [ -L "./$1" ]; then echo "[sparkdash] $1 not found in $D (must be a regular file)"; return 2; fi
  [ "$(stat -c %u -- "./$1" 2>/dev/null)" = "$(id -u)" ] || { echo "[sparkdash] refusing: $1 is not owned by $(id -un)"; return 1; }
  if wwrite "./$1"; then echo "[sparkdash] refusing: $1 is world-writable"; return 1; fi
  return 0
}
`;

function paths(id, nonce) {
  return [
    `LD="${LOG_DIR}"; mkdir -p "$LD" || exit 1`,
    `L="$LD/${id}.log"; X="$LD/${id}.exit"; P="$LD/${id}.pid"`,
    markerFn(nonce),
    HELPERS,
    "loadpid",
  ].join("\n");
}

// Runs as the detached wrapper: janitor that keeps the log bounded, then the script.
const WRAPPER = `
W=$$
[ -p "$4" ] || mkfifo "$4" 2>/dev/null
(
  while kill -0 $W 2>/dev/null; do
    read -t 15 <>"$4"
    s=$(stat -c %s -- "$3" 2>/dev/null || echo 0)
    if [ "$s" -gt ${LOG_MAX_BYTES} ]; then
      tail -c ${LOG_KEEP_BYTES} "$3" > "$3.cut" && cat "$3.cut" > "$3"
      rm -f "$3.cut"
    fi
  done
) &
J=$!
if [ -x "./$1" ]; then "./$1"; else bash "./$1"; fi
echo $? > "$2"
kill $J 2>/dev/null
rm -f "$4"
`;

export function buildStartCommand({ id, dir, script, nonce }) {
  assertNonce(nonce);
  const program = `
${paths(id, nonce)}
cd ${dirExpr(dir)} 2>/dev/null || { echo "[sparkdash] cannot open directory ${dir}"; mark 127; exit 0; }
check_script '${script}'; RC=$?
if [ $RC -ne 0 ]; then [ $RC -eq 2 ] && RC=127 || RC=126; mark $RC; exit 0; fi
WRAP=$(cat <<'SDWRAP_EOF'
${WRAPPER}
SDWRAP_EOF
)
ATTACH=
# Serialize "alive? else launch" so two starts can never both launch. The launch section
# survives the watching ssh going away (HUP/PIPE caught, not ignored: handlers reset on exec).
exec 9>"$LD/${id}.lock"
if command -v flock >/dev/null 2>&1; then
  flock -w 30 9 || { echo "[sparkdash] another start for this model is in progress; try again"; mark 1; exit 0; }
fi
trap : HUP PIPE
loadpid
if alive; then
  echo "[sparkdash] already running (pid $PID); not starting a second copy. Showing its output"
  ATTACH=1
else
  rm -f "$X" "$P"; : > "$L"
  echo "[sparkdash] starting ${dir}/${script} as $(id -un)" >> "$L"
  setsid bash -c "$WRAP" _ '${script}' "$X" "$L" "$LD/${id}.fifo" >> "$L" 2>&1 < /dev/null 9>&- &
  PID=$!
  PST=$(pstart "$PID")
  echo "$PID $PST" > "$P"
fi
exec 9>&-
trap - HUP PIPE
if [ -z "$ATTACH" ]; then FROM="+1"; else FROM="500"; fi
follow "$FROM"
C=$(cat "$X" 2>/dev/null); case "$C" in ''|*[!0-9]*) C=-1 ;; esac
mark "$C"
`;
  return wrap(program);
}

/** Show the log of an already-running start script (or the last run's log). */
export function buildAttachCommand({ id, nonce }) {
  assertNonce(nonce);
  const program = `
${paths(id, nonce)}
if [ ! -f "$L" ]; then echo "[sparkdash] no output recorded yet for this model"; mark -1; exit 0; fi
if alive; then
  follow 500
else
  tail -n 500 "$L"
fi
C=$(cat "$X" 2>/dev/null); case "$C" in ''|*[!0-9]*) C=-1 ;; esac
mark "$C"
`;
  return wrap(program);
}

export function buildStopCommand({ dir, script, nonce }) {
  assertNonce(nonce);
  const program = `
${markerFn(nonce)}
${HELPERS}
cd ${dirExpr(dir)} 2>/dev/null || { echo "[sparkdash] cannot open directory ${dir}"; mark 127; exit 0; }
check_script '${script}'; RC=$?
if [ $RC -ne 0 ]; then [ $RC -eq 2 ] && RC=127 || RC=126; mark $RC; exit 0; fi
echo "[sparkdash] running ${dir}/${script} as $(id -un)"
P0=$(ppidof $$)
setsid bash -c 'if [ -x "./$1" ]; then "./$1"; else bash "./$1"; fi' _ '${script}' < /dev/null &
SP=$!
while kill -0 "$SP" 2>/dev/null; do
  if [ "$(ppidof $$)" != "$P0" ]; then
    # The controlling connection is gone (cancelled / timed out): do not leave stop.sh running.
    kill -TERM -- "-$SP" 2>/dev/null; sleep 3; kill -KILL -- "-$SP" 2>/dev/null
    exit 0
  fi
  sleep 0.5
done
wait "$SP"; RC=$?
mark "$RC"
`;
  return wrap(program);
}

/** One line per launcher id: "<id> RUNNING|STOPPED". */
export function buildStatusCommand(ids) {
  const body = ids
    .map(
      (id) =>
        `P="$HOME/.cache/sparkdash/llm/${id}.pid"; loadpid; if alive; then echo "${id} RUNNING"; else echo "${id} STOPPED"; fi`
    )
    .join("\n");
  return wrap(`${HELPERS}\n${body || "true"}`);
}
