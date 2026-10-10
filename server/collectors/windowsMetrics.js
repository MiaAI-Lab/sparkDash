/**
 * Windows units (platform: "windows"): the SSH server hands every command to
 * cmd.exe or PowerShell, so the Linux shell pipelines (/proc, bash, grep) are
 * replaced with two small PowerShell scripts. Each prints plain sections
 * separated by "---" lines, which the parsers below turn into the same shapes
 * the Linux collectors return.
 *
 * Commands are sent as -EncodedCommand (base64 of UTF-16LE), so quoting is the
 * same under cmd.exe, PowerShell and WSL-less OpenSSH defaults. cmd.exe limits a
 * command line to 8191 characters, which keeps each script short (see test).
 */

const PREAMBLE = [
  "$ErrorActionPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
];

/** Wrap a script so it runs the same way under cmd.exe, PowerShell or any default shell. */
export function powershellCommand(script) {
  const encoded = Buffer.from(String(script), "utf16le").toString("base64");
  return `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

/** nvidia-smi: per-GPU stats, memory, compute apps. Same queries the Linux collector uses. */
export const WINDOWS_GPU_SCRIPT = [
  ...PREAMBLE,
  "$s=(Get-Command nvidia-smi|Select-Object -First 1).Source",
  "if(-not $s){$s=\"$env:ProgramFiles\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe\"}",
  "& $s '--query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit,clocks.current.sm,clocks.max.sm,clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown,clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_power_cap,index,name,uuid' '--format=csv,noheader,nounits' 2>$null",
  "'---'",
  "& $s '--query-gpu=memory.used,memory.total' '--format=csv,noheader,nounits' 2>$null",
  "'---'",
  "& $s '--query-compute-apps=pid,process_name,used_gpu_memory,gpu_uuid' '--format=csv,noheader,nounits' 2>$null",
  "'---'",
  "& $s '--query-gpu=name,driver_version' '--format=csv,noheader,nounits' 2>$null",
  // A failed native command must not make powershell exit 1 (sshExec treats that as a dead host).
  "exit 0",
].join("\n");

/**
 * Memory, uptime, CPU load, disks and network adapters in one round trip.
 * Fields are joined with a TAB (a volume label or adapter name may contain `|`);
 * `-join` stringifies with the invariant culture, unlike `-f`, so a decimal
 * never turns into `12,5`. Statistics and addresses are fetched once, not per adapter.
 */
export const WINDOWS_SYSTEM_SCRIPT = [
  ...PREAMBLE,
  "$t=[char]9",
  "function Cl($v){([string]$v) -replace '[\t\r\n]',' '}",
  "$o=Get-CimInstance Win32_OperatingSystem",
  "@($o.TotalVisibleMemorySize,$o.FreePhysicalMemory,[int]((Get-Date)-$o.LastBootUpTime).TotalSeconds) -join $t",
  "'---'",
  "$p=@(Get-CimInstance Win32_Processor)",
  "@(($p|Measure-Object LoadPercentage -Average).Average,(Cl $p[0].Name),($p|Measure-Object NumberOfLogicalProcessors -Sum).Sum) -join $t",
  "'---'",
  "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|%{@((Cl $_.DeviceID),(Cl $_.VolumeName),$_.Size,$_.FreeSpace) -join $t}",
  "'---'",
  "(Get-NetRoute -DestinationPrefix '0.0.0.0/0'|Sort-Object RouteMetric|Select-Object -First 1).InterfaceAlias",
  "'---'",
  "$st=@{};Get-NetAdapterStatistics|%{$st[$_.Name]=$_}",
  "$ip=@{};Get-NetIPAddress -AddressFamily IPv4|%{if(-not $ip[$_.InterfaceIndex]){$ip[$_.InterfaceIndex]=$_.IPAddress}}",
  "Get-NetAdapter|%{@((Cl $_.Name),$_.Status,$_.ReceiveLinkSpeed,$st[$_.Name].ReceivedBytes,$st[$_.Name].SentBytes,$ip[$_.ifIndex],$_.Virtual) -join $t}",
  "exit 0",
].join("\n");

const num = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {string} output  WINDOWS_SYSTEM_SCRIPT output
 */
export function parseWindowsSystem(output) {
  const sections = String(output ?? "").split(/^---\s*$/m).map((s) => s.trim());
  const [mem = "", cpu = "", disks = "", route = "", nets = ""] = sections;

  const [totalKB, freeKB, uptime] = mem.split("\t").map(num);
  const cpuParts = cpu.split("\t");
  const load = num(cpuParts[0]);

  const diskRows = [];
  for (const line of disks.split(/\r?\n/)) {
    const [id, label, size, free] = line.replace(/\r$/, "").split("\t");
    const total = num(size);
    const avail = num(free);
    if (!id || total == null || total <= 0 || avail == null) continue;
    diskRows.push({ id, label: label || "", totalBytes: total, freeBytes: avail });
  }

  const adapters = [];
  for (const line of nets.split(/\r?\n/)) {
    const p = line.replace(/\r$/, "").split("\t");
    if (p.length < 7 || !p[0]) continue;
    adapters.push({
      name: p[0],
      status: p[1],
      linkBps: num(p[2]),
      rxBytes: num(p[3]),
      txBytes: num(p[4]),
      ip: p[5] || null,
      virtual: /^true$/i.test(p[6]),
    });
  }

  return {
    totalMB: totalKB != null ? Math.round(totalKB / 1024) : 0,
    availableMB: freeKB != null ? Math.round(freeKB / 1024) : 0,
    uptimeSec: uptime != null && uptime >= 0 ? Math.floor(uptime) : null,
    cpuLoad: load != null ? Math.min(100, Math.max(0, Math.round(load))) : null,
    cpuName: (cpuParts[1] || "").trim() || null,
    logicalCpus: num(cpuParts[2]),
    disks: diskRows,
    defaultInterface: route.trim().split(/\r?\n/)[0]?.trim() || null,
    adapters,
  };
}

/** Split WINDOWS_GPU_SCRIPT output into the pieces the shared GPU parser expects. */
export function splitWindowsGpuOutput(output) {
  const sections = String(output ?? "").split(/^---\s*$/m).map((s) => s.trim());
  return { gpu: sections[0] || "", memory: sections[1] || "", apps: sections[2] || "", names: sections[3] || "" };
}

/** Linux-shaped output for `_getRemoteGpu`, so the shared parser needs no Windows branch. */
export function windowsGpuAsLinuxOutput(output) {
  const { gpu, memory, apps } = splitWindowsGpuOutput(output);
  return [gpu, "---", memory, "---", apps, "---", ""].join("\n");
}
