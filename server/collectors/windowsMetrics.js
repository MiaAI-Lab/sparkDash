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

/**
 * nvidia-smi: per-GPU stats, memory, compute apps. Same queries the Linux
 * collector uses. On a machine without nvidia-smi installed (an AMD-iGPU Windows
 * host, e.g. a Strix Halo) the same sections are produced from the GPU Engine /
 * GPU Adapter Memory performance counters instead, so the parser needs no
 * Windows- or vendor-specific branch. An NVIDIA PC whose nvidia-smi is installed
 * but failing stays empty (a broken driver must not look like a working AMD GPU):
 *   - utilization: busiest engine per physical adapter, sampled 3× 300 ms apart
 *     (the counter is instantaneous and inference leaves idle gaps between
 *     kernels), clamped to 100 — AMD engines can report >100%;
 *   - memory: Dedicated + Shared adapter usage in MB, total from the driver's
 *     registry memory size (the BIOS carve-out on unified-memory iGPUs);
 *   - a final MemTotal/MemAvailable section feeds _getRemoteGpu's meminfo
 *     fallback (empty for NVIDIA, which reports its own memory.total).
 * Temperature/power stay empty: AMD does not publish them to Windows, and the
 * parser reads empty fields as null → 0.
 */
export const WINDOWS_GPU_SCRIPT = [
  ...PREAMBLE,
  "$s=(Get-Command nvidia-smi|Select-Object -First 1).Source",
  "if(-not $s){$p=\"$env:ProgramFiles\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe\";if(Test-Path $p){$s=$p}}",
  "$gpu=@();$mem=@();$apps=@();$names=@();$meminfo=@()",
  "if($s){",
  "  $gpu = & $s '--query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit,clocks.current.sm,clocks.max.sm,clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown,clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_power_cap,index,name,uuid' '--format=csv,noheader,nounits' 2>$null",
  "  $mem = & $s '--query-gpu=memory.used,memory.total' '--format=csv,noheader,nounits' 2>$null",
  "  $apps = & $s '--query-compute-apps=pid,process_name,used_gpu_memory,gpu_uuid' '--format=csv,noheader,nounits' 2>$null",
  "  $names = & $s '--query-gpu=name,driver_version' '--format=csv,noheader,nounits' 2>$null",
  "}",
  "if(-not $s){",
  "  $eng = 1..3 | % { gcim Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | ? { $_.UtilizationPercentage -gt 0 -and $_.Name -match '_phys_(\\d+)' } | % { [pscustomobject]@{P=[int]$Matches[1];U=[double]$_.UtilizationPercentage} }; sleep -m 300 }",
  "  $vc=@(gcim Win32_VideoController | ? { $_.Name -notmatch 'NVIDIA' })",
  "  $rs=@{}",
  "  gci 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' | % { $p=gp $_.PSPath; if($p -and $p.'HardwareInformation.qwMemorySize'){$rs[[string]$p.'DriverDesc']=[long]$p.'HardwareInformation.qwMemorySize'} }",
  "  $ad=@{}",
  "  gcim Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | ? { $_.Name -match '_phys_(\\d+)' } | % { $ad[[int]$Matches[1]]=$_ }",
  "  $gpu=@();$mem=@()",
  "  $bp=@($eng | group P)",
  "  $adapters = if($bp.Count -gt 0){$bp}else{@(@{Name=0})}",
  "  $i=0",
  "  foreach($g in $adapters){",
  "    $u=0",
  "    if($bp.Count -gt 0){ $u=[int](($g.Group | measure U -Maximum).Maximum); if($u -gt 100){$u=100} }",
  "    $name=if($i -lt $vc.Count -and $vc[$i].Name){$vc[$i].Name}else{\"GPU $i\"}",
  "    $tot=0; if($rs.ContainsKey($name)){$tot=[int]($rs[$name]/1MB)}",
  "    $used=0; $a=$ad[[int]$g.Name]; if($a){$used=[int](($a.DedicatedUsage+$a.SharedUsage)/1MB)}",
  "    $gpu+=\"0,$u,,0,0,0,,,,,0,$name\"; $mem+=\"$used,$tot\"; $i++",
  "  }",
  "  $apps=@()",
  "  $names=@($vc | % { \"$($_.Name),$($_.DriverVersion)\" })",
  "  $o=gcim Win32_OperatingSystem",
  "  if($o){ $meminfo=@(\"MemTotal: $([long]$o.TotalVisibleMemorySize) kB\",\"MemAvailable: $([long]$o.FreePhysicalMemory) kB\") }",
  "}",
  "$gpu; '---'; $mem; '---'; $apps; '---'; $names; '---'; $meminfo; '---'",
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
  "'---'",
  // Cumulative bytes per drive with the counter's own clock, so a cached run does not distort the rate.
  "Get-CimInstance Win32_PerfRawData_PerfDisk_LogicalDisk|?{$_.Name -match '^[A-Za-z]:$'}|%{@((Cl $_.Name),$_.DiskReadBytesPerSec,$_.DiskWriteBytesPerSec,$_.Timestamp_Sys100NS) -join $t}",
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
  const [mem = "", cpu = "", disks = "", route = "", nets = "", io = ""] = sections;

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

  // Cumulative read/write bytes per drive letter, with the sample time in ms.
  const diskIo = new Map();
  for (const line of io.split(/\r?\n/)) {
    const [name, read, written, stamp] = line.replace(/\r$/, "").split("\t");
    const r = num(read);
    const w = num(written);
    const t = num(stamp);
    if (name && r != null && w != null && t != null) diskIo.set(name.toUpperCase(), { readBytes: r, writtenBytes: w, atMs: t / 10_000 });
  }

  return {
    totalMB: totalKB != null ? Math.round(totalKB / 1024) : 0,
    availableMB: freeKB != null ? Math.round(freeKB / 1024) : 0,
    uptimeSec: uptime != null && uptime >= 0 ? Math.floor(uptime) : null,
    cpuLoad: load != null ? Math.min(100, Math.max(0, Math.round(load))) : null,
    cpuName: (cpuParts[1] || "").trim() || null,
    logicalCpus: num(cpuParts[2]),
    disks: diskRows,
    diskIo,
    defaultInterface: route.trim().split(/\r?\n/)[0]?.trim() || null,
    adapters,
  };
}

