/**
 * On-unit programs for the GPU clock cap (the sparkLimiter behaviour):
 * `nvidia-smi -lgc MIN,MAX`, optionally kept across reboots — by the oneshot
 * systemd service where sudo reaches a root shell, otherwise by an `@reboot`
 * line in the SSH user's own crontab that runs the same command through the same
 * narrow sudo rule — and a marker (`/run/sparkdash/gpu-clock-cap` as root, else
 * the user's `~/.config/sparkdash/gpu-clock-cap`) so the dashboard can show the
 * current cap (NVML cannot read an -lgc lock back).
 *
 * Every program is a POSIX sh script. The only values interpolated into it are
 * integers that this module validates itself plus fixed paths; nothing from a
 * request or from the unit ever reaches a shell as text. Privilege: root runs
 * it directly (the local unit, through the host mount namespace), anyone else
 * uses `sudo -n` and fails with a clear code when sudo wants a password.
 *
 * Programs always exit 0 and report on stdout as `KEY=value` lines
 * (`RESULT=ok|error`, `CODE`, `MSG`, plus the status fields), so an ssh failure
 * and a refused action can be told apart.
 */

export const GPU_CLOCK_SERVICE = "spark-gpu-clock-limit";
/** Same name sparkLimiter uses, so the two tools manage the same unit. */
export const UNIT_NAME = `${GPU_CLOCK_SERVICE}.service`;
export const MARKER_FILE = "gpu-clock-cap";
/** Marker on the @reboot crontab line: an install replaces its own, a drop removes exactly it. */
export const CRON_TAG = "sparkdash-gpu-clock-cap";

/**
 * The `@reboot` crontab line used where sudo cannot reach a root shell. It
 * applies the cap at boot through the narrow rule the cap itself uses, so keeping
 * it needs no privilege capping does not already have, and refreshes the marker,
 * because a boot invalidates it. It tries three times; when every attempt fails it
 * writes the boot id to a failure marker (and tries `logger`), which the status
 * program reports, so a boot that did not re-apply the cap is not silent.
 * The job sleeps before each attempt, and an Apply or Remove made meanwhile does
 * not stop it: so it carries a token unique to this install (`J=`) and checks
 * that its own line is still in the crontab before capping and before writing
 * either marker. A dropped or replaced line (even one with the same cap) means
 * it was superseded and it exits touching nothing. A crontab it cannot read
 * proves nothing either way, so that attempt fails without touching the GPU or a
 * marker, and if no attempt could confirm the job it logs that the crontab could
 * not be read instead of writing the failure marker (the status reports an
 * unreadable crontab by itself).
 * The check alone would still race an Apply or Remove that lands between it and
 * the cap, so each attempt takes the same lock (`flock` on the user's
 * `gpu-clock-cap.lock`) Apply and Remove hold for their whole run: check, cap
 * and marker happen together, the sleep happens outside it. The wait for the
 * lock is bounded; an attempt that cannot get it (or finds no `flock`) counts as
 * failed. The failure marker is written under the lock too; if the lock cannot
 * be acquired, only the logger entry is written, never an unprotected marker.
 * Placeholders are filled by the program from paths it resolved on the unit and
 * checked with `safe_path`; `$(...)` runs at boot, not at install time.
 * No `%` may appear: crontab would read one as a newline.
 */
