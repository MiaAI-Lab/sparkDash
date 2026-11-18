/**
 * Headless desktop control: make a Linux unit headless, and restore what was
 * recorded before that change.
 *
 * Both actions run as root through sudo, exactly like the spark-attic
 * installer: a typed password is optional, blank means passwordless sudo, and
 * the password travels on stdin, never in an argument list.
 *
 * Every shell program is built from fixed strings. Unit names come only from
 * HEADLESS_UNITS, never from the client.
 */
import { runProgram } from "../gpuclock/GpuClockManager.js";
import { parseSudoPassword } from "../gpuclock/commands.js";
import { passwordAllowed } from "../gpuclock/routes.js";
import { SudoPasswordGuard } from "../util/sudoPasswordGuard.js";
import { HEADLESS_UNITS, DISPLAY_MANAGER_UNIT } from "../collectors/HeadlessProbe.js";

/** Root-owned record of what the last make-headless changed. */
export const HEADLESS_STATE_DIR = "/var/lib/sparkdash-headless";
export const HEADLESS_STATE_FILE = `${HEADLESS_STATE_DIR}/state`;

/** The sudo preamble shared by both programs (same shape as the spark-attic installer). */
const SUDO_PREAMBLE = `PW=\${SPARKDASH_SUDO_PW-}
unset SPARKDASH_SUDO_PW
if [ "$(id -u)" = 0 ]; then
  as_root() { "$@"; }
elif [ -n "$PW" ]; then
  printf '%s\\n' "$PW" | sudo -S -p '' -v || { echo 'sudo password was rejected' >&2; exit 1; }
  as_root() { printf '%s\\n' "$PW" | sudo -S -p '' "$@"; }
else
  as_root() { sudo -n "$@"; }
fi`;

const MEM_AVAILABLE = `mem_available() { awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null || true; }`;

/** The allow-list as a shell case pattern, for the restore program's own check. */
const UNIT_CASE = HEADLESS_UNITS.join("|");

/**
 * Make the unit headless: record what is about to change, set the boot default
 * to multi-user.target, stop the display manager, then disable and stop the
 * ticked allow-listed services.
 *
 * The record is written before anything changes, so a failed action still
 * leaves an accurate undo. Only allow-listed units are recorded or changed.
 *
 * @param {string[]} [units] allow-listed unit names to disable; anything else is ignored
 * @returns {string}
 */
export function makeHeadlessProgram(units = []) {
  const selected = HEADLESS_UNITS.filter((unit) => units.includes(unit));
  const record = selected.length
    ? `for u in ${selected.join(" ")}; do
  ufs=$(systemctl show -p UnitFileState "$u" 2>/dev/null | sed -n 's/^UnitFileState=//p')
  as=$(systemctl show -p ActiveState "$u" 2>/dev/null | sed -n 's/^ActiveState=//p')
  [ -n "$ufs" ] || ufs=-
  [ -n "$as" ] || as=-
  state="$state
unit $u $ufs $as"
done`
    : ":";
  const disable = selected.length
    ? `for u in ${selected.join(" ")}; do
  if as_root systemctl disable --now "$u" >/dev/null 2>&1; then
    disabled="$disabled\${disabled:+,}$u"
  else
    failed="$failed\${failed:+,}$u"
  fi
done`
    : ":";
  return `set -eu
${SUDO_PREAMBLE}
${MEM_AVAILABLE}
before=$(mem_available)
prev_default=$(systemctl get-default 2>/dev/null || true)
[ -n "$prev_default" ] || { echo 'Could not read the current default target' >&2; exit 1; }
dm_state=$(systemctl show -p ActiveState ${DISPLAY_MANAGER_UNIT} 2>/dev/null | sed -n 's/^ActiveState=//p')
state="default_target=$prev_default
display_manager=$dm_state"
${record}
as_root sh -c 'mkdir -p "$1" && printf "%s\\n" "$2" > "$1/state"' sh ${HEADLESS_STATE_DIR} "$state"
as_root systemctl set-default multi-user.target || { echo 'Could not set the default target to multi-user.target' >&2; exit 1; }
stopped_dm=0
if systemctl is-active --quiet ${DISPLAY_MANAGER_UNIT}; then
  as_root systemctl stop ${DISPLAY_MANAGER_UNIT} || { echo 'Could not stop the display manager' >&2; exit 1; }
  stopped_dm=1
fi
disabled=
failed=
${disable}
after=$(mem_available)
printf 'headless-result mem_before=%s\\n' "$before"
printf 'headless-result mem_after=%s\\n' "$after"
printf 'headless-result default_before=%s\\n' "$prev_default"
printf 'headless-result default_after=%s\\n' "$(systemctl get-default 2>/dev/null || true)"
printf 'headless-result stopped_display_manager=%s\\n' "$stopped_dm"
printf 'headless-result disabled=%s\\n' "$disabled"
printf 'headless-result failed=%s\\n' "$failed"
printf 'headless-result state_file=%s\\n' ${HEADLESS_STATE_FILE}
`;
}

