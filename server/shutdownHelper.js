/**
 * In-UI installer for the shutdown helper (README: "Power off a unit").
 *
 * A remote unit can only be powered off through the SSH user, and `sudo -n`
 * fails without a sudoers rule. This installer writes the pinned helper and a
 * sudoers rule scoped to exactly that binary (validated with visudo before it
 * goes live, and installed atomically so a half-written rule can never break
 * sudo on the host). The user's sudo password travels once, through the same
 * guarded channel the spark-attic installer uses.
 */
import { runProgram } from "./gpuclock/GpuClockManager.js";
import { parseSudoPassword } from "./gpuclock/commands.js";
import { passwordAllowed } from "./gpuclock/routes.js";
import { SudoPasswordGuard } from "./util/sudoPasswordGuard.js";
import { SHUTDOWN_BIN, localPowerOffMode } from "./shutdown.js";

/**
 * The pinned installer. Idempotent: a unit where `sudo -n spark-shutdown
 * --check` already succeeds is left untouched. The sudoers rule is validated
 * with `visudo -cf` while it is still a dot-suffixed temp file (sudo ignores
 * those in sudoers.d), then moved into place with correct permissions.
 */
export const SHUTDOWN_HELPER_INSTALL_PROGRAM = `set -eu
PW=\${SPARKDASH_SUDO_PW-}
unset SPARKDASH_SUDO_PW
BIN=${SHUTDOWN_BIN}
SUDOERS=/etc/sudoers.d/spark-shutdown
if sudo -n "$BIN" --check >/dev/null 2>&1; then
  echo 'spark-shutdown helper already installed and authorized'
  exit 0
fi
if [ "$(id -u)" = 0 ]; then
  as_root() { "$@"; }
elif [ -n "$PW" ]; then
  printf '%s\\n' "$PW" | sudo -S -p '' -v || { echo 'sudo password was rejected' >&2; exit 1; }
  as_root() { printf '%s\\n' "$PW" | sudo -S -p '' "$@"; }
else
  as_root() { sudo -n "$@"; }
fi
HELPER='#!/bin/sh
# Installed by sparkDash: power this unit off without a password prompt.
case "$1" in
  --check) echo "spark-shutdown: check ok"; exit 0 ;;
esac
exec /usr/sbin/poweroff
'
# Content is staged in a user-writable dir and placed with install: nothing is
# piped through sudo, whose stdin is reserved for the password.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf '%s\\n' "$HELPER" > "$work/spark-shutdown"
printf '%s ALL=(root) NOPASSWD: %s "", %s --check\\n' "$(id -un)" "$BIN" "$BIN" > "$work/spark-shutdown.sudoers"
# A differing helper or sudoers rule on the host is someone else's — refuse
# rather than replace it. (sudoers content is only comparable with root, so
# without a password any existing rule counts as differing.)
if [ -e "$BIN" ] && ! cmp -s "$work/spark-shutdown" "$BIN"; then
  echo "an existing $BIN differs from the pinned helper — refusing to replace it" >&2
  exit 1
fi
if [ -f "$SUDOERS" ] && ! as_root cmp -s "$work/spark-shutdown.sudoers" "$SUDOERS" 2>/dev/null; then
  echo "an existing $SUDOERS differs from the pinned rule — remove it or rerun with the sudo password" >&2
  exit 1
fi
as_root install -m 0755 "$work/spark-shutdown" "$BIN"
as_root install -m 0440 "$work/spark-shutdown.sudoers" "$SUDOERS.tmp"
if ! as_root visudo -cf "$SUDOERS.tmp" >/dev/null; then
  echo 'the sudoers rule failed visudo validation — nothing was changed' >&2
  as_root rm -f "$SUDOERS.tmp"
  exit 1
fi
as_root mv -f "$SUDOERS.tmp" "$SUDOERS"
if sudo -n "$BIN" --check >/dev/null 2>&1; then
  echo "spark-shutdown helper installed: passwordless sudo covers $BIN"
else
  echo 'the helper is installed but passwordless sudo still fails' >&2
  exit 1
fi
`;

export function registerShutdownHelperInstallRoute(app, {
  registry,
  allowChange,
  rejectLimited,
  allowPlainPassword = () => false,
  run = runProgram,
  mode = localPowerOffMode,
} = {}) {
  const guard = new SudoPasswordGuard();
  const running = new Set();
  app.get("/api/sparks/:id/shutdown/install-helper", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    res.json({
      passwordAllowed: passwordAllowed(req, allowPlainPassword()),
      plainPasswordAllowed: allowPlainPassword() === true,
      directPowerOff: spark.isLocal ? mode() === "direct" : false,
      installSupported: !spark.isLocal && !["windows", "darwin"].includes(spark.platform),
    });
  });
  app.post("/api/sparks/:id/shutdown/install-helper", async (req, res) => {
    if (!allowChange(req)) return rejectLimited(res, "Too many requests");
    if (req.body?.confirm !== true) return res.status(400).json({ error: "Installation confirmation required" });
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (spark.isLocal) {
      return res.status(400).json({
        error: mode() === "direct"
          ? "This unit is the dashboard host — it powers off directly through the host mount namespace, no helper needed"
          : 'the dashboard host needs the helper installed on the host itself (README: "Power off a unit")',
      });
    }
    if (["windows", "darwin"].includes(spark.platform)) {
      return res.status(400).json({ error: "the shutdown helper is only supported on Linux hosts" });
    }
    let password;
    try { password = parseSudoPassword(req.body?.sudoPassword); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    if (password && !passwordAllowed(req, allowPlainPassword())) return res.status(400).json({ error: "A sudo password requires HTTPS, a local connection, or the plain HTTP password setting" });
    if (password && guard.lockedForSeconds(spark)) return res.status(429).json({ error: "Too many wrong sudo passwords; try again later" });
    if (running.has(spark.id)) return res.status(409).json({ error: "Installation already running" });
    running.add(spark.id);
    try {
      const out = await run(spark, SHUTDOWN_HELPER_INSTALL_PROGRAM, { timeoutMs: 120000, maxBuffer: 1024 * 1024, ...(password ? { input: password } : {}) });
      if (password) guard.note(spark, false);
      const message = String(out || "").split("\n").filter(Boolean).pop() || "Shutdown helper installed";
      res.json({ success: true, message });
    } catch (err) {
      const message = String(err.message || err).replaceAll(password || "\0", "[redacted]");
      if (password && message.includes("sudo password was rejected")) guard.note(spark, true);
      res.status(502).json({ error: `shutdown helper installation failed: ${message.slice(0, 1600)}` });
    } finally {
      running.delete(spark.id);
    }
  });
}