function cronLine({ minMHz, maxMHz }) {
  // Debian cron limits the command field to 998 bytes. Share the marker path,
  // ownership/lock check and logger so retry/failure handling stays below it.
  // Inside the lock: 3 = superseded, 4 = no lock, 5 = crontab unreadable, 1 = refused.
  return `${[
    `@reboot J=@@JOB@@; C=@@CRON@@; D="@@ALT_DIR@@"; B=@@BOOTID@@; F=@@FLOCK@@; M="$D/${MARKER_FILE}";`,
    `take() { $F -w 120 9 || exit 4; L=$($C -l 2>&1);`,
    `case $?:"$L" in 0:*"@reboot J=$J; "*) ;; 0:*|*:*"no crontab for"*) exit 3 ;; *) exit 5 ;; esac; };`,
    `log() { logger -t sparkdash "GPU clock cap ${maxMHz} MHz was not applied at boot$1"; };`,
    `for i in 1 2 3; do /bin/sleep 20; /bin/mkdir -p "$D";`,
    `( take; @@SUDO@@ -n @@NV@@ -lgc ${minMHz},${maxMHz} || exit 1;`,
    `echo "${maxMHz} $(/bin/cat $B)" > "$M" && /bin/rm -f "$M.failed" ) 9>>"$M.lock";`,
    `case $? in 0|3) exit 0 ;; esac;`,
    "done;",
    `( take; /bin/cat $B > "$M.failed" || exit 6 ) 9>>"$M.lock"; r=$?;`,
    `case $r in 3) ;; 0|6) log ;; 5) log ": the crontab could not be read" ;;`,
    `*) log ": the change lock could not be taken" ;; esac;`,
    `# ${CRON_TAG}`,
  ].join(" ")}\n`;
}

/** Lowest cap accepted: below this the GPU is barely usable and the box looks hung. */
export const MIN_CAP_MHZ = 300;
export const MAX_CAP_MHZ = 10000;

/** root-owned locations only: never PATH, because the path ends up in a root-run unit. */
const NVSMI_CANDIDATES = ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi", "/bin/nvidia-smi"];
/** util-linux `flock`, which serialises Apply, Remove and the @reboot job (see cronLine). */
const FLOCK_CANDIDATES = ["/usr/bin/flock", "/bin/flock"];
const SAFE_PATH = /^\/[A-Za-z0-9_./-]*$/;

const DEFAULT_PATHS = Object.freeze({
  unitDir: "/etc/systemd/system",
  // Root-owned, like sparkLimiter's. When only the nvidia-smi commands are
  // permitted through sudo the marker falls back to the SSH user's own
  // ~/.config/sparkdash, which the status program also reads.
  runDir: "/run/sparkdash",
  bootIdFile: "/proc/sys/kernel/random/boot_id",
  systemdRunDir: "/run/systemd/system",
  nvsmi: NVSMI_CANDIDATES,
  flock: FLOCK_CANDIDATES,
  systemctl: "systemctl",
  // true = the script is run by a person in a terminal on the unit: plain `sudo` (asks for the
  // password), readable output, non-zero exit on failure.
  manual: false,
  // true = a sudo password arrives in $SPARKDASH_SUDO_PW (set by the runner from stdin) and
  // every privileged step pipes it to `sudo -S`; it is never put in an argument list.
  password: false,
  // Test sandbox only: run unprivileged against fake binaries and a temp tree.
  sandbox: false,
  // Test sandbox only: a fake `sudo -n` (absolute path) standing in for a unit
  // whose only passwordless rule is the narrow nvidia-smi one. Empty = sandbox root.
  sandboxSudo: "",
});

/** Paths come from code only (tests point them at a sandbox); still refuse anything odd. */
export function resolvePaths(overrides = {}) {
  const p = { ...DEFAULT_PATHS, ...overrides };
  const list = [p.unitDir, p.runDir, p.bootIdFile, p.systemdRunDir, ...p.nvsmi, ...p.flock];
  if (p.systemctl !== "systemctl") list.push(p.systemctl);
  if (p.sandboxSudo) list.push(p.sandboxSudo);
  for (const v of list) {
    if (typeof v !== "string" || !SAFE_PATH.test(v) || v.includes("..")) {
      throw new Error("unsafe path in GPU clock program");
    }
  }
  return p;
}

/**
 * A sudo password typed in the dashboard. It is only ever sent on stdin. Returns the
 * string, or null when none was given; throws 400 for anything that is not a plain line.
 * @param {unknown} v
 * @returns {string | null}
 */
export function parseSudoPassword(v) {
  if (v === undefined || v === null || v === "") return null;
  // eslint-disable-next-line no-control-regex
  if (typeof v !== "string" || v.length > 256 || /[\r\n\u0000]/.test(v)) {
    throw Object.assign(new Error("sudoPassword must be a single line of at most 256 characters"), { status: 400 });
  }
  return v;
}

/**
 * Validate a cap request. Returns normalized integers or throws an Error with `status` 400.
 * @param {unknown} body
 * @returns {{ minMHz: number, maxMHz: number, persist: boolean }}
 */
export function parseCapRequest(body) {
  const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const maxMHz = b.maxMHz;
  const minMHz = b.minMHz ?? 0;
  if (!Number.isInteger(maxMHz) || maxMHz < MIN_CAP_MHZ || maxMHz > MAX_CAP_MHZ) {
    throw fail(`maxMHz must be a whole number from ${MIN_CAP_MHZ} to ${MAX_CAP_MHZ}`);
  }
  if (!Number.isInteger(minMHz) || minMHz < 0 || minMHz > maxMHz) {
    throw fail("minMHz must be a whole number from 0 up to maxMHz");
  }
  if (b.persist !== undefined && typeof b.persist !== "boolean") throw fail("persist must be true or false");
  return { minMHz, maxMHz, persist: b.persist === true };
}

/** The systemd unit. `$$` and `%%` are systemd's escapes for `$` and `%`. */
export function buildUnit({ minMHz, maxMHz, nvsmi = "/usr/bin/nvidia-smi", runDir = DEFAULT_PATHS.runDir, bootIdFile = DEFAULT_PATHS.bootIdFile }) {
  for (const n of [minMHz, maxMHz]) if (!Number.isInteger(n) || n < 0) throw new Error("bad clock value");
  const marker = `${runDir}/${MARKER_FILE}`;
  return [
    "[Unit]",
    `Description=Limit NVIDIA GPU graphics clock (${minMHz},${maxMHz} MHz), managed by sparkDash`,
    "After=nvidia-persistenced.service",
    "Wants=nvidia-persistenced.service",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `ExecStart=${nvsmi} -lgc ${minMHz},${maxMHz}`,
    `ExecStartPost=/bin/sh -c 'mkdir -p ${runDir} && echo ${maxMHz} $$(cat ${bootIdFile}) > ${marker}'`,
    `ExecStop=${nvsmi} -rgc`,
    `ExecStopPost=/bin/rm -f ${marker}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/**
 * The sudo gate: with a typed password a refusal means a wrong password; otherwise
 * passwordless sudo is missing (NOPASSWD: ALL, or a rule for the nvidia-smi commands).
 */