/** Split WINDOWS_GPU_SCRIPT output into the pieces the shared GPU parser expects. */
export function splitWindowsGpuOutput(output) {
  const sections = String(output ?? "").split(/^---\s*$/m).map((s) => s.trim());
  return { gpu: sections[0] || "", memory: sections[1] || "", apps: sections[2] || "", names: sections[3] || "", meminfo: sections[4] || "" };
}

/** Linux-shaped output for `_getRemoteGpu`, so the shared parser needs no Windows branch. */
export function windowsGpuAsLinuxOutput(output) {
  const { gpu, memory, apps, meminfo } = splitWindowsGpuOutput(output);
  return [gpu, "---", memory, "---", apps, "---", meminfo].join("\n");
}

/**
 * AMD iGPU / non-NVIDIA Windows boxes (Strix Halo etc.): nvidia-smi is absent
 * there, so WINDOWS_GPU_SCRIPT answers with empty sections. The repair here
 * reads the WDDM driver's \GPU Engine / \GPU Adapter Memory / \GPU Process
 * Memory perf counters instead and prints the SAME four ---delimited sections
 * (per-GPU line / vram MiB / per-process / name+driver), so the Linux-shaped
 * parser needs no Windows branch. Unavailable nvidia-smi fields are [N/A]
 * (temperature from a WMI thermal zone when exposed; per-process names are not
 * recoverable from counter instance names). With no \GPU* counters registered,
 * the probes yield nothing and the output is four empty sections — today's
 * no-GPU behavior, unchanged. Rationale also in SystemCollector._windowsGpuOutput.
 */