/**
 * Restore the desktop from the recorded state: the previous default target,
 * the units that were enabled or active, and the display manager. With no
 * record, only the default target goes back to graphical.target.
 */
export const RESTORE_PROGRAM = `set -eu
${SUDO_PREAMBLE}
${MEM_AVAILABLE}
before=$(mem_available)
prev_default=$(systemctl get-default 2>/dev/null || true)
state_file=${HEADLESS_STATE_FILE}
restored=
failed=
started_dm=0
if as_root test -f "$state_file"; then
  mode=recorded
  content=$(as_root cat "$state_file")
  target=$(printf '%s\\n' "$content" | sed -n 's/^default_target=//p' | head -n 1)
  dm=$(printf '%s\\n' "$content" | sed -n 's/^display_manager=//p' | head -n 1)
  case "$target" in
    graphical.target|multi-user.target) ;;
    *) target=graphical.target ;;
  esac
  as_root systemctl set-default "$target" || { echo 'Could not restore the default target' >&2; exit 1; }
  units=$(printf '%s\\n' "$content" | sed -n 's/^unit //p')
  while read -r u ufs as; do
    [ -n "$u" ] || continue
    case "$u" in
      ${UNIT_CASE}) ;;
      *) continue ;;
    esac
    changed=0
    if [ "$ufs" = enabled ]; then
      if as_root systemctl enable "$u" >/dev/null 2>&1; then changed=1; else failed="$failed\${failed:+,}$u"; fi
    fi
    if [ "$as" = active ]; then
      if as_root systemctl start "$u" >/dev/null 2>&1; then changed=1; else failed="$failed\${failed:+,}$u"; fi
    fi
    [ "$changed" = 0 ] || restored="$restored\${restored:+,}$u"
  done <<EOF
$units
EOF
  if [ "$dm" = active ]; then
    if as_root systemctl start ${DISPLAY_MANAGER_UNIT} >/dev/null 2>&1; then started_dm=1; else failed="$failed\${failed:+,}${DISPLAY_MANAGER_UNIT}"; fi
  fi
  if [ -z "$failed" ]; then as_root rm -f "$state_file"; fi
else
  mode=default-only
  as_root systemctl set-default graphical.target || { echo 'Could not set the default target to graphical.target' >&2; exit 1; }
fi
after=$(mem_available)
printf 'headless-result mode=%s\\n' "$mode"
printf 'headless-result mem_before=%s\\n' "$before"
printf 'headless-result mem_after=%s\\n' "$after"
printf 'headless-result default_before=%s\\n' "$prev_default"
printf 'headless-result default_after=%s\\n' "$(systemctl get-default 2>/dev/null || true)"
printf 'headless-result started_display_manager=%s\\n' "$started_dm"
printf 'headless-result restored=%s\\n' "$restored"
printf 'headless-result failed=%s\\n' "$failed"
`;

const RESULT_LINE = /^headless-result (\S+)=(.*)$/;

/** @param {string} value */
function kib(value) {
  return /^\d+$/.test(value) ? Number(value) : null;
}

/** @param {string} value */
function list(value) {
  return value ? value.split(",").filter(Boolean) : [];
}

/**
 * Normalize an action's output. Pure (no I/O) — exported for unit tests.
 * @param {string} out
 */