export function needSudoLine(paths) {
  if (!paths.password) {
    return 'need_sudo || fail no-sudo "passwordless sudo is required for the user that runs the change (NOPASSWD: ALL, or a rule for nvidia-smi -lgc and -rgc)"';
  }
  return [
    "need_sudo || { case \"$SUDO_ERR\" in",
    '  __missing__) fail no-sudo "sudo is not installed on this unit" ;;',
    '  "") fail bad-password "the sudo password was not accepted" ;;',
    '  *"incorrect password"*|*"Sorry, try again"*|*"password is required"*|*"Authentication failure"*) fail bad-password "the sudo password was not accepted" ;;',
    '  *) fail no-sudo "sudo refused the request: $(clean "$SUDO_ERR")" ;;',
    "esac; }",
  ].join("\n");
}

export function header(paths) {
  const nv = paths.nvsmi.map((c) => `"${c}"`).join(" ");
  const fl = paths.flock.map((c) => `"${c}"`).join(" ");
  return [
    "set -u",
    // Read the password into a plain shell variable and drop it from the environment first
    // thing, so nothing this script starts (not even `id`) inherits it.
    ...(paths.password
      ? [
          "PW=${SPARKDASH_SUDO_PW-}",
          "unset SPARKDASH_SUDO_PW",
          "spw_sudo() { printf '%s\\n' \"$PW\" | LC_ALL=C sudo -S -p '' \"$@\"; }",
        ]
      : []),
    'SUDO=""',
    paths.sandbox
      ? paths.sandboxSudo
        ? `SUDO="${paths.sandboxSudo}"`
        : ":"
      : `[ "$(id -u)" = 0 ] || SUDO="${paths.password ? "spw_sudo" : paths.manual ? "sudo" : "sudo -n"}"`,
    `SYSTEMCTL=${paths.systemctl}`,
    `OWNER="${paths.sandbox ? "" : "-o root -g root"}"`,
    `UNIT=${paths.unitDir}/${UNIT_NAME}`,
    `RUNDIR=${paths.runDir}`,
    `MARKER=${paths.runDir}/${MARKER_FILE}`,
    // The marker goes next to the systemd unit's own copy when sudo can run a
    // shell (root-owned, like sparkLimiter's). With only a narrow NOPASSWD rule
    // for the nvidia-smi commands it goes to the SSH user's config dir instead —
    // the dashboard reads both, and reset clears both.
    paths.sandbox ? `HOMEDIR=${paths.runDir}` : 'HOMEDIR="${HOME:-}"',
    paths.sandbox ? `ALT_DIR=${paths.runDir}` : 'ALT_DIR="$HOMEDIR/.config/sparkdash"',
    'ALT_MARKER="$ALT_DIR/gpu-clock-cap"',
    // Written by the @reboot job when every attempt to re-apply the cap failed; holds that boot's id.
    'ALT_FAIL="$ALT_DIR/gpu-clock-cap.failed"',
    `LOCKFILE="$ALT_DIR/${MARKER_FILE}.lock"`,
    `BOOTID_FILE=${paths.bootIdFile}`,
    "NV=''",
    `for c in ${nv}; do if [ -x "$c" ]; then NV="$c"; break; fi; done`,
    "FLOCK=''",
    `for c in ${fl}; do if [ -x "$c" ]; then FLOCK="$c"; break; fi; done`,
    paths.manual
      ? "fail() { printf 'Error: %s\\n' \"$2\" >&2; exit 1; }"
      : "fail() { printf 'RESULT=error\\nCODE=%s\\nMSG=%s\\n' \"$1\" \"$2\"; exit 0; }",
    'digits() { tr -dc 0-9; }',
    'clean() { printf "%s" "$1" | head -n 1 | tr -cd "A-Za-z0-9 .,:_()/-" | head -c 160; }',
    'hwmax() { "$NV" --query-gpu=clocks.max.gr --format=csv,noheader,nounits 2>/dev/null | head -n 1 | digits; }',
    'bootid() { tr -dc "0-9a-fA-F-" < "$BOOTID_FILE" 2>/dev/null | head -c 64; }',
    // Anything that ends up inside the crontab line must be a plain absolute path:
    // $HOME and the sudo path come from the unit, not from this module.
    'safe_path() { case "$1" in /*) ;; *) return 1 ;; esac; case "$1" in *[!A-Za-z0-9_./-]*|*..*) return 1 ;; esac; }',
    // Apply and Remove hold this lock for their whole run, and the @reboot job holds it
    // from its ownership check to its marker (see cronLine), so neither can undo the
    // other halfway. It lives in the user's own config dir, the same whether the
    // marker is root's or the user's. The kernel drops it when the program exits,
    // however it exits: no stale lock, no trap. The file is only ever opened, never
    // removed or rewritten.
    "take_lock() {",
    '  [ -n "$FLOCK" ] || fail lock-failed "flock (util-linux) was not found on this unit; it keeps a change from racing the @reboot job. Nothing was changed"',
    '  [ -n "$HOMEDIR" ] || fail lock-failed "the home directory is not set, so the change lock cannot be taken; nothing was changed"',
    '  mkdir -p "$ALT_DIR" 2>/dev/null; [ -f "$LOCKFILE" ] || touch "$LOCKFILE" 2>/dev/null',
    '  [ -f "$LOCKFILE" ] && [ -w "$LOCKFILE" ] || fail lock-failed "could not open the change lock ($LOCKFILE); nothing was changed"',
    '  exec 9>>"$LOCKFILE"',
    '  "$FLOCK" -w 30 9; LRC=$?',
    '  [ "$LRC" = 0 ] && return 0',
    '  [ "$LRC" = 1 ] && fail busy "another GPU clock change is still running on this unit; try again in a moment"',
    '  fail lock-failed "could not take the change lock ($LOCKFILE); nothing was changed"',
    "}",
    paths.password
      ? // Why a refusal happened matters: only a wrong password counts toward the lock.
        "need_sudo() { SUDO_ERR=''; [ -z \"$SUDO\" ] && return 0; command -v sudo >/dev/null 2>&1 || { SUDO_ERR=__missing__; return 1; }; SUDO_ERR=$(printf '%s\\n' \"$PW\" | LC_ALL=C sudo -k -S -p '' true 2>&1 >/dev/null) && return 0; return 1; }"
      : paths.manual
      ? 'need_sudo() { [ -z "$SUDO" ] && return 0; command -v sudo >/dev/null 2>&1 && sudo -v; }'
      : // Either NOPASSWD: ALL, or a rule naming the commands actually run — the
        // README's own example is the narrow one, so a least-privilege unit can cap.
        'need_sudo() { [ -z "$SUDO" ] && return 0; command -v sudo >/dev/null 2>&1 || return 1; $SUDO true >/dev/null 2>&1 || $SUDO -l "$NV" -lgc 0,2400 >/dev/null 2>&1; }',
    // Root powers beyond the nvidia-smi commands (`sudo sh -c`): the root-owned
    // marker needs them, and so does the boot service. `sudo -n true` is not
    // enough of a probe here — a narrow rule refuses `sh` but still allows `-lgc`.
    // With a typed password or plain `sudo` the same probe runs through $SUDO.
    'can_sudo_root() { [ -z "$SUDO" ] && return 0; $SUDO sh -c : >/dev/null 2>&1; }',
    // Every recorded cap a change may have to clear must be clearable before
    // anything changes: a marker left behind keeps the status reading a cap that
    // is no longer in force. One written as root (in the root-owned run dir, while
    // sudo still reached a root shell) is out of reach once sudo is narrowed to the
    // nvidia-smi commands, so then the change is refused with everything as it was.
    // $1 names the action for the message.
    'can_rm() { [ -e "$1" ] || [ -L "$1" ] || return 0; RD=${1%/*}; RD=${RD:-/}; [ -w "$RD" ] && [ -x "$RD" ]; }',
    'marker_preflight() {',
    '  for F in "$MARKER" "$ALT_MARKER" "$ALT_FAIL"; do',
    '    can_rm "$F" || can_sudo_root || fail marker-failed "the recorded cap ($F) cannot be removed by this user and sudo here cannot reach a root shell; nothing was changed. Remove it as root (sudo rm -f $F), then $1 again"',
    '  done',
    '}',
    // Keeping the cap without root: a @reboot line in the SSH user's own crontab,
    // offered only where cron is there to run it.
    `CRON_TAG="${CRON_TAG}"`,
    // Our line is the one that ENDS in the tag: a user line that merely mentions it is never read, dropped or rewritten.
    `CRON_RE='^@reboot .* # ${CRON_TAG}[[:space:]]*$'`,
    'CRONBIN=$(command -v crontab 2>/dev/null || true)',
    // The crontab is read once into CRON_TXT. A read that fails for any reason
    // other than "no crontab" is an error, never an empty crontab: writing back
    // an empty read would replace — or `crontab -r` would delete — every job the
    // user has.
    "CRON_TXT=''",
    'cron_load() {',
    "  CRON_TXT=''",
    '  [ -n "$CRONBIN" ] || return 0',
    '  CRON_TXT=$("$CRONBIN" -l 2>/dev/null) && return 0',
    "  CRON_TXT=''",
    '  case "$("$CRONBIN" -l 2>&1 >/dev/null)" in *"no crontab for"*) return 0 ;; esac',
    '  return 1',
    '}',
    `cron_text() { [ -z "$CRON_TXT" ] || printf '%s\\n' "$CRON_TXT"; }`,
    'cron_has() { cron_text | grep -q "$CRON_RE"; }',
    'cron_clocks() { cron_text | grep "$CRON_RE" | sed -n \'s/.*-lgc \\([0-9][0-9]*,[0-9][0-9]*\\).*/\\1/p\' | head -n 1; }',
    'can_cron() {',
    '  [ -n "$CRONBIN" ] || return 1',
    '  for u in cron.service crond.service; do',
    `    [ "$($SYSTEMCTL is-active "$u" 2>/dev/null)" = active ] && return 0`,
    '  done',
    '  return 1',
    '}',
    // Drops just our own line, leaving the user's other jobs alone.
    "drop_cron() {",
    '  [ -n "$CRONBIN" ] || return 0',
    '  cron_load || return 1',
    '  cron_has || { rm -f "$ALT_FAIL" 2>/dev/null; return 0; }',
    '  T=$(mktemp) || return 1',
    '  cron_text | grep -v "$CRON_RE" > "$T"',
    '  if [ -s "$T" ]; then',
    '    "$CRONBIN" "$T" >/dev/null 2>&1 || { rm -f "$T"; return 1; }',
    '  else',
    // It was the user's only job (the read above succeeded and held our tag):
    // an empty crontab file is not accepted everywhere.
    '    "$CRONBIN" -r >/dev/null 2>&1 || { rm -f "$T"; return 1; }',
    '  fi',
    '  rm -f "$T"',
    '  cron_load || return 1',
    '  ! cron_has && { rm -f "$ALT_FAIL" 2>/dev/null; true; }',
    '}',
    // Removes a previous service (a stale one would re-apply the old cap at boot).
    "drop_service() {",
    '  if [ -f "$UNIT" ]; then',
    `    $SUDO $SYSTEMCTL disable --now ${UNIT_NAME} >/dev/null 2>&1 || true`,
    '    $SUDO rm -f "$UNIT" || return 1',
    "    $SUDO $SYSTEMCTL daemon-reload >/dev/null 2>&1 || true",
    "  fi",
    "}",
  ];
}