export const WINDOWS_AMD_GPU_SCRIPT = [
  ...PREAMBLE,
  "$ErrorActionPreference='SilentlyContinue'",
  // ── Section 1: utilization from the busiest GPU Engine instance ──
  "$e=@(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples",
  "$u=0",
  "if($e){$u=@($e|?{$_.InstanceName -match '^pid_' -and $_.InstanceName -match 'engtype_(3D|Compute|VideoDecode|VideoEncode)'}|%{$_.CookedValue})|Measure-Object -Maximum}",
  "$um=0; if($u -and $u.Maximum){$um=[math]::Min(100,[math]::Round($u.Maximum))}",
  // GPU temperature: WMI thermal zone (Kelvin*10) if the OEM driver exposes one.
  "$tz=@(Get-CimInstance -Namespace root\\wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue)",
  "$temp='[N/A]'; if($tz){$temp=[int](($tz[0].CurrentTemperature-2732)/10)}",
  "@($temp,$um,'[N/A]','[N/A]','[N/A]','[N/A]','Not Active','Not Active','Not Active','Not Active',0,'[N/A]','[N/A]') -join ', '",
  "'---'",
  // ── Section 2: adapter memory MiB, summed over physical adapters ──
  "$a=@(Get-Counter '\\GPU Adapter Memory(*)\\*' -ErrorAction SilentlyContinue).CounterSamples",
  "$du=0;$sh=0;$dl=0;$sl=0",
  "$x=@($a|?{$_.Path -match '(?i)\\\\dedicated usage$'}|%{$_.CookedValue/1MB})|Measure-Object -Sum; if($x.Sum){$du=$x.Sum}",
  "$x=@($a|?{$_.Path -match '(?i)\\\\shared usage$'}|%{$_.CookedValue/1MB})|Measure-Object -Sum; if($x.Sum){$sh=$x.Sum}",
  "$x=@($a|?{$_.Path -match '(?i)\\\\dedicated limit$'}|%{$_.CookedValue/1MB})|Measure-Object -Sum; if($x.Sum){$dl=$x.Sum}",
  "$x=@($a|?{$_.Path -match '(?i)\\\\shared limit$'}|%{$_.CookedValue/1MB})|Measure-Object -Sum; if($x.Sum){$sl=$x.Sum}",
  "$used=[math]::Round($du+$sh)",
  // Total: driver Limits when reported; else the PHYSICAL pool — Win32 total
  // physical is only the OS-visible slice because a BIOS UMA carve-out is hidden
  // from the OS (a 128GB Strix Halo with a 96GB carve reports ~32GB). Win32
  // sums the installed chips, which is the whole unified pool: the honest base
  // for a carved iGPU. Then OS-visible, then [N/A].
  "$tot=[math]::Round($dl+$sl)",
  "if($tot -le 0){$ph=(Get-CimInstance Win32_PhysicalMemory|Measure-Object Capacity -Sum).Sum; if($ph){$tot=[math]::Round($ph/1MB)}}",
  "if($tot -le 0){$os=@(Get-CimInstance Win32_OperatingSystem)[0].TotalVisibleMemorySize; if($os){$tot=[math]::Round($os/1KB)}}",
  "if($tot -le 0){$tot='[N/A]'}",
  "if(-not $a -or ($du -eq 0 -and $sh -eq 0 -and $dl -eq 0)){$used='[N/A]';$tot='[N/A]'}",
  "@($used,$tot) -join ', '",
  "'---'",
  // ── Section 3: per-process GPU memory from the Process Memory counters ──
  "$pm=@(Get-Counter '\\GPU Process Memory(*)\\*' -ErrorAction SilentlyContinue).CounterSamples",
  "$acc=@{}",
  "foreach($c in $pm){$n=$c.InstanceName; if($n -notmatch '^pid_(\\d+)_'){continue}",
  "$p=$Matches[1]",
  "if($c.Path -notmatch '(?i)\\\\(dedicated|shared) usage$'){continue}",
  "if(-not $acc[$p]){$acc[$p]=0}; $acc[$p]+=$c.CookedValue/1KB}",
  "foreach($p in ($acc.Keys|Sort-Object {[double]$acc[$_]} -Descending|Select-Object -First 20)){",
  "@($p,'[N/A]',[math]::Round($acc[$p]),'[N/A]') -join ', '}",
  "'---'",
  // ── Section 4: adapter name + driver version ──
  "$c=@(Get-CimInstance Win32_VideoController)",
  "if($c){$v=$c|?{$_.PNPDeviceID -match 'VEN_1002'}|Select -First 1; if(-not $v){$v=$c[0]}",
  "@((($v.Name -replace '[,\\r\\n\\t]',' ').Trim()),(($v.DriverVersion -replace '[,\\r\\n\\t]',' ').Trim())) -join ', '}",
  "exit 0",
].join("\n");

/**
 * Merge an AMD fallback answer into the nvidia-smi (empty) answer. Either side
 * may be empty; whichever produced non-empty sections wins per section — on
 * NVIDIA boxes AMD never runs (gated upstream) and on AMD boxes the NVIDIA
 * script gives four empty lines, so this is a straight hand-off in practice.
 */
export function mergeWindowsGpuOutputs(primary, fallback) {
  const p = String(primary ?? "").split(/^---\s*$/m).map((s) => s.trim());
  const f = String(fallback ?? "").split(/^---\s*$/m).map((s) => s.trim());
  const picked = [0, 1, 2, 3].map((i) => (p[i] ? p[i] : f[i] || ""));
  return picked.join("\n---\n");
}
