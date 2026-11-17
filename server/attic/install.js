import { runProgram } from "../gpuclock/GpuClockManager.js";
import { parseSudoPassword } from "../gpuclock/commands.js";
import { passwordAllowed } from "../gpuclock/routes.js";
import { SudoPasswordGuard } from "../util/sudoPasswordGuard.js";

// Pinned release installer; it verifies the release artifact before installing it.
export const INSTALL_PROGRAM = `set -eu
PW=\${SPARKDASH_SUDO_PW-}
unset SPARKDASH_SUDO_PW
if systemctl is-active --quiet attic.service; then echo 'attic.service already active'; exit 0; fi
command -v curl >/dev/null || { echo 'curl is required on the Spark' >&2; exit 1; }
command -v sha256sum >/dev/null || { echo 'sha256sum is required on the Spark' >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --connect-timeout 15 --max-time 120 https://github.com/bertholomus/spark-attic/releases/download/v0.1.4/install.sh -o "$tmp/install.sh"
printf '%s  %s\\n' 67377118411069f6ba6b7cadd1c4a31f95c78dcc08029101ec67c281fff19dba "$tmp/install.sh" | sha256sum -c -
if [ "$(id -u)" = 0 ]; then
  as_root() { "$@"; }
elif [ -n "$PW" ]; then
  printf '%s\\n' "$PW" | sudo -S -p '' -v || { echo 'sudo password was rejected' >&2; exit 1; }
  as_root() { printf '%s\\n' "$PW" | sudo -S -p '' "$@"; }
else
  as_root() { sudo -n "$@"; }
fi
# Check the host before stopping any desktop session. The artifact-dependent
# display check happens in the installer after the display manager is stopped.
as_root bash "$tmp/install.sh" --check --plain 1>&2
if systemctl is-active --quiet display-manager.service; then
  as_root systemctl stop display-manager.service || { echo 'Could not stop the display manager' >&2; exit 1; }
fi
as_root bash "$tmp/install.sh" --plain 1>&2
systemctl is-active --quiet attic.service || { echo 'Installer completed but attic.service is not active' >&2; exit 1; }
`;

export function registerAtticInstallRoute(app, { registry, allowChange, rejectLimited, allowPlainPassword = () => false, run = runProgram }) {
  const guard = new SudoPasswordGuard();
  const running = new Set();
  app.get("/api/sparks/:id/attic/install", (req, res) => {
    if (!registry.getSpark(req.params.id)) return res.status(404).json({ error: "Spark not found" });
    res.json({ passwordAllowed: passwordAllowed(req, allowPlainPassword()), plainPasswordAllowed: allowPlainPassword() === true });
  });
  app.post("/api/sparks/:id/attic/install", async (req, res) => {
    if (!allowChange(req)) return rejectLimited(res, "Too many requests");
    if ((req.body?.confirm !== true || req.body?.stopDesktopConfirmed !== true)) return res.status(400).json({ error: "Installation and desktop-stop confirmation required" });
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (spark.kind === "host" || spark.kind === "mac" || ["windows", "darwin"].includes(spark.platform)) return res.status(400).json({ error: "spark-attic requires a Linux GB10 Spark" });
    if (!spark.atticMonitoring) return res.status(400).json({ error: "Enable spark-attic monitoring before installing" });
    let password;
    try { password = parseSudoPassword(req.body?.sudoPassword); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    if (password && !passwordAllowed(req, allowPlainPassword())) return res.status(400).json({ error: "A sudo password requires HTTPS, a local connection, or the plain HTTP password setting" });
    if (password && guard.lockedForSeconds(spark)) return res.status(429).json({ error: "Too many wrong sudo passwords; try again later" });
    if (running.has(spark.id)) return res.status(409).json({ error: "Installation already running" });
    running.add(spark.id);
    try {
      await run(spark, INSTALL_PROGRAM, { timeoutMs: 300000, maxBuffer: 1024 * 1024, ...(password ? { input: password } : {}) });
      if (password) guard.note(spark, false);
      res.json({ success: true });
    } catch (err) {
      const message = String(err.message || err).replaceAll(password || "\0", "[redacted]");
      if (password && message.includes("sudo password was rejected")) guard.note(spark, true);
      res.status(502).json({ error: `spark-attic installation failed: ${message.slice(0, 600)}` });
    } finally {
      running.delete(spark.id);
    }
  });
}