/** Read-only: current cap, hardware maximum, sudo availability, what would keep
 * the cap across boots on this unit, and the state of both boot hooks. */
export function buildStatusProgram(overrides = {}) {
  const paths = resolvePaths(overrides);
  return [
    ...header(paths),
    '[ -n "$NV" ] || fail no-nvidia "nvidia-smi was not found on this unit"',
    "HW=$(hwmax)",
    'if [ "$(id -u)" = 0 ]; then S=root; elif need_sudo; then S=yes; else S=no; fi',
    // What keeping the cap across boots would use here: the systemd unit where
    // sudo reaches a root shell, the user's @reboot cron line where only the
    // narrow nvidia-smi rule does, nothing where neither is available. The
    // Settings row offers — and defaults — its "Keep after reboot" tick from this.
    `PK=none; if [ "$S" != no ]; then if can_sudo_root && [ -d ${paths.systemdRunDir} ]; then PK=unit; elif can_cron; then PK=cron; fi; fi`,
    // A fleet that had NOPASSWD: ALL and then narrowed it can carry both hooks,
    // so each one is reported on its own.
    "CI=0; CCLK=''; CF=0",
    'cron_load || fail cron-failed "could not read the crontab; boot-hook status is unknown"',
    'if cron_has; then CI=1; CCLK=$(cron_clocks); fi',
    // The @reboot job leaves the boot id behind when it could not re-apply the cap; a stale line alone is not "kept".
    'if [ "$CI" = 1 ] && [ -n "$(bootid)" ] && [ -r "$ALT_FAIL" ] && [ "$(tr -dc "0-9a-fA-F-" < "$ALT_FAIL" 2>/dev/null | head -c 64)" = "$(bootid)" ]; then CF=1; fi',
    "CAP=''",
    'read_marker() {',
    '  [ -r "$1" ] || return 0',
    '  read -r M B < "$1" || return 0',
    '  M=$(printf "%s" "${M:-}" | digits); B=$(printf "%s" "${B:-}" | tr -dc "0-9a-fA-F-")',
    '  if [ -n "$M" ] && [ "$B" = "$(bootid)" ]; then CAP=$M; fi',
    '}',
    'read_marker "$MARKER"',
    '[ -n "$CAP" ] || read_marker "$ALT_MARKER"',
    "INST=0; CLK=''; EN=''; ACT=''",
    'if [ -f "$UNIT" ]; then',
    "  INST=1",
    '  CLK=$(sed -n \'s/^ExecStart=.* -lgc \\([0-9][0-9]*,[0-9][0-9]*\\).*/\\1/p\' "$UNIT" | head -n 1 | tr -dc "0-9,")',
    `  EN=$($SYSTEMCTL is-enabled ${UNIT_NAME} 2>/dev/null | head -n 1 | tr -dc "a-z-")`,
    `  ACT=$($SYSTEMCTL is-active ${UNIT_NAME} 2>/dev/null | head -n 1 | tr -dc "a-z-")`,
    "fi",
    "printf 'RESULT=ok\\nHWMAX=%s\\nSUDO=%s\\nPERSIST_KIND=%s\\nCAP=%s\\nSVC_INSTALLED=%s\\nSVC_CLOCKS=%s\\nSVC_ENABLED=%s\\nSVC_ACTIVE=%s\\nCRON_INSTALLED=%s\\nCRON_CLOCKS=%s\\nCRON_FAILED=%s\\n' \"$HW\" \"$S\" \"$PK\" \"$CAP\" \"$INST\" \"$CLK\" \"$EN\" \"$ACT\" \"$CI\" \"$CCLK\" \"$CF\"",
    "exit 0",
    "",
  ].join("\n");
}