export function parseHeadlessResult(out) {
  const result = {
    mode: null,
    memBeforeKib: null,
    memAfterKib: null,
    defaultBefore: null,
    defaultAfter: null,
    stoppedDisplayManager: false,
    startedDisplayManager: false,
    disabled: [],
    restored: [],
    failed: [],
    stateFile: null,
  };
  for (const raw of String(out ?? "").split("\n")) {
    const m = RESULT_LINE.exec(raw.trimEnd());
    if (!m) continue;
    const [, key, value] = m;
    switch (key) {
      case "mode":
        result.mode = value || null;
        break;
      case "mem_before":
        result.memBeforeKib = kib(value);
        break;
      case "mem_after":
        result.memAfterKib = kib(value);
        break;
      case "default_before":
        result.defaultBefore = value || null;
        break;
      case "default_after":
        result.defaultAfter = value || null;
        break;
      case "stopped_display_manager":
        result.stoppedDisplayManager = value === "1";
        break;
      case "started_display_manager":
        result.startedDisplayManager = value === "1";
        break;
      case "disabled":
        result.disabled = list(value);
        break;
      case "restored":
        result.restored = list(value);
        break;
      case "failed":
        result.failed = list(value);
        break;
      case "state_file":
        result.stateFile = value || null;
        break;
    }
  }
  return result;
}

/**
 * The ticked units, checked against the allow-list. Anything else is refused
 * rather than dropped, so a client cannot quietly ask for a unit the server
 * will not touch.
 * @param {unknown} value
 * @returns {{ units: string[] } | { error: string }}
 */
export function parseHeadlessUnits(value) {
  if (value == null) return { units: [] };
  if (!Array.isArray(value)) return { error: "units must be a list of service names" };
  const units = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !HEADLESS_UNITS.includes(raw)) {
      return { error: `Unknown service: ${String(raw).slice(0, 64)}` };
    }
    if (!units.includes(raw)) units.push(raw);
  }
  return { units };
}

/** A Linux unit: not a Mac, not Windows. */
function isLinuxUnit(spark) {
  return spark.kind !== "mac" && !["windows", "darwin"].includes(spark.platform);
}

export function registerHeadlessRoutes(app, { registry, allowChange, rejectLimited, allowRead = () => true, allowPlainPassword = () => false, run = runProgram }) {
  const guard = new SudoPasswordGuard();
  const running = new Set();

  app.get("/api/sparks/:id/headless/flags", (req, res) => {
    if (!allowRead(req)) return rejectLimited(res, "Too many requests");
    if (!registry.getSpark(req.params.id)) return res.status(404).json({ error: "Spark not found" });
    res.json({ passwordAllowed: passwordAllowed(req, allowPlainPassword()), plainPasswordAllowed: allowPlainPassword() === true });
  });

  /**
   * @param {(body: object) => { program: string } | { error: string }} build
   */
  const handle = (build) => async (req, res) => {
    if (!allowChange(req)) return rejectLimited(res, "Too many requests");
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!isLinuxUnit(spark)) return res.status(400).json({ error: "Headless desktop control requires a Linux unit" });
    if (!spark.headlessMonitoring) return res.status(400).json({ error: "Enable headless desktop monitoring before changing it" });
    if (req.body?.confirm !== true) return res.status(400).json({ error: "Confirmation required" });
    const built = build(req.body ?? {});
    if (built.error) return res.status(400).json({ error: built.error });
    let password;
    try {
      password = parseSudoPassword(req.body?.sudoPassword);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (password && !passwordAllowed(req, allowPlainPassword())) {
      return res.status(400).json({ error: "A sudo password requires HTTPS, a local connection, or the plain HTTP password setting" });
    }
    if (password && guard.lockedForSeconds(spark)) return res.status(429).json({ error: "Too many wrong sudo passwords; try again later" });
    if (running.has(spark.id)) return res.status(409).json({ error: "A headless desktop change is already running" });
    running.add(spark.id);
    try {
      const out = await run(spark, built.program, { timeoutMs: 120000, maxBuffer: 1024 * 1024, ...(password ? { input: password } : {}) });
      if (password) guard.note(spark, false);
      res.json({ success: true, result: parseHeadlessResult(out) });
    } catch (err) {
      const message = String(err.message || err).replaceAll(password || "\0", "[redacted]");
      if (password && message.includes("sudo password was rejected")) guard.note(spark, true);
      res.status(502).json({ error: `Headless desktop change failed: ${message.slice(0, 1600)}` });
    } finally {
      running.delete(spark.id);
    }
  };

  app.post(
    "/api/sparks/:id/headless/make",
    handle((body) => {
      if (body.stopDesktopConfirmed !== true) return { error: "Desktop-stop confirmation required" };
      const parsed = parseHeadlessUnits(body.units);
      if (parsed.error) return parsed;
      return { program: makeHeadlessProgram(parsed.units) };
    })
  );

  app.post("/api/sparks/:id/headless/restore", handle(() => ({ program: RESTORE_PROGRAM })));
}
