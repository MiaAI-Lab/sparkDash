import { runProgram } from "../gpuclock/GpuClockManager.js";
import { AtticProbe } from "../collectors/AtticProbe.js";
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
curl -fsSL --connect-timeout 15 --max-time 120 https://github.com/bertholomus/spark-attic/releases/download/v0.1.6/install.sh -o "$tmp/install.sh"
printf '%s  %s\\n' 28a6fe8e4e028d4a9069bfb8a4036756e3ee2684cf0aa44e033dda8af628165b "$tmp/install.sh" | sha256sum -c -
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
if ! as_root bash "$tmp/install.sh" --check --plain >"$tmp/preflight-output" 2>&1; then
  sed -n '/^[[:space:]]*FAIL /,+1p' "$tmp/preflight-output" >&2
  tail -n 4 "$tmp/preflight-output" >&2
  exit 1
fi
if systemctl is-active --quiet display-manager.service; then
  as_root systemctl stop display-manager.service || { echo 'Could not stop the display manager' >&2; exit 1; }
fi
touch "$tmp/install-started"
if ! as_root bash "$tmp/install.sh" --plain >"$tmp/install-output" 2>&1; then
  report=$(as_root sh -c 'find /var/log/spark-attic -maxdepth 2 -name check-heap.json -newer "$1" -exec cat {} + 2>/dev/null' sh "$tmp/install-started" || true)
  if printf '%s' "$report" | grep -q CUDA_ERROR_OUT_OF_MEMORY; then
    echo 'Validation failed: CUDA_ERROR_OUT_OF_MEMORY. Stop or reduce GPU workloads and retry.' >&2
  elif printf '%s' "$report" | grep -q '"full":{"pass":false'; then
    size=$(printf '%s' "$report" | sed -n 's/.*"full":{"pass":false,"size":\\([0-9][0-9]*\\).*/\\1/p')
    case "$size" in
      ''|*[!0-9]*) echo 'Validation failed: the full carveout memory check failed. See the spark-attic validation report on the Spark.' >&2 ;;
      *)
        model=$(cat /sys/class/dmi/id/product_name 2>/dev/null || true)
        if [ "$model" = NVIDIA_DGX_Spark ] && [ "$size" -le 536870912 ]; then
          echo 'A Founders Edition DGX Spark has been detected. The display memory reserve is already disabled through BIOS.' >&2
        else
          echo "Validation failed: the full carveout memory check failed (available carveout: $((size / 1048576)) MiB). See the spark-attic validation report on the Spark." >&2
        fi ;;

    esac
  else
    echo 'spark-attic validation or installation failed; see the output below.' >&2
  fi
  tail -n 12 "$tmp/install-output" >&2
  exit 1
fi
systemctl is-active --quiet attic.service || { echo 'Installer completed but attic.service is not active' >&2; exit 1; }
`;

export function registerAtticInstallRoute(app, { registry, allowChange, rejectLimited, allowRead = () => true, allowPlainPassword = () => false, run = runProgram, probe = (spark) => new AtticProbe(spark).probe() }) {
  const guard = new SudoPasswordGuard();
  const running = new Set();
  app.get("/api/sparks/:id/attic/install", (req, res) => {
    if (!registry.getSpark(req.params.id)) return res.status(404).json({ error: "Spark not found" });
    res.json({ passwordAllowed: passwordAllowed(req, allowPlainPassword()), plainPasswordAllowed: allowPlainPassword() === true });
  });
  app.get("/api/sparks/:id/attic/status", async (req, res) => {
    if (!allowRead(req)) return rejectLimited(res, "Too many requests");
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (spark.kind === "host" || spark.kind === "mac" || ["windows", "darwin"].includes(spark.platform)) return res.json({ installed: null });
    try {
      const status = await probe(spark);
      res.json({ installed: status?.available ? status.atticd?.present ?? null : null });
    } catch {
      res.json({ installed: null });
    }
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
      res.status(502).json({ error: `spark-attic installation failed: ${message.slice(0, 1600)}` });
    } finally {
      running.delete(spark.id);
    }
  });
}