/** Apply a cap now; with `persist`, also install the boot hook (the systemd unit
 * where sudo reaches root, an `@reboot` cron line where it does not). */
export function buildApplyProgram({ minMHz, maxMHz, persist }, overrides = {}) {
  const paths = resolvePaths(overrides);
  // Defense in depth: the caller validated already, but this is what reaches a root shell.
  const req = parseCapRequest({ minMHz, maxMHz, persist });
  const unit = buildUnit({ minMHz: req.minMHz, maxMHz: req.maxMHz, runDir: paths.runDir, bootIdFile: paths.bootIdFile, nvsmi: "@@NV@@" });
  const cron = cronLine({ minMHz: req.minMHz, maxMHz: req.maxMHz });
  return [
    ...header(paths),
    `MIN=${req.minMHz}; MAX=${req.maxMHz}; PERSIST=${req.persist ? 1 : 0}`,
    '[ -n "$NV" ] || fail no-nvidia "nvidia-smi was not found on this unit"',
    "HW=$(hwmax)",
    '[ -n "$HW" ] || fail no-gpu "could not read the GPU maximum clock"',
    '[ "$MAX" -le "$HW" ] || fail range "the cap is above this GPU\'s maximum clock ($HW MHz)"',
    needSudoLine(paths),
    "take_lock",
    // Keeping the cap needs a boot hook, chosen once here and used throughout:
    // the systemd unit where sudo reaches a root shell and systemd runs, else an
    // @reboot line where cron runs. With neither, refuse before the cap is
    // applied — capping first and failing on the hook would leave the GPU capped
    // with an error on screen.
    'HOOK=none',
    `if [ "$PERSIST" = 1 ]; then if can_sudo_root && [ -d ${paths.systemdRunDir} ]; then HOOK=unit; elif can_cron; then HOOK=cron; fi; fi`,
    `if [ "$PERSIST" = 1 ] && [ "$HOOK" = none ] && can_sudo_root; then fail no-systemd "keeping the cap after reboot needs systemd or a running cron service, and this unit has neither"; fi`,
    'if [ "$PERSIST" = 1 ] && [ "$HOOK" = none ]; then fail no-sudo "keeping the cap after reboot needs passwordless sudo for the system service (NOPASSWD: ALL) or a running cron service for a @reboot job, and this unit offers neither"; fi',
    // Every path may rewrite the user's crontab (to add or drop our line), so it
    // is read before anything changes: an unreadable one is never written back
    // empty. A service the cron hook has no root to remove would keep
    // re-applying its own cap at every boot.
    'cron_load || fail cron-failed "could not read the crontab; nothing was changed"',
    // Everything the @reboot line will contain is checked before anything changes.
    'if [ "$HOOK" = cron ]; then',
    '  SUDO_BIN=$(command -v sudo 2>/dev/null || true)',
    '  [ -n "$SUDO_BIN" ] || fail no-sudo "sudo was not found on this unit"',
    // The token that tells this install's job from any later one (see cronLine).
    '  JOB=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -dc 0-9a-f)',
    '  [ ${#JOB} = 16 ] || fail cron-failed "could not prepare the @reboot job; nothing was changed"',
    '  for P in "$SUDO_BIN" "$NV" "$CRONBIN" "$ALT_DIR" "$ALT_MARKER" "$ALT_FAIL" "$BOOTID_FILE" "$FLOCK"; do',
    '    safe_path "$P" || fail cron-failed "a path the @reboot job needs (sudo, nvidia-smi, crontab or the home directory) has characters that cannot be put in a crontab safely; nothing was changed"',
    '  done',
    'fi',
    'if [ "$HOOK" = cron ] && [ -f "$UNIT" ]; then fail service-failed "a boot service this unit cannot remove without NOPASSWD: ALL is still installed and would re-apply its own cap at every boot; nothing was changed"; fi',
    'marker_preflight "set the cap"',
    // Order matters: nothing existing is touched until the new cap has been accepted by nvidia-smi.
    'lgc() { if [ "$HOOK" = cron ]; then LC_ALL=C "$SUDO_BIN" -k -n "$NV" -lgc "$MIN,$MAX"; else $SUDO "$NV" -lgc "$MIN,$MAX"; fi; }',
    'lgc_error() { printf "%s" "$1" | head -n 1 | tr -cd "A-Za-z0-9 .,:_()/-" | head -c 160; }',
    'MARKER_ERR="could not record the cap"',
    'write_marker() {',
    '  B=$(bootid); [ -n "$B" ] || return 1',
    '  if can_sudo_root; then',
    '    $SUDO sh -c \'mkdir -p "$1" && chmod 755 "$1" && echo "$2 $3" > "$4"\' sh "$RUNDIR" "$MAX" "$B" "$MARKER" || return 1',
    // A later service stop only removes the root marker; do not resurrect a superseded user cap.
    '    if [ "$MARKER" != "$ALT_MARKER" ]; then',
    '      rm -f "$ALT_MARKER" 2>/dev/null || $SUDO rm -f "$ALT_MARKER" 2>/dev/null || return 1',
    '    fi',
    '    return 0',
    '  fi',
    '  [ -n "$HOMEDIR" ] || return 1',
    '  mkdir -p "$ALT_DIR" 2>/dev/null || return 1',
    '  printf "%s %s\\n" "$MAX" "$B" > "$ALT_MARKER" 2>/dev/null || return 1',
    // The status reads root's marker first: one left from when sudo reached a root
    // shell would hide the cap just recorded. marker_preflight made sure it can go.
    '  [ "$MARKER" = "$ALT_MARKER" ] && return 0',
    '  rm -f "$MARKER" 2>/dev/null && return 0',
    '  MARKER_ERR="the cap is applied until the next reboot, but the older recorded cap ($MARKER) could not be removed, so the status may show it instead"',
    '  return 1',
    '}',
    'OUT=$(lgc 2>&1) || {',
    '  if [ "$HOOK" = cron ]; then',
    '    case "$OUT" in sudo:*) fail no-sudo "keeping the cap after reboot requires this exact NVIDIA cap command without a password or cached sudo authentication: $(lgc_error "$OUT")" ;; esac',
    '  fi',
    '  fail lgc-failed "nvidia-smi refused the clock cap: $(lgc_error "$OUT")"',
    '}',
    'if [ "$PERSIST" = 0 ]; then',
    // The cap is live and recorded first: if a stale hook then cannot be removed, the
    // status still reads the cap that is really in force, and the error says what is left.
    '  write_marker || fail marker-failed "$MARKER_ERR"',
    // A stale hook of either kind would re-apply the old cap at the next boot.
    '  drop_cron || fail cron-failed "the cap is applied until the next reboot, but the existing @reboot job could not be removed and will re-apply its own cap at boot"',
    '  if [ -f "$UNIT" ]; then',
    // Stopping the old service resets clocks and deletes the marker, so restore both afterwards.
    '    if ! drop_service; then',
    '      OUT=$(lgc 2>&1) || fail lgc-failed "the old boot service could not be removed, and restoring the live cap failed: $(lgc_error "$OUT")"',
    '      write_marker || fail marker-failed "the old boot service could not be removed; the live cap was restored but its marker could not be recorded"',
    '      fail service-failed "the cap is applied until the next reboot, but the existing boot service could not be removed and will re-apply its own cap at boot"',
    '    fi',
    '    OUT=$(lgc 2>&1) || fail lgc-failed "nvidia-smi refused the clock cap: $(lgc_error "$OUT")"',
    '    write_marker || fail marker-failed "$MARKER_ERR"',
    "  fi",
    "else",
    '  write_marker || fail marker-failed "$MARKER_ERR"',
    "  D=$(mktemp -d) || fail service-failed \"could not create a temporary directory\"",
    '  trap \'rm -rf "$D"\' EXIT',
    // Root: the oneshot unit sparkLimiter installs.
    '  if [ "$HOOK" = unit ]; then',
    '  if [ -f "$UNIT" ]; then cp "$UNIT" "$D/unit.old" || fail service-failed "could not back up the existing service"; fi',
    "  cat > \"$D/unit\" <<'SPARKDASH_UNIT_EOF'",
    unit.replace(/\n$/, ""),
    "SPARKDASH_UNIT_EOF",
    '  sed "s#@@NV@@#$NV#g" "$D/unit" > "$D/unit.final" || fail service-failed "could not prepare the service file"',
    // Past this point a failure restores the previous service (or removes ours) and re-applies the live cap.
    "  rollback() {",
    '    if [ -f "$D/unit.old" ]; then',
    '      $SUDO install -m 644 $OWNER "$D/unit.old" "$UNIT" >/dev/null 2>&1',
    "    else",
    `      $SUDO $SYSTEMCTL disable ${UNIT_NAME} >/dev/null 2>&1`,
    '      $SUDO rm -f "$UNIT"',
    "    fi",
    "    $SUDO $SYSTEMCTL daemon-reload >/dev/null 2>&1",
    "    lgc >/dev/null 2>&1",
    "    write_marker >/dev/null 2>&1",
    "  }",
    '  $SUDO install -m 644 $OWNER "$D/unit.final" "$UNIT" || fail service-failed "could not install the service file"',
    "  $SUDO $SYSTEMCTL daemon-reload || { rollback; fail service-failed \"systemctl daemon-reload failed; the cap applies until the next reboot\"; }",
    `  $SUDO $SYSTEMCTL enable ${UNIT_NAME} >/dev/null 2>&1 || { rollback; fail service-failed "could not enable the service; the cap applies until the next reboot"; }`,
    `  $SUDO $SYSTEMCTL restart ${UNIT_NAME} >/dev/null 2>&1 || { rollback; fail service-failed "the service did not start; the cap applies until the next reboot"; }`,
    `  [ "$($SYSTEMCTL is-active ${UNIT_NAME} 2>/dev/null)" = active ] || { rollback; fail service-failed "the service is not active; the cap applies until the next reboot"; }`,
    '  write_marker || fail marker-failed "$MARKER_ERR"',
    // A @reboot line left from when this unit had only the narrow rule would
    // race the service at boot with its own, older cap.
    '  drop_cron || fail cron-failed "the boot service is installed, but the old @reboot job could not be removed and would re-apply its own cap at boot"',
    // No root: an @reboot line in the user's own crontab. It runs the very same
    // `sudo -n nvidia-smi -lgc` the cap has just run, so the narrow rule the unit
    // already grants is enough — and it refreshes the marker at every boot.
    '  else',
    "  cat > \"$D/cron\" <<'SPARKDASH_CRON_EOF'",
    cron.replace(/\n$/, ""),
    "SPARKDASH_CRON_EOF",
    '  CRON_LINE=$(sed "s#@@JOB@@#$JOB#g; s#@@CRON@@#$CRONBIN#g; s#@@SUDO@@#$SUDO_BIN#g; s#@@NV@@#$NV#g; s#@@ALT_DIR@@#$ALT_DIR#g; s#@@BOOTID@@#$BOOTID_FILE#g; s#@@FLOCK@@#$FLOCK#g" "$D/cron") || fail cron-failed "could not prepare the @reboot job"',
    '  T=$(mktemp) || fail cron-failed "could not create a temporary file"',
    '  cron_text | grep -v "$CRON_RE" > "$T"',
    "  printf '%s\\n' \"$CRON_LINE\" >> \"$T\"",
    '  "$CRONBIN" "$T" >/dev/null 2>&1 || { rm -f "$T"; fail cron-failed "could not add the @reboot job; the cap applies until the next reboot"; }',
    '  rm -f "$T"',
    // Crontab implementations rewrite what they store: read back what is really there.
    // The job finds itself by its token, so a line without it is not this install.
    '  if ! cron_load || ! cron_has || [ "$(cron_clocks)" != "$MIN,$MAX" ] || ! cron_text | grep -q "^@reboot J=$JOB; "; then',
    '    drop_cron',
    '    fail cron-failed "the @reboot job did not install; the cap applies until the next reboot"',
    '  fi',
    '  rm -f "$ALT_FAIL" 2>/dev/null',
    '  fi',
    "fi",
    // Which hook took, so the row can name it instead of a bare "kept".
    'PK2=$HOOK',
    paths.manual
      ? "if [ \"$PK2\" = unit ]; then printf 'Done: GPU clock capped at %s MHz and kept after reboot (spark-gpu-clock-limit.service).\\n' \"$MAX\"; elif [ \"$PK2\" = cron ]; then printf 'Done: GPU clock capped at %s MHz and kept after reboot (@reboot cron job).\\n' \"$MAX\"; else printf 'Done: GPU clock capped at %s MHz until the next reboot.\\n' \"$MAX\"; fi"
      : "printf 'RESULT=ok\\nCAP=%s\\nPERSIST=%s\\nPERSIST_KIND=%s\\n' \"$MAX\" \"$PERSIST\" \"$PK2\"",
    "exit 0",
    "",
  ].join("\n");
}

