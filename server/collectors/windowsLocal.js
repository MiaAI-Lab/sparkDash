/**
 * WINDOWS-ARM64-PORT — native PowerShell probes for the dashboard's own host.
 *
 * Upstream sparkDash only used WINDOWS_GPU_SCRIPT / WINDOWS_SYSTEM_SCRIPT over
 * SSH (a remote "Windows PC with an NVIDIA GPU" unit). On a Windows 11 ARM64
 * dashboard host there is no /proc, no /sys and no POSIX shell, so the local
 * Linux collectors cannot work. This module runs those same, already-tested
 * PowerShell scripts directly on the local machine, with the same output
 * contract, so every existing parser stays untouched.
 *
 * -EncodedCommand (base64 of UTF-16LE) avoids all quoting problems and keeps
 * the command line short. We invoke powershell.exe directly (not through
 * cmd.exe), so the 8191-character cmd.exe limit does not apply here.
 * Windows PowerShell 5.1 ships with Windows 11 ARM64 as a native binary;
 * SPARKDASH_POWERSHELL can point at pwsh.exe instead.
 */
import { execFile } from "node:child_process";

export const IS_WINDOWS_HOST = process.platform === "win32";

/** PowerShell used for local metric probes. */
export function resolvePowerShell() {
  return process.env.SPARKDASH_POWERSHELL || "powershell.exe";
}

/**
 * Run a PowerShell script locally and resolve with its stdout.
 * The scripts set [Console]::OutputEncoding to UTF-8 themselves.
 * @param {string} script
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export function runWindowsLocal(script, { timeoutMs = 15000 } = {}) {
  const encoded = Buffer.from(String(script), "utf16le").toString("base64");
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      resolvePowerShell(),
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || "").trim().slice(0, 300);
          return reject(new Error(detail ? `${err.message}: ${detail}` : err.message));
        }
        resolve(String(stdout ?? ""));
      }
    );
  });
}
