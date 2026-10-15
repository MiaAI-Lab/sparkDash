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
 * because a boot invalidates it. Placeholders are filled by the program from
 * paths it resolved on the unit; `$(...)` runs at boot, not at install time.
 * No `%` may appear: crontab would read one as a newline.
 */
function cronLine({ minMHz, maxMHz }) {
  return `${[
    `@reboot for i in 1 2 3; do /bin/sleep 20; @@SUDO@@ -n @@NV@@ -lgc ${minMHz},${maxMHz} && {`,
    `/bin/mkdir -p "@@ALT_DIR@@" &&`,
    `echo "${maxMHz} $(/bin/cat @@BOOTID@@)" > "@@ALT_MARKER@@" && break;`,
    "}; done",
    `# ${CRON_TAG}`,
  ].join(" ")}\n`;
}

/** Lowest cap accepted: below this the GPU is barely usable and the box looks hung. */
export const MIN_CAP_MHZ = 300;
export const MAX_CAP_MHZ = 10000;

/** root-owned locations only: never PATH, because the path ends up in a root-run unit. */
const NVSMI_CANDIDATES = ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi", "/bin/nvidia-smi"];
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
function resolvePaths(overrides = {}) {
  const p = { ...DEFAULT_PATHS, ...overrides };
  const list = [p.unitDir, p.runDir, p.bootIdFile, p.systemdRunDir, ...p.nvsmi];
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
function needSudoLine(paths) {
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

function header(paths) {
  const nv = paths.nvsmi.map((c) => `"${c}"`).join(" ");
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
    `BOOTID_FILE=${paths.bootIdFile}`,
    "NV=''",
    `for c in ${nv}; do if [ -x "$c" ]; then NV="$c"; break; fi; done`,
    paths.manual
      ? "fail() { printf 'Error: %s\\n' \"$2\" >&2; exit 1; }"
      : "fail() { printf 'RESULT=error\\nCODE=%s\\nMSG=%s\\n' \"$1\" \"$2\"; exit 0; }",
    'digits() { tr -dc 0-9; }',
    'clean() { printf "%s" "$1" | head -n 1 | tr -cd "A-Za-z0-9 .,:_()/-" | head -c 160; }',
    'hwmax() { "$NV" --query-gpu=clocks.max.gr --format=csv,noheader,nounits 2>/dev/null | head -n 1 | digits; }',
    'bootid() { tr -dc "0-9a-fA-F-" < "$BOOTID_FILE" 2>/dev/null | head -c 64; }',
    paths.password
      ? // Why a refusal happened matters: only a wrong password counts toward the lock.
        "need_sudo() { SUDO_ERR=''; [ -z \"$SUDO\" ] && return 0; command -v sudo >/dev/null 2>&1 || { SUDO_ERR=__missing__; return 1; }; SUDO_ERR=$(printf '%s\\n' \"$PW\" | LC_ALL=C sudo -k -S -p '' true 2>&1 >/dev/null) && return 0; return 1; }"
      : paths.manual
      ? 'need_sudo() { [ -z "$SUDO" ] && return 0; command -v sudo >/dev/null 2>&1 && sudo -v; }'
      : // Either NOPASSWD: ALL, or a rule naming the commands actually run — the
        // README's own example is the narrow one, so a least-privilege unit can cap.
        'need_sudo() { [ -z "$SUDO" ] && return 0; command -v sudo >/dev/null 2>&1 || return 1; $SUDO true >/dev/null 2>&1 || $SUDO -l "$NV" -lgc 0,3000 >/dev/null 2>&1; }',
    // Root powers beyond the nvidia-smi commands (`sudo sh -c`): the root-owned
    // marker needs them, and so does the boot service. `sudo -n true` is not
    // enough of a probe here — a narrow rule refuses `sh` but still allows `-lgc`.
    // With a typed password or plain `sudo` the same probe runs through $SUDO.
    'can_sudo_root() { [ -z "$SUDO" ] && return 0; $SUDO sh -c : >/dev/null 2>&1; }',
    // Keeping the cap without root: a @reboot line in the SSH user's own crontab,
    // offered only where cron is there to run it.
    `CRON_TAG="${CRON_TAG}"`,
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
    'cron_has() { cron_text | grep -q "$CRON_TAG"; }',
    'cron_clocks() { cron_text | grep "$CRON_TAG" | sed -n \'s/.*-lgc \\([0-9][0-9]*,[0-9][0-9]*\\).*/\\1/p\' | head -n 1; }',
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
    '  cron_has || return 0',
    '  T=$(mktemp) || return 1',
    '  cron_text | grep -v "$CRON_TAG" > "$T"',
    '  if [ -s "$T" ]; then',
    '    "$CRONBIN" "$T" >/dev/null 2>&1 || { rm -f "$T"; return 1; }',
    '  else',
    // It was the user's only job (the read above succeeded and held our tag):
    // an empty crontab file is not accepted everywhere.
    '    "$CRONBIN" -r >/dev/null 2>&1 || { rm -f "$T"; return 1; }',
    '  fi',
    '  rm -f "$T"',
    '  cron_load || return 1',
    '  ! cron_has',
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
    "CI=0; CCLK=''",
    'if cron_load && cron_has; then CI=1; CCLK=$(cron_clocks); fi',
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
    "printf 'RESULT=ok\\nHWMAX=%s\\nSUDO=%s\\nPERSIST_KIND=%s\\nCAP=%s\\nSVC_INSTALLED=%s\\nSVC_CLOCKS=%s\\nSVC_ENABLED=%s\\nSVC_ACTIVE=%s\\nCRON_INSTALLED=%s\\nCRON_CLOCKS=%s\\n' \"$HW\" \"$S\" \"$PK\" \"$CAP\" \"$INST\" \"$CLK\" \"$EN\" \"$ACT\" \"$CI\" \"$CCLK\"",
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
    'if [ "$HOOK" = cron ] && [ -f "$UNIT" ]; then fail service-failed "a boot service this unit cannot remove without NOPASSWD: ALL is still installed and would re-apply its own cap at every boot; nothing was changed"; fi',
    // Order matters: nothing existing is touched until the new cap has been accepted by nvidia-smi.
    'lgc() { $SUDO "$NV" -lgc "$MIN,$MAX"; }',
    'lgc_error() { printf "%s" "$1" | head -n 1 | tr -cd "A-Za-z0-9 .,:_()/-" | head -c 160; }',
    'write_marker() {',
    '  B=$(bootid); [ -n "$B" ] || return 1',
    '  if can_sudo_root; then',
    '    $SUDO sh -c \'mkdir -p "$1" && chmod 755 "$1" && echo "$2 $3" > "$4"\' sh "$RUNDIR" "$MAX" "$B" "$MARKER"',
    '    return $?',
    '  fi',
    '  [ -n "$HOMEDIR" ] || return 1',
    '  mkdir -p "$ALT_DIR" 2>/dev/null || return 1',
    '  printf "%s %s\\n" "$MAX" "$B" > "$ALT_MARKER" 2>/dev/null || return 1',
    '}',
    'OUT=$(lgc 2>&1) || fail lgc-failed "nvidia-smi refused the clock cap: $(lgc_error "$OUT")"',
    'if [ "$PERSIST" = 0 ]; then',
    // A stale hook of either kind would re-apply the old cap at the next boot.
    '  drop_cron || fail cron-failed "could not remove the existing @reboot job"',
    '  if [ -f "$UNIT" ]; then',
    // Stopping the old service resets the clocks (ExecStop), so the cap is applied again afterwards.
    '    drop_service || fail service-failed "could not remove the existing service"',
    '    OUT=$(lgc 2>&1) || fail lgc-failed "nvidia-smi refused the clock cap: $(lgc_error "$OUT")"',
    "  fi",
    '  write_marker || fail marker-failed "could not record the cap"',
    "else",
    '  write_marker || fail marker-failed "could not record the cap"',
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
    '  write_marker || fail marker-failed "could not record the cap"',
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
    '  SUDO_BIN=$(command -v sudo 2>/dev/null || true)',
    '  [ -n "$SUDO_BIN" ] || fail no-sudo "sudo was not found on this unit"',
    '  CRON_LINE=$(sed "s#@@SUDO@@#$SUDO_BIN#g; s#@@NV@@#$NV#g; s#@@ALT_DIR@@#$ALT_DIR#g; s#@@ALT_MARKER@@#$ALT_MARKER#g; s#@@BOOTID@@#$BOOTID_FILE#g" "$D/cron") || fail cron-failed "could not prepare the @reboot job"',
    '  T=$(mktemp) || fail cron-failed "could not create a temporary file"',
    '  cron_text | grep -v "$CRON_TAG" > "$T"',
    "  printf '%s\\n' \"$CRON_LINE\" >> \"$T\"",
    '  "$CRONBIN" "$T" >/dev/null 2>&1 || { rm -f "$T"; fail cron-failed "could not add the @reboot job; the cap applies until the next reboot"; }',
    '  rm -f "$T"',
    // Crontab implementations rewrite what they store: read back what is really there.
    '  if ! cron_load || ! cron_has || [ "$(cron_clocks)" != "$MIN,$MAX" ]; then',
    '    drop_cron',
    '    fail cron-failed "the @reboot job did not install; the cap applies until the next reboot"',
    '  fi',
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
    'drop_cron || fail cron-failed "could not remove the existing @reboot job"',
    'drop_service || fail service-failed "could not remove the existing service"',
    '$SUDO "$NV" -rgc >/dev/null 2>&1 || fail rgc-failed "nvidia-smi could not reset the clocks"',
    'rm -f "$MARKER" "$ALT_MARKER" 2>/dev/null || $SUDO rm -f "$MARKER" "$ALT_MARKER" 2>/dev/null || fail marker-failed "could not clear the recorded cap"',
    paths.manual ? "printf 'Done: GPU clock cap removed.\\n'" : "printf 'RESULT=ok\\n'",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Parse a program's KEY=value stdout. Unknown keys are dropped, values are
 * length-capped, and a missing RESULT line is an error (never "healthy").
 * @param {string} out
 * @returns {Record<string, string>}
 */
export function parseProgramOutput(out) {
  const KEYS = new Set([
    "RESULT", "CODE", "MSG", "HWMAX", "SUDO", "PERSIST_KIND", "PERSIST", "CAP",
    "SVC_INSTALLED", "SVC_CLOCKS", "SVC_ENABLED", "SVC_ACTIVE",
    "CRON_INSTALLED", "CRON_CLOCKS",
  ]);
  const res = {};
  for (const line of String(out ?? "").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && KEYS.has(m[1])) res[m[1]] = m[2].slice(0, 300);
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