/** Remove the cap: stop and delete both boot hooks, `nvidia-smi -rgc`, drop the marker. */
export function buildResetProgram(overrides = {}) {
  const paths = resolvePaths(overrides);
  return [
    ...header(paths),
    '[ -n "$NV" ] || fail no-nvidia "nvidia-smi was not found on this unit"',
    needSudoLine(paths),
    "take_lock",
    // A marker left behind after `-rgc` would keep the status reading a cap that is no longer in force.
    'marker_preflight "reset"',
    'drop_cron || fail cron-failed "could not remove the existing @reboot job"',
    'drop_service || fail service-failed "could not remove the existing service"',
    '$SUDO "$NV" -rgc >/dev/null 2>&1 || fail rgc-failed "nvidia-smi could not reset the clocks"',
    'rm -f "$MARKER" "$ALT_MARKER" "$ALT_FAIL" 2>/dev/null || $SUDO rm -f "$MARKER" "$ALT_MARKER" "$ALT_FAIL" 2>/dev/null || fail marker-failed "could not clear the recorded cap"',
    paths.manual ? "printf 'Done: GPU clock cap removed.\\n'" : "printf 'RESULT=ok\\n'",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Parse a program's KEY=value stdout. Unknown keys are dropped, values are
 * length-capped, and a missing RESULT line is an error (never "healthy").
 * Keys that can repeat (one line per card or service) come back as arrays.
 * @param {string} out
 * @returns {Record<string, any>}
 */
export function parseProgramOutput(out) {
  const KEYS = new Set([
    "RESULT", "CODE", "MSG", "HWMAX", "SUDO", "PERSIST_KIND", "PERSIST", "CAP",
    "SVC_INSTALLED", "SVC_CLOCKS", "SVC_ENABLED", "SVC_ACTIVE",
    "CRON_INSTALLED", "CRON_CLOCKS", "CRON_FAILED",
  ]);
  const LIST_KEYS = new Set(["CARD", "SVC_CARD", "OTHER_SVC"]);
  const MAX_LIST = 64;
  const res = {};
  for (const line of String(out ?? "").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (KEYS.has(m[1])) res[m[1]] = m[2].slice(0, 300);
    else if (LIST_KEYS.has(m[1]) && (res[m[1]] ??= []).length < MAX_LIST) res[m[1]].push(m[2].slice(0, 300));
  }
  if (res.RESULT !== "ok" && res.RESULT !== "error") {
    return { RESULT: "error", CODE: "bad-output", MSG: "the unit returned an unexpected answer" };
  }
  return res;
}

/**
 * A paste-into-a-terminal command that runs the apply/reset program on the unit by hand.
 * Same program the dashboard runs, but with plain `sudo` (prompts for the password) and
 * readable output. It is written to a private temp file first so `sudo` can read the
 * terminal, and the text is plain sh the person can read before running it.
 * @param {"apply" | "reset"} action
 * @param {{ minMHz?: number, maxMHz?: number, persist?: boolean }} [req]
 */
export function buildManualCommand(action, req = {}, overrides = {}) {
  const manual = { ...overrides, manual: true };
  let program;
  if (action === "apply") {
    const r = parseCapRequest(req);
    program = buildApplyProgram(r, manual);
  } else if (action === "reset") {
    program = buildResetProgram(manual);
  } else {
    throw Object.assign(new Error("action must be apply or reset"), { status: 400 });
  }
  const what = action === "apply"
    ? `cap the GPU clock at ${req.maxMHz} MHz${req.persist === true ? " and keep it after reboot" : ""}`
    : "remove the GPU clock cap and its boot service";
  return [
    "# sparkDash: run this on the Spark itself. It will ask for your sudo password.",
    `# It will ${what}. Read it first; nothing is sent anywhere.`,
    'f=$(mktemp) && cat > "$f" <<\'SPARKDASH_SCRIPT_EOF\'',
    program.replace(/\n$/, ""),
    "SPARKDASH_SCRIPT_EOF",
    'sh "$f"; rc=$?; rm -f "$f"; [ "$rc" = 0 ]',
    "",
  ].join("\n");
}
