/**
 * WINDOWS-ARM64-PORT — helpers for running a *PowerShell* program on the
 * dashboard's own host.
 *
 * Upstream sparkDash ships every on-Spark program as POSIX bash
 * (`bash -c "$(printf %s '<b64>' | base64 -d)"`). That works on a remote
 * Linux/Mac unit reached over SSH, but a Windows 11 ARM64 host has no POSIX
 * shell, so the LOCAL unit runs its programs through powershell.exe instead.
 *
 * The output contract (base64 payload wrapped so no quoting layer can mangle
 * it) is identical to bash: the only difference is the interpreter.
 *
 * -EncodedCommand is base64 of UTF-16LE, exactly what powershell.exe -EncodedCommand
 * expects, and it avoids every quoting/encoding problem. We call powershell.exe
 * directly (not through cmd.exe). SPARKDASH_POWERSHELL can point at pwsh.exe.
 */
import { execFileSync } from "node:child_process";
import { IS_WINDOWS_HOST, resolvePowerShell } from "../collectors/windowsLocal.js";

/** True when the program runs natively on a Windows host (not a remote unit). */
export function isWindowsLocal(spark) {
  return Boolean(spark?.isLocal) && IS_WINDOWS_HOST;
}

/**
 * Build the argv for running a wrapped Windows program.
 * @param {{ shell: string, b64: string }} wrapped
 * @returns {string[]}
 */
export function windowsProgramArgs(wrapped) {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    wrapped.b64,
  ];
}

/**
 * Wrap a raw PowerShell program into a spawn-ready descriptor:
 * `{ shell: "powershell", file, args }` where `file` is powershell.exe and
 * `args` encodes the script as an -EncodedCommand (UTF-16LE base64).
 * @param {string} program
 * @returns {{ shell: string, b64: string, file: string, args: string[] }}
 */
export function wrapWindows(program) {
  return {
    shell: "powershell",
    b64: Buffer.from(String(program), "utf16le").toString("base64"),
    file: resolvePowerShell(),
    args: windowsProgramArgs({ b64: Buffer.from(String(program), "utf16le").toString("base64") }),
  };
}

/** Kill a Windows process tree (a process + its direct children). */
export function killProcessTree(pid) {
  if (!pid || pid <= 0) return;
  try {
    const kids = execFileSync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $c = Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" -ErrorAction SilentlyContinue; foreach ($k in $c) { try { Stop-Process -Id $k.ProcessId -Force } catch {} }; Stop-Process -Id ${pid} -Force }`,
      ],
      { windowsHide: true, timeout: 8000 }
    );
    return kids;
  } catch {
    try { process.kill(pid); } catch { /* gone */ }
  }
}

export { IS_WINDOWS_HOST, resolvePowerShell };
